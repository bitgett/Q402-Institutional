/**
 * ccip-bridge-runner.ts — shared bridge executor.
 *
 * Both `/api/ccip/send` (owner EIP-712 intent-bound auth) and
 * `/api/wallet/agentic/bridge` (Mode C API-key auth) call into this
 * function once their auth lifts. Everything from subscription gate
 * onwards is identical: idempotency claim, per-(owner, src) lock,
 * Agent Wallet lookup + PK decrypt, CCIP quote + fee cap, Gas Tank
 * gate, auto-fund + reconciliation, EIP-7702 delegation gate,
 * executeBridge, debit, history, response shape.
 *
 * Keeping the implementation in one place is the whole point — the
 * money-flow invariants (auto-fund debited before bridge call,
 * orphan-fund breadcrumb, atomic claim+debit) are NOT something we
 * want maintained twice.
 *
 * The runner returns a NextResponse so callers can pass it through
 * untouched. The runner OWNS the idempotency lifecycle — callers
 * must NOT wrap or re-claim the same fingerprint.
 */

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { kv } from "@vercel/kv";
import { getActiveAgenticWallet, decryptPrivateKey } from "@/app/lib/agentic-wallet";
import {
  CCIP_CONFIG,
  quoteBridgeFee,
  executeBridge,
  getCCIPProvider,
  type CCIPChainKey,
  type FeeTokenKind,
} from "@/app/lib/ccip";
import {
  getLinkBalance,
  getGasBalance,
  acquirePendingFundReconcileLock,
  claimAndDebitNativeBridge,
  claimAndDebitLinkBridge,
  recordOrphanFund,
  releasePendingFundReconcileLock,
  getPendingFund,
  setPendingFund,
  setPendingFeeDebit,
  clearPendingFund,
  markBridgeSettled,
  getBridgeSettled,
} from "@/app/lib/db";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { rateLimit } from "@/app/lib/ratelimit";
import { CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";

export interface BridgeHistoryRecord {
  messageId:    string;
  txHash:       string;
  blockNumber:  number;
  owner:        string;
  walletId:     string;
  src:          string;
  dst:          string;
  amount:       string;
  feeToken:     FeeTokenKind;
  feeRaw:       string;
  feeWhole:     number;
  initiatedAt:  number;
  approveTxHash?: string;
  agentFundTxHash?: string;
  agentFundEth?:   number;
}

interface BridgeSendRecord {
  status:        "processing" | "success" | "failed";
  startedAt:     number;
  finishedAt?:   number;
  sendId:        string;
  relayStatus?:  number;
  relayBody?:    Record<string, unknown>;
}

// Idempotency cache TTL.
//   - `processing` claim: 30 min (no change). Long enough to ride out
//     the longest-tail bridge (60s maxDuration × occasional KV retries).
//   - `success` cache: 24 h. Was 30 min; the audit caught that a
//     finaliseClaim KV write failure + a same-intent retry 31+ min
//     later could double-bridge. The settled-fp marker (no TTL) is
//     the permanent backstop; the 24h success cache keeps the RICH
//     response (messageId/explorer links) hot for typical replay
//     windows.
//   - `failed` cache: 60s (short — a transient 4xx shouldn't shadow-
//     lock a corrected retry). Set inside finaliseClaim itself.
const IDEMPOTENCY_TTL_PROCESSING_SEC = 30 * 60;
const IDEMPOTENCY_TTL_SUCCESS_SEC    = 24 * 60 * 60;

export function bridgeHistKey(owner: string): string {
  return `ccip_bridge:${owner.toLowerCase()}`;
}

export function messageIdMapKey(messageId: string): string {
  return `ccip_msg:${messageId.toLowerCase()}`;
}

/**
 * Per-(owner, walletId, src, dst, amount, feeToken) fingerprint. Two
 * runner invocations with the same intent share this fingerprint;
 * the second observes the first's claim and replays the response.
 */
export function bridgeFingerprint(
  owner: string,
  walletId: string,
  src: string,
  dst: string,
  amount: string,
  feeToken: string,
): string {
  const seed = [
    owner.toLowerCase(),
    walletId.toLowerCase(),
    src,
    dst,
    amount,
    feeToken,
  ].join("|");
  return ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(2, 18);
}

function bridgeClaimKey(fp: string): string {
  return `ccip_send:${fp}`;
}

/**
 * Per-(owner, src) concurrency lock. Two distinct-intent bridges
 * (e.g. eth→avax 5 USDC + eth→arbitrum 3 USDC fired in parallel)
 * would both pass the LINK balance check before either's
 * recordLinkUsage RMW landed → net overspend. 90s covers the
 * worst-case approve + bridge + KV wall time.
 */
function ccipLockKey(owner: string, src: string): string {
  return `ccip_lock:${owner.toLowerCase()}:${src}`;
}

export interface RunCCIPBridgeArgs {
  /** Owner EOA (lower-cased), the user who registered the Agent Wallet. */
  owner:           string;
  /** Lower-cased walletId of the user's active Agent Wallet on `src`. */
  walletId:        string;
  /** Source chain in the CCIP triangle. */
  src:             CCIPChainKey;
  /** Destination chain in the CCIP triangle (MUST differ from src). */
  dst:             CCIPChainKey;
  /** USDC amount in raw 6-decimal units (already validated as positive integer string). */
  amount:          string;
  /** Fee currency selector. */
  feeToken:        FeeTokenKind;
  /**
   * Optional client-supplied slippage cap (raw 18-dec). The runner clamps
   * this against its own 10% server-side ceiling — clients may LOWER the
   * cap but never RAISE it.
   */
  clientMaxFeeRaw?: bigint;
}

/**
 * Execute a CCIP bridge end-to-end on behalf of an already-authenticated
 * (owner, walletId) tuple. See module docstring for invariants.
 */
export async function runCCIPBridge(args: RunCCIPBridgeArgs): Promise<NextResponse> {
  const { owner, walletId, src, dst, feeToken } = args;
  const amount = args.amount;
  const amountRaw = BigInt(amount);

  // ── Settled-fingerprint marker (permanent backstop) ────────────────────
  // Before the regular idempotency claim, check the no-TTL settled
  // marker. If the previous identical-intent bridge succeeded on chain
  // but its finaliseClaim KV write failed (rare but real — the catch
  // path at the bottom of this function eats the throw to preserve
  // the success response), the regular 30-min/24-h claim cache may
  // be gone but the marker is forever. Without this check, a retry
  // after both TTLs expired could double-bridge.
  const fp = bridgeFingerprint(owner, walletId, src, dst, amount, feeToken);
  const settled = await getBridgeSettled(fp);
  if (settled) {
    return NextResponse.json(
      {
        success: true,
        idempotent: true,
        fromSettledMarker: true,
        messageId: settled.messageId,
        txHash: settled.txHash,
        src: settled.src,
        dst: settled.dst,
        amount: settled.amount,
        feeToken: settled.feeToken,
        settledAt: settled.settledAt,
        ccipExplorer: `https://ccip.chain.link/msg/${settled.messageId}`,
        note:
          "This bridge intent settled previously and is recorded in the " +
          "permanent settled-marker. The 30-min cache may have expired; " +
          "this response is the durable replay. To bridge again, vary the " +
          "amount or chain pair.",
      },
      { status: 200 },
    );
  }

  // ── Per-wallet bridge rate limit ────────────────────────────────────────
  //
  // Design call: bridge IGNORES dailyLimitUsd / perTxMaxUsd. The Agent
  // Wallet's caps were designed for "spending" (third-party recipient).
  // Bridge `destReceiver` is hard-bound to `wallet.address` server-side
  // — the user cannot pick a different receiver, so funds stay in the
  // SAME EOA they were already in, just on a different chain. Attacker
  // with a compromised key cannot redirect USDC anywhere it isn't
  // already going.
  //
  // BUT: attacker can still drain the Gas Tank LINK + native via
  // repeated bridges (each one pays CCIP fee + auto-fund tx gas).
  // This rate limit caps that exposure to 10 bridges/hour per
  // (walletId, src) lane. fail-OPEN: KV blip shouldn't shadow-lock
  // legitimate bridges; the lower-level idempotency claim still
  // prevents same-intent double-spend, so degraded KV is bounded.
  if (!(await rateLimit(`wallet:${walletId}:${src}`, "ccip-bridge-wallet", 10, 3600, /* failOpen */ true))) {
    return NextResponse.json(
      {
        error: "BRIDGE_RATE_LIMITED",
        message:
          "This Agent Wallet has fired more than 10 bridges on this source chain in the last hour. " +
          "Wait a bit and retry — this cap is per-(wallet, lane) and resets on a rolling window.",
      },
      { status: 429 },
    );
  }

  // ── Idempotency claim (per-intent) ──────────────────────────────────────
  const idempotencyKey = bridgeClaimKey(fp);
  const startedAt = Date.now();
  const sendId = ethers.hexlify(ethers.randomBytes(8)).slice(2);
  const initialClaim: BridgeSendRecord = { status: "processing", startedAt, sendId };
  const claimed = await kv.set(idempotencyKey, initialClaim, {
    nx: true,
    ex: IDEMPOTENCY_TTL_PROCESSING_SEC,
  });
  if (!claimed) {
    const live = await kv.get<BridgeSendRecord>(idempotencyKey);
    if (live) {
      const isProcessing = live.status === "processing";
      const httpStatus = live.relayStatus ?? (isProcessing ? 202 : 500);
      return NextResponse.json(
        {
          ...((live.relayBody as Record<string, unknown>) ?? {}),
          idempotent: true,
          ...(isProcessing ? { pending: true, retryAfterSec: 10 } : {}),
          status: live.status,
          startedAt: live.startedAt,
          finishedAt: live.finishedAt,
          sendId: live.sendId,
        },
        {
          status: httpStatus,
          ...(isProcessing ? { headers: { "Retry-After": "10" } } : {}),
        },
      );
    }
  }

  async function finaliseClaim(
    status: BridgeSendRecord["status"],
    relayStatus: number,
    relayBody: Record<string, unknown>,
  ): Promise<void> {
    const finishedAt = Date.now();
    const finalTtl = status === "success" ? IDEMPOTENCY_TTL_SUCCESS_SEC : 60;
    await kv.set(
      idempotencyKey,
      { status, startedAt, finishedAt, sendId, relayStatus, relayBody },
      { ex: finalTtl },
    );
  }

  // ── Per-(owner, src) concurrency lock ───────────────────────────────────
  const lockKey = ccipLockKey(owner, src);
  const lockAcquired = await kv.set(lockKey, sendId, { nx: true, ex: 90 });
  if (!lockAcquired) {
    const body: Record<string, unknown> = {
      error: "CCIP_BRIDGE_BUSY",
      message: "Another bridge is in flight on this source chain. Retry in ~30s.",
    };
    await finaliseClaim("failed", 409, body);
    return NextResponse.json(body, { status: 409, headers: { "Retry-After": "30" } });
  }
  const releaseLock = async (): Promise<void> => {
    try {
      const held = await kv.get<string>(lockKey);
      if (held === sendId) await kv.del(lockKey);
    } catch { /* lock TTL handles cleanup */ }
  };

  try {
    // ── Wallet lookup + decrypt ─────────────────────────────────────────
    const wallet = await getActiveAgenticWallet(owner, walletId);
    if (!wallet) {
      const body: Record<string, unknown> = { error: "AGENTIC_WALLET_NOT_FOUND" };
      await finaliseClaim("failed", 404, body);
      return NextResponse.json(body, { status: 404 });
    }
    const agenticWalletKey = decryptPrivateKey(wallet);
    const destReceiver = wallet.address; // same EOA across chains

    // ── Quote + fee guard ───────────────────────────────────────────────
    let feeRaw: bigint;
    try {
      const q = await quoteBridgeFee(src, dst, amountRaw, destReceiver);
      feeRaw = feeToken === "LINK" ? q.link : q.native;
    } catch (e) {
      const body: Record<string, unknown> = {
        error: "CCIP_QUOTE_FAILED",
        detail: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      };
      await finaliseClaim("failed", 502, body);
      return NextResponse.json(body, { status: 502 });
    }

    // Server-side 10% slippage ceiling. Client may LOWER, never RAISE.
    const serverCap = (feeRaw * 11n) / 10n;
    const clientCap = args.clientMaxFeeRaw ?? serverCap;
    const maxFeeRaw = clientCap < serverCap ? clientCap : serverCap;
    if (feeRaw > maxFeeRaw) {
      const body: Record<string, unknown> = {
        error: "FEE_EXCEEDS_MAX",
        feeRaw: feeRaw.toString(),
        maxFeeRaw: maxFeeRaw.toString(),
      };
      await finaliseClaim("failed", 400, body);
      return NextResponse.json(body, { status: 400 });
    }

    // ── Gas Tank balance check (KV) ─────────────────────────────────────
    const feeWhole = Number(feeRaw) / 1e18;
    if (feeToken === "LINK") {
      const linkBal = await getLinkBalance(owner);
      if ((linkBal[src] ?? 0) < feeWhole) {
        const body: Record<string, unknown> = {
          error: "INSUFFICIENT_LINK_BALANCE",
          required: feeWhole,
          available: linkBal[src] ?? 0,
          chain: src,
          // Point at the dashboard's Gas Tank deposit flow rather than
          // any specific address. The canonical deposit sink is
          // GASTANK_ADDRESS (0x10fb…747a), NOT the facilitator
          // (RELAYER_ADDRESS) — the previous copy could send users
          // to the wrong address and lose their LINK.
          deposit: `Top up LINK on ${src} via the dashboard Bridge Gas Tank flow (https://q402.quackai.ai/dashboard → Agent → Bridge Gas Tank).`,
        };
        await finaliseClaim("failed", 402, body);
        return NextResponse.json(body, { status: 402 });
      }
    } else {
      const nativeBal = await getGasBalance(owner);
      if ((nativeBal[src] ?? 0) < feeWhole) {
        const body: Record<string, unknown> = {
          error: "INSUFFICIENT_NATIVE_BALANCE",
          required: feeWhole,
          available: nativeBal[src] ?? 0,
          chain: src,
        };
        await finaliseClaim("failed", 402, body);
        return NextResponse.json(body, { status: 402 });
      }
    }

    // ── Auto-fund Agent Wallet source-chain gas from the Gas Tank ──────
    let agentFundEth = 0;
    let agentFundTxHash: string | undefined;
    const FUND_GAS_LIMIT = 21_000n;
    const FUND_TX_WAIT_MS = 25_000;
    try {
      const probeProvider = getCCIPProvider(src);

      // ── Reconcile a pending fund tx from a previous attempt ────────
      const pending = await getPendingFund(owner, src);
      if (pending) {
        // Cross-intent drift guard.
        if (!pending.intentFp || pending.intentFp !== fp) {
          const body: Record<string, unknown> = {
            error:    "AGENT_WALLET_AUTOFUND_PENDING",
            fundTx:   pending.txHash,
            message:
              "A previous auto-fund tx for a different bridge intent is still settling. " +
              "Wait ~5 min for it to reconcile (or use the previous src/dst/amount), then retry.",
          };
          await finaliseClaim("failed", 503, body);
          return NextResponse.json(body, { status: 503, headers: { "Retry-After": "300" } });
        }
        // CAS lock against the cron reconciler.
        const reconcileLockToken = await acquirePendingFundReconcileLock(owner, src);
        if (!reconcileLockToken) {
          const body: Record<string, unknown> = {
            error:    "AGENT_WALLET_AUTOFUND_PENDING",
            fundTx:   pending.txHash,
            message:
              "Q402's reconciliation cron is already settling your previous auto-fund tx. " +
              "Retry in ~30s.",
          };
          await finaliseClaim("failed", 503, body);
          return NextResponse.json(body, { status: 503, headers: { "Retry-After": "30" } });
        }
        try {
          const reconciledReceipt = await probeProvider
            .getTransactionReceipt(pending.txHash)
            .catch(() => null);
          if (!reconciledReceipt) {
            const body: Record<string, unknown> = {
              error:    "AGENT_WALLET_AUTOFUND_PENDING",
              fundTx:   pending.txHash,
              message:
                "Your previous auto-fund tx is still mining. Retry in ~30s — " +
                "Q402 will reconcile and complete the bridge from the existing tx.",
            };
            await finaliseClaim("failed", 503, body);
            return NextResponse.json(body, { status: 503, headers: { "Retry-After": "30" } });
          }
          if (reconciledReceipt.status === 1) {
            const recGasUsed   = reconciledReceipt.gasUsed ?? 0n;
            const recGasPrice  = reconciledReceipt.gasPrice ?? 0n;
            const recGasWei    = recGasUsed * recGasPrice;
            const recFundWei   = BigInt(pending.fundDeltaWei);
            const recDebitEth  = Number(recFundWei + recGasWei) / 1e18;
            try {
              await claimAndDebitNativeBridge(pending.txHash, owner, src, recDebitEth);
              await clearPendingFund(owner, src);
              agentFundEth     = recDebitEth;
              agentFundTxHash  = pending.txHash;
            } catch (recErr) {
              const err = recErr instanceof Error ? recErr.message : String(recErr);
              void sendOpsAlert(
                `<b>🚨 CCIP pending-fund reconciliation debit FAILED</b>\n\n` +
                `Owner: <code>${owner}</code>\n` +
                `Chain: ${src}\n` +
                `Pending fund tx: <code>${pending.txHash}</code>\n` +
                `Debit attempted: ${recDebitEth.toFixed(6)} native\n` +
                `Error: ${err.slice(0, 200)}\n\n` +
                `KV row stays — cron will retry. Manual debit also OK from ` +
                `bridge_native_used:${owner.toLowerCase()}.${src}.`,
                "error",
              ).catch(() => { /* best-effort */ });
              const body: Record<string, unknown> = {
                error:  "AUTOFUND_DEBIT_FAILED",
                detail: err.slice(0, 200),
                message:
                  "Your previous auto-fund tx confirmed but Q402's ledger couldn't record the debit. " +
                  "Ops has been paged; your retry won't be charged twice. Try again in a moment.",
              };
              await finaliseClaim("failed", 500, body);
              return NextResponse.json(body, { status: 500 });
            }
          } else {
            // Reverted — clear and continue.
            await clearPendingFund(owner, src);
          }
        } finally {
          await releasePendingFundReconcileLock(owner, src, reconcileLockToken);
        }
      }

      // ── EIP-7702 delegation gate ───────────────────────────────────
      const agentCode = await probeProvider.getCode(destReceiver).catch(() => "0x");
      if (agentCode !== "0x" && agentCode.toLowerCase().startsWith("0xef0100")) {
        const delegateTarget = "0x" + agentCode.slice(8, 48);
        const body: Record<string, unknown> = {
          error:           "AGENT_WALLET_DELEGATED",
          chain:           src,
          address:         destReceiver,
          delegateTarget,
          message:
            "Your Agent Wallet is EIP-7702 delegated to the Q402 payment contract on " +
            `${src}, which doesn't accept native transfers. Clear the delegation first ` +
            `(q402_clear_delegation MCP tool, or the Agent Wallet → Clear delegation ` +
            `button on the dashboard) and retry the bridge. Note: a follow-up Q402 send ` +
            `will re-delegate the wallet, so prefer bridging before the next /send.`,
        };
        await finaliseClaim("failed", 409, body);
        return NextResponse.json(body, { status: 409 });
      }

      const [agentEth, feeData, latestBlock] = await Promise.all([
        probeProvider.getBalance(destReceiver),
        probeProvider.getFeeData(),
        probeProvider.getBlock("latest"),
      ]);

      // ── Approve detection ─────────────────────────────────────────
      const usdcAddr = CHAIN_CONFIG[src as ChainKey].usdc.address;
      const senderAddr = CCIP_CONFIG[src].sender;
      const ALLOWANCE_SELECTOR = "0xdd62ed3e";
      const allowanceCall =
        ALLOWANCE_SELECTOR +
        destReceiver.replace(/^0x/, "").toLowerCase().padStart(64, "0") +
        senderAddr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      let needsApprove = true;
      try {
        const allowanceHex = await probeProvider.call({ to: usdcAddr, data: allowanceCall });
        const allowance = BigInt(allowanceHex);
        needsApprove = allowance < amountRaw;
      } catch {
        // Allowance probe failed — assume approve needed.
      }

      // ── Fee estimate ──────────────────────────────────────────────
      const baseFee = latestBlock?.baseFeePerGas ?? 0n;
      const tipFee  = feeData.maxPriorityFeePerGas
        ?? ethers.parseUnits("0.2", "gwei");
      const submitMaxFeePerGas = baseFee > 0n
        ? (baseFee * 15n) / 10n + tipFee
        : (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n);
      const gasNeeded = needsApprove ? 380_000n : 320_000n;
      const gasCeilingWei = submitMaxFeePerGas * gasNeeded;
      const feeShortfallWei = feeToken === "native" ? feeRaw : 0n;
      const agentEthThreshold = gasCeilingWei + feeShortfallWei;
      if (agentEth < agentEthThreshold) {
        const fundDeltaWei = ((agentEthThreshold - agentEth) * 11n) / 10n;
        const fundDeltaEth = Number(fundDeltaWei) / 1e18;
        const fundGasMaxWei = submitMaxFeePerGas * FUND_GAS_LIMIT;
        const fundGasMaxEth = Number(fundGasMaxWei) / 1e18;

        // ── Gate 1: user Gas Tank covers everything ─────────────────
        const gasBal = await getGasBalance(owner);
        const tankAvailEth = gasBal[src] ?? 0;
        const ccipFeeInTank = feeToken === "native" ? feeWhole : 0;
        const totalNeed = fundDeltaEth + fundGasMaxEth + ccipFeeInTank;
        if (tankAvailEth < totalNeed) {
          const body: Record<string, unknown> = {
            error:        "INSUFFICIENT_NATIVE_BALANCE",
            chain:        src,
            requiredEth:  totalNeed,
            availableEth: tankAvailEth,
            message:
              `Your Gas Tank native on ${src} is short ${(totalNeed - tankAvailEth).toFixed(5)} ` +
              `to cover the bridge (source-chain gas + auto-fund tx gas${ccipFeeInTank > 0 ? " + CCIP fee" : ""}). ` +
              `Top up the Gas Tank and retry — Q402 funds the Agent Wallet automatically from there.`,
          };
          await finaliseClaim("failed", 402, body);
          return NextResponse.json(body, { status: 402 });
        }

        // ── Gate 2: relayer has on-chain native ─────────────────────
        const relayerKey = loadRelayerKey();
        if (!relayerKey.ok) {
          const body: Record<string, unknown> = {
            error:   "RELAYER_LOW",
            message: `Q402 relay infrastructure on ${src} is refilling. Try again in a few minutes.`,
          };
          await finaliseClaim("failed", 503, body);
          return NextResponse.json(body, { status: 503 });
        }
        const relayerEth = await probeProvider.getBalance(relayerKey.address);
        const relayerMinRequired = fundDeltaWei + fundGasMaxWei + (fundGasMaxWei / 2n);
        if (relayerEth < relayerMinRequired) {
          void sendOpsAlert(
            `<b>⚠ Relayer balance pre-check failed in CCIP send</b>\n\n` +
            `Chain: ${src}\n` +
            `Relayer: <code>${relayerKey.address}</code>\n` +
            `Balance: ${(Number(relayerEth) / 1e18).toFixed(6)} ETH\n` +
            `Need: ${(Number(relayerMinRequired) / 1e18).toFixed(6)} ETH\n` +
            `Top up the relayer hot wallet.`,
            "error",
          ).catch(() => { /* best-effort */ });
          const body: Record<string, unknown> = {
            error:   "RELAYER_LOW",
            message: `Q402 relay infrastructure on ${src} is refilling. Try again in a few minutes.`,
          };
          await finaliseClaim("failed", 503, body);
          return NextResponse.json(body, { status: 503 });
        }

        // ── Submit funding tx ──────────────────────────────────────
        const relayerWallet = new ethers.Wallet(relayerKey.privateKey, probeProvider);
        const fundTx = await relayerWallet.sendTransaction({
          to:       destReceiver,
          value:    fundDeltaWei,
          gasLimit: FUND_GAS_LIMIT,
        });

        // Write the pending KV record IMMEDIATELY after broadcast.
        const pendingRecord = {
          txHash:       fundTx.hash,
          fundDeltaWei: fundDeltaWei.toString(),
          submittedAt:  Date.now(),
          intentFp:     fp,
          ownerLc:      owner,
          chain:        src,
        };
        let pendingWritten = false;
        for (let attempt = 0; attempt < 3 && !pendingWritten; attempt++) {
          try {
            await setPendingFund(pendingRecord);
            pendingWritten = true;
          } catch (e) {
            console.error("[ccip-bridge-runner] setPendingFund attempt failed", {
              attempt, owner, src, txHash: fundTx.hash,
              err: e instanceof Error ? e.message : String(e),
            });
            if (attempt < 2) await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          }
        }
        if (!pendingWritten) {
          const orphanWritten = await recordOrphanFund({
            txHash:       fundTx.hash,
            fundDeltaWei: fundDeltaWei.toString(),
            submittedAt:  pendingRecord.submittedAt,
            intentFp:     fp,
            ownerLc:      owner,
            chain:        src,
            reason:       "setPendingFund 3x retry exhausted after broadcast",
          });
          if (orphanWritten) {
            void sendOpsAlert(
              `<b>🚨 CCIP setPendingFund FAILED after 3 retries — orphan row written</b>\n\n` +
              `Owner: <code>${owner}</code>\n` +
              `Chain: ${src}\n` +
              `Fund txHash: <code>${fundTx.hash}</code>\n` +
              `Amount: ${fundDeltaEth.toFixed(6)} native (fundDeltaWei=${fundDeltaWei.toString()})\n` +
              `Intent fingerprint: ${fp}\n` +
              `SubmittedAt: ${pendingRecord.submittedAt}\n\n` +
              `Reconcile cron's orphan pass will credit the debit on the next tick ` +
              `(orphan key: <code>ccip_orphan_fund:${fundTx.hash.toLowerCase()}</code>).`,
              "error",
            ).catch(() => { /* best-effort */ });
          } else {
            console.error("[ccip-bridge-runner] CRITICAL: pending AND orphan writes both failed", {
              owner, src, txHash: fundTx.hash,
              fundDeltaWei: fundDeltaWei.toString(),
              intentFp: fp,
              submittedAt: pendingRecord.submittedAt,
            });
            void sendOpsAlert(
              `<b>🆘 CCIP fund tx on-chain but NO durable record (pending + orphan both failed)</b>\n\n` +
              `Owner: <code>${owner}</code>\n` +
              `Chain: ${src}\n` +
              `Fund txHash: <code>${fundTx.hash}</code>\n` +
              `Amount: ${fundDeltaEth.toFixed(6)} native (fundDeltaWei=${fundDeltaWei.toString()})\n` +
              `Intent fp: ${fp} · SubmittedAt: ${pendingRecord.submittedAt}\n\n` +
              `IMMEDIATE MANUAL ACTION REQUIRED — KV is severely degraded. Once KV ` +
              `recovers, manually claim+debit: SET bridge_debit_claim:${fundTx.hash.toLowerCase()} ` +
              `"${owner.toLowerCase()}:${src}" NX EX 86400, then INCRBYFLOAT ` +
              `bridge_native_used:${owner.toLowerCase()}.${src} by the actual cost ` +
              `(gasUsed×gasPrice + value).`,
              "error",
            ).catch(() => { /* best-effort */ });
          }
        }

        // ── Wait with timeout ──────────────────────────────────────
        let fundReceipt: Awaited<ReturnType<typeof fundTx.wait>>;
        try {
          fundReceipt = await Promise.race([
            fundTx.wait(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("FUND_WAIT_TIMEOUT")), FUND_TX_WAIT_MS),
            ),
          ]);
        } catch (waitErr) {
          const timedOut = waitErr instanceof Error && waitErr.message === "FUND_WAIT_TIMEOUT";
          void sendOpsAlert(
            `<b>⚠ CCIP auto-fund wait ${timedOut ? "timed out" : "errored"} — pending KV row retained for reconciliation</b>\n\n` +
            `Owner: <code>${owner}</code>\n` +
            `Chain: ${src}\n` +
            `Agent Wallet: <code>${destReceiver}</code>\n` +
            `Fund txHash: <code>${fundTx.hash}</code>\n` +
            `Amount: ${fundDeltaEth.toFixed(5)} native\n` +
            `Error: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}\n\n` +
            `Reconciliation will fire on the user's next bridge attempt OR the next ` +
            `cron tick — relayer ETH is no longer at risk of leaking.`,
            "warn",
          ).catch(() => { /* best-effort */ });
          const body: Record<string, unknown> = {
            error:    "AGENT_WALLET_AUTOFUND_PENDING",
            fundTx:   fundTx.hash,
            message:
              timedOut
                ? "Auto-fund tx is mining. Retry in ~30s — Q402 will reconcile from the existing tx and complete the bridge."
                : "Auto-fund tx submitted but receipt couldn't be fetched. Retry in ~30s — Q402 will reconcile from the existing tx.",
          };
          await finaliseClaim("failed", 503, body);
          return NextResponse.json(body, { status: 503, headers: { "Retry-After": "30" } });
        }

        if (!fundReceipt) {
          void sendOpsAlert(
            `<b>⚠ CCIP auto-fund tx submitted but receipt null — pending KV row retained</b>\n\n` +
            `Owner: <code>${owner}</code>\n` +
            `Chain: ${src}\n` +
            `Fund txHash: <code>${fundTx.hash}</code>\n` +
            `Amount: ${fundDeltaEth.toFixed(5)} native`,
            "warn",
          ).catch(() => { /* best-effort */ });
          const body: Record<string, unknown> = {
            error:   "AGENT_WALLET_AUTOFUND_PENDING",
            fundTx:  fundTx.hash,
            message: "Auto-fund tx is pending on chain. Try again in ~30s — Q402 will reconcile from the existing tx.",
          };
          await finaliseClaim("failed", 503, body);
          return NextResponse.json(body, { status: 503, headers: { "Retry-After": "30" } });
        }

        if (fundReceipt.status !== 1) {
          await clearPendingFund(owner, src).catch(() => { /* TTL will sweep */ });
          void sendOpsAlert(
            `<b>⚠ CCIP auto-fund tx mined but reverted</b>\n\n` +
            `Owner: <code>${owner}</code>\n` +
            `Chain: ${src}\n` +
            `Fund txHash: <code>${fundTx.hash}</code>`,
            "error",
          ).catch(() => { /* best-effort */ });
          const body: Record<string, unknown> = {
            error:  "AGENT_WALLET_AUTOFUND_FAILED",
            detail: "fund_tx_reverted",
            message: "Auto-fund tx mined but reverted on chain. Retry in a moment.",
          };
          await finaliseClaim("failed", 502, body);
          return NextResponse.json(body, { status: 502 });
        }

        // ── DEBIT IMMEDIATELY ───────────────────────────────────────
        const actualFundGasUsed   = fundReceipt.gasUsed ?? 0n;
        const actualFundGasPrice  = fundReceipt.gasPrice ?? submitMaxFeePerGas;
        const actualFundGasWei    = actualFundGasUsed * actualFundGasPrice;
        const actualFundGasEth    = Number(actualFundGasWei) / 1e18;
        const debitEth            = fundDeltaEth + actualFundGasEth;
        try {
          await claimAndDebitNativeBridge(fundTx.hash, owner, src, debitEth);
          await clearPendingFund(owner, src).catch(() => { /* TTL will sweep */ });
        } catch (debitErr) {
          const err = debitErr instanceof Error ? debitErr.message : String(debitErr);
          void sendOpsAlert(
            `<b>🚨 CCIP auto-fund debit FAILED (pending KV row retained for retry)</b>\n\n` +
            `Owner: <code>${owner}</code>\n` +
            `Chain: ${src}\n` +
            `Agent Wallet: <code>${destReceiver}</code>\n` +
            `Fund txHash: <code>${fundTx.hash}</code>\n` +
            `Amount: ${fundDeltaEth.toFixed(6)} + ${actualFundGasEth.toFixed(6)} gas\n` +
            `Debit error: ${err.slice(0, 200)}\n\n` +
            `Cron will retry the debit. Manual fix: INCRBYFLOAT ${debitEth.toFixed(6)} ` +
            `on bridge_native_used:${owner.toLowerCase()}.${src} + DEL ` +
            `ccip_pending_fund:${owner.toLowerCase()}:${src}.`,
            "error",
          ).catch(() => { /* best-effort */ });
          const body: Record<string, unknown> = {
            error:  "AUTOFUND_DEBIT_FAILED",
            detail: err.slice(0, 200),
            message:
              "Your auto-fund went through on chain, but Q402's ledger hiccuped recording it. " +
              "Ops has been paged and Q402 will reconcile automatically — retry in a minute and you " +
              "won't be charged twice.",
          };
          await finaliseClaim("failed", 500, body);
          return NextResponse.json(body, { status: 500 });
        }

        agentFundEth = debitEth;
        agentFundTxHash = fundTx.hash;
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const errName = e instanceof Error ? e.constructor.name : "Error";
      console.error("[ccip-bridge-runner] auto-fund pre-broadcast threw — failing closed", {
        owner, src, errName, err,
      });
      void sendOpsAlert(
        `<b>⚠ CCIP auto-fund pre-broadcast threw</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `Chain: ${src}\n` +
        `Agent Wallet: <code>${wallet.address}</code>\n` +
        `Error class: ${errName}\n` +
        `Error: ${err.slice(0, 300)}`,
        "error",
      ).catch(() => { /* best-effort */ });
      const body: Record<string, unknown> = {
        error:   "AGENT_WALLET_AUTOFUND_FAILED",
        detail:  err.slice(0, 200),
        message:
          "Q402's auto-fund step couldn't be completed. Your Gas Tank wasn't debited — " +
          "retry in a moment, and if it persists we'll see the trace on our side.",
      };
      await finaliseClaim("failed", 503, body);
      return NextResponse.json(body, { status: 503 });
    }

    // ── Execute bridge ──────────────────────────────────────────────────
    let result;
    try {
      result = await executeBridge({
        src,
        dst,
        amount:           amountRaw,
        destReceiver,
        feeToken,
        maxFee:           maxFeeRaw,
        agenticWalletKey,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isGasLow = /insufficient funds for intrinsic transaction cost|insufficient funds for gas/i.test(msg);
      const body: Record<string, unknown> = isGasLow
        ? {
            error:   "AGENT_WALLET_GAS_LOW",
            chain:   src,
            address: destReceiver,
            ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
            message: agentFundTxHash
              ? "Auto-fund mined but the bridge RPC hadn't picked up the new balance yet. " +
                "Retry in ~30s — Q402 won't re-fund (the Agent Wallet is already topped up)."
              : `Q402 couldn't auto-fund the Agent Wallet's source-chain gas this attempt. ` +
                `Make sure your Gas Tank native bucket has a small buffer on ${src} and retry.`,
          }
        : {
            error: "CCIP_BRIDGE_FAILED",
            detail: msg.slice(0, 400),
            ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
          };
      await finaliseClaim("failed", isGasLow ? 402 : 502, body);
      return NextResponse.json(body, { status: isGasLow ? 402 : 502 });
    }

    // ── KV updates (debit Gas Tank + record history) ────────────────────
    //
    // Atomic claim+debit, same shape as the auto-fund path. Closes the
    // audit's "fee debit fail-open is asymmetric with auto-fund's
    // obsession" finding — if the INCRBYFLOAT response is lost the
    // claim survives and our retry sees "already_claimed"; if the
    // entire EVAL throws we write a pending-fee-debit row so the
    // reconciliation cron can backfill. User still gets a success
    // response either way — the bridge IS on-chain — but the ledger
    // is no longer silently wrong.
    const actualFeeWhole = Number(result.feeRaw) / 1e18;
    try {
      if (feeToken === "LINK") {
        await claimAndDebitLinkBridge(result.txHash, owner, src, actualFeeWhole);
      } else {
        await claimAndDebitNativeBridge(result.txHash, owner, src, actualFeeWhole);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[ccip-bridge-runner] gas-tank fee debit failed (on-chain tx already mined)", {
        owner, src, feeToken, actualFeeWhole, agentFundEth, messageId: result.messageId, err,
      });
      // Durable breadcrumb for the reconcile cron's third pass.
      void setPendingFeeDebit({
        txHash:     result.txHash,
        feeToken,
        amount:     actualFeeWhole,
        ownerLc:    owner,
        chain:      src,
        submittedAt: Date.now(),
        messageId:  result.messageId,
      }).catch((pendingErr) => {
        console.error("[ccip-bridge-runner] setPendingFeeDebit failed", {
          owner, src, txHash: result.txHash,
          err: pendingErr instanceof Error ? pendingErr.message : String(pendingErr),
        });
      });
      void sendOpsAlert(
        `<b>⚠ CCIP fee debit failed — pending-fee-debit row written for cron reconciliation</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `Chain: ${src} · feeToken: ${feeToken}\n` +
        `Fee owed: ${actualFeeWhole} ${feeToken === "LINK" ? "LINK" : "native"}\n` +
        (agentFundEth > 0 ? `(Auto-fund of ${agentFundEth.toFixed(6)} native was already debited above.)\n` : "") +
        `messageId: <code>${result.messageId}</code>\n` +
        `txHash: <code>${result.txHash}</code>\n` +
        `Error: ${err.slice(0, 200)}\n\n` +
        `Cron will retry. Manual debit also OK from ` +
        `${feeToken === "LINK" ? "link_used" : "bridge_native_used"}:${owner.toLowerCase()}.${src}.`,
        "error",
      ).catch(() => { /* alert dispatch best-effort */ });
    }

    const histRec: BridgeHistoryRecord = {
      messageId:    result.messageId,
      txHash:       result.txHash,
      blockNumber:  result.blockNumber,
      owner,
      walletId,
      src,
      dst,
      amount,
      feeToken,
      feeRaw:       result.feeRaw.toString(),
      feeWhole:     actualFeeWhole,
      initiatedAt:  Date.now(),
      ...(result.approveTxHash ? { approveTxHash: result.approveTxHash } : {}),
      ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
    };
    try {
      await Promise.all([
        kv.rpush(bridgeHistKey(owner), histRec),
        kv.set(messageIdMapKey(result.messageId), histRec, { ex: 30 * 24 * 60 * 60 }),
      ]);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[ccip-bridge-runner] history write failed (on-chain tx already mined)", {
        owner, messageId: result.messageId, err,
      });
      void sendOpsAlert(
        `<b>⚠ CCIP history write failed (on-chain tx already mined)</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `Chain: ${src} → ${dst}\n` +
        `messageId: <code>${result.messageId}</code>\n` +
        `txHash: <code>${result.txHash}</code>\n` +
        `Error: ${err.slice(0, 200)}\n\n` +
        `Replay the entry from CCIP Explorer if a user files a missing-bridge ticket.`,
        "error",
      ).catch(() => { /* alert dispatch best-effort */ });
    }

    const responseBody: Record<string, unknown> = {
      success:        true,
      messageId:      result.messageId,
      txHash:         result.txHash,
      blockNumber:    result.blockNumber,
      feeRaw:         result.feeRaw.toString(),
      feeWhole:       actualFeeWhole,
      feeToken,
      ccipExplorer:   `https://ccip.chain.link/msg/${result.messageId}`,
      srcExplorer:    `${CCIP_CONFIG[src].explorer}/tx/${result.txHash}`,
      approveTxHash:  result.approveTxHash,
      ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
      sendId,
    };
    // Permanent settled-fp marker BEFORE finaliseClaim. The marker is
    // the no-TTL backstop the top-of-function `getBridgeSettled` check
    // reads — even if finaliseClaim throws below, this marker
    // guarantees a same-intent retry can never double-bridge. Best
    // effort: if THIS write also throws we still proceed (the regular
    // 24h success cache below is the immediate replay path).
    void markBridgeSettled(fp, {
      messageId: result.messageId,
      txHash:    result.txHash,
      src,
      dst,
      amount,
      feeToken,
      settledAt: Date.now(),
    }).catch((markerErr) => {
      console.error("[ccip-bridge-runner] markBridgeSettled failed", {
        owner, fp, messageId: result.messageId,
        err: markerErr instanceof Error ? markerErr.message : String(markerErr),
      });
      void sendOpsAlert(
        `<b>⚠ CCIP settled-marker write failed</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `fp: <code>${fp}</code>\n` +
        `messageId: <code>${result.messageId}</code>\n` +
        `txHash: <code>${result.txHash}</code>\n\n` +
        `If the regular 24h cache also misses, a 24h+ retry of the same intent could double-bridge. ` +
        `Restore manually: SET ccip_bridge_settled:${fp} ` +
        `'{"messageId":"${result.messageId}","txHash":"${result.txHash}","src":"${src}","dst":"${dst}",` +
        `"amount":"${amount}","feeToken":"${feeToken}","settledAt":${Date.now()}}'`,
        "error",
      ).catch(() => { /* best-effort */ });
    });

    try {
      await finaliseClaim("success", 200, responseBody);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[ccip-bridge-runner] success-claim finalisation failed (on-chain tx already mined)", {
        owner, messageId: result.messageId, sendId, err,
      });
      void sendOpsAlert(
        `<b>⚠ CCIP success-claim KV write failed (on-chain tx already mined)</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `sendId: <code>${sendId}</code>\n` +
        `messageId: <code>${result.messageId}</code>\n` +
        `Error: ${err.slice(0, 200)}\n\n` +
        `User received success response; idempotency claim row may be missing — ` +
        `a same-intent retry will not be served from cache.`,
        "error",
      ).catch(() => { /* alert dispatch best-effort */ });
    }
    return NextResponse.json(responseBody);
  } finally {
    await releaseLock();
  }
}
