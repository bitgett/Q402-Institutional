/**
 * POST /api/ccip/send
 *
 * Execute a CCIP bridge from the user's source-chain Agentic Wallet to
 * their destination-chain Agentic Wallet (same EOA across chains).
 *
 * Intent-bound auth (`ccip.bridge`): challenge embeds walletId + src +
 * dst + amount + feeToken so a leaked session sig can't replay across
 * different bridge intents. Every send takes a fresh challenge.
 *
 * Mode C only (server-managed Agentic Wallet). The route:
 *   1. Authenticates owner + walletId via intent-bound sig
 *   2. **Gates on Multichain subscription** (no trial-tier bridging)
 *   3. **Claims an idempotency fingerprint** so a retry of the same
 *      (owner, walletId, src, dst, amount, feeToken) tuple replays the
 *      original result instead of double-bridging
 *   4. **Acquires a per-(owner, src) lock** so two distinct-intent sends
 *      can't race on the LINK balance RMW
 *   5. Looks up active Agentic Wallet on source chain
 *   6. Decrypts the wallet's private key (server-side)
 *   7. Quotes the CCIP fee on-chain
 *   8. **Caps maxFee server-side** — client-supplied maxFee is min()'d
 *      against the server's 10% slippage ceiling so a forged body can't
 *      opt out of the slippage guard
 *   9. Checks the user's Gas Tank LINK or native balance (KV)
 *  10. Submits Sender.bridge() signing as the Agentic Wallet (lazy
 *      USDC approval bootstrap on first bridge per wallet per chain)
 *  11. Debits Gas Tank LINK / native by the actual fee paid
 *  12. Records bridge history (KV) — messageId → owner mapping
 *  13. Finalises the idempotency claim with the response shape
 *  14. Returns txHash + messageId (+ approveTxHash on first bridge)
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireIntentAuth } from "@/app/lib/auth";
import { getActiveAgenticWallet, decryptPrivateKey } from "@/app/lib/agentic-wallet";
import {
  isCCIPChain,
  CCIP_CONFIG,
  quoteBridgeFee,
  executeBridge,
  getCCIPProvider,
  type CCIPChainKey,
  type FeeTokenKind,
} from "@/app/lib/ccip";
import {
  getLinkBalance,
  recordLinkUsage,
  getGasBalance,
  acquirePendingFundReconcileLock,
  claimAndDebitNativeBridge,
  recordNativeBridgeUsage,
  recordOrphanFund,
  releasePendingFundReconcileLock,
  getSubscription,
  hasMultichainScope,
  getPendingFund,
  setPendingFund,
  clearPendingFund,
} from "@/app/lib/db";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";

export const runtime = "nodejs";
// 60s — first bridge runs approve.wait() + bridge.wait() back-to-back. ETH
// mainnet finality alone can eat 15-20s; the previous 30s ceiling left no
// headroom for KV finalisation if approve and bridge both went slow.
export const maxDuration = 60;

interface SendBody {
  address?:    string;
  nonce?:      string;
  signature?:  string;
  walletId?:   string;
  src?:        string;
  dst?:        string;
  amount?:     string;   // raw 6-decimal USDC
  feeToken?:   string;   // "LINK" | "native"
  maxFeeRaw?:  string;   // optional client-side fee cap (raw 18-dec). Server still
                         //   clamps to its own 10% slippage ceiling — client cannot
                         //   *raise* the cap, only lower it.
}

interface BridgeHistoryRecord {
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
  // Set iff the route auto-funded source-chain gas to the Agent Wallet
  // from the relayer hot wallet (Gas Tank is debited by `agentFundEth`).
  agentFundTxHash?: string;
  agentFundEth?:   number;
}

/**
 * Idempotency record. Mirrors the agentic-send pattern: the fingerprint
 * is the SHA of the intent tuple; a retry with the same intent (e.g. the
 * client lost the response and re-fires) replays this record instead of
 * submitting a second on-chain tx.
 */
interface BridgeSendRecord {
  status:        "processing" | "success" | "failed";
  startedAt:     number;
  finishedAt?:   number;
  sendId:        string;
  relayStatus?:  number;
  relayBody?:    Record<string, unknown>;
}

const IDEMPOTENCY_TTL_SEC = 30 * 60;

function bridgeHistKey(owner: string): string {
  return `ccip_bridge:${owner.toLowerCase()}`;
}

function messageIdMapKey(messageId: string): string {
  return `ccip_msg:${messageId.toLowerCase()}`;
}

/**
 * Per-(owner, walletId, src, dst, amount, feeToken) fingerprint. Two POSTs
 * with the same intent tuple share this fingerprint; the second observes
 * the first's claim and replays the response. Distinct-intent POSTs get
 * distinct fingerprints and proceed independently (subject to the
 * concurrency lock below).
 */
function bridgeFingerprint(
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
 * Per-(owner, src) concurrency lock. Without this, two distinct-intent
 * bridges (e.g. eth→avax 5 USDC + eth→arbitrum 3 USDC fired in parallel)
 * would both pass the LINK balance check before either's `recordLinkUsage`
 * RMW landed — net overspend against the facilitator pool. 90s covers
 * the worst-case approve + bridge + KV wall time.
 */
function ccipLockKey(owner: string, src: string): string {
  return `ccip_lock:${owner.toLowerCase()}:${src}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "ccip-bridge-send", 6, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate body (BEFORE auth so we rebuild the intent against the
  //    same constraints the user signed) ──
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }
  if (!body.src || !isCCIPChain(body.src)) {
    return NextResponse.json({ error: "src must be one of eth/avax/arbitrum" }, { status: 400 });
  }
  if (!body.dst || !isCCIPChain(body.dst)) {
    return NextResponse.json({ error: "dst must be one of eth/avax/arbitrum" }, { status: 400 });
  }
  const src = body.src as CCIPChainKey;
  const dst = body.dst as CCIPChainKey;
  if (src === dst) {
    return NextResponse.json({ error: "src and dst must differ" }, { status: 400 });
  }
  if (!CCIP_CONFIG[src].supportedDestinations.includes(dst)) {
    return NextResponse.json({ error: `Lane ${src} → ${dst} not supported` }, { status: 400 });
  }
  if (!body.amount || !/^\d+$/.test(body.amount)) {
    return NextResponse.json({ error: "amount must be a non-negative integer string (raw 6-decimal USDC)" }, { status: 400 });
  }
  const amountRaw = BigInt(body.amount);
  if (amountRaw === 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }
  const feeToken: FeeTokenKind = body.feeToken === "native" ? "native" : "LINK";

  // ── Sender contract must be deployed (manifest field != PENDING_DEPLOY) ──
  if (CCIP_CONFIG[src].sender === "PENDING_DEPLOY") {
    return NextResponse.json({
      error: "CCIP_SENDER_NOT_DEPLOYED",
      detail: `Q402CCIPSender not yet deployed on ${src}. Bridge route disabled until manifest is patched with the deployed address.`,
    }, { status: 503 });
  }

  // ── Intent-bound auth — binds owner + walletId + src + dst + amount ─────
  const authResult = await requireIntentAuth({
    address:   body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action:    "ccip.bridge",
    intent: {
      walletId: body.walletId.toLowerCase(),
      src,
      dst,
      amount:   body.amount,
      feeToken,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;
  const walletId = body.walletId.toLowerCase();

  // ── Subscription gate — bridging is Multichain-only ─────────────────────
  // Without this, a trial-key user with a tiny LINK or native deposit can
  // bridge unlimited USDC across chains for free (the actual CCIP fee
  // comes out of the facilitator pool, not their Gas Tank — combined
  // with the native-debit bug below, this was a clean drain path).
  const sub = await getSubscription(owner);
  if (!hasMultichainScope(sub)) {
    return NextResponse.json(
      {
        error: "SUBSCRIPTION_REQUIRED",
        message: "Cross-chain CCIP bridging requires an active Multichain subscription.",
      },
      { status: 402 },
    );
  }

  // ── Idempotency claim (per-intent) ──────────────────────────────────────
  // Replay of the SAME intent (e.g. client lost the response) hits this
  // claim and gets the original outcome back instead of double-bridging.
  // Distinct intents get distinct fingerprints and bypass this block.
  const fp = bridgeFingerprint(owner, walletId, src, dst, body.amount, feeToken);
  const idempotencyKey = bridgeClaimKey(fp);
  const startedAt = Date.now();
  const sendId = ethers.hexlify(ethers.randomBytes(8)).slice(2);
  const initialClaim: BridgeSendRecord = { status: "processing", startedAt, sendId };
  const claimed = await kv.set(idempotencyKey, initialClaim, { nx: true, ex: IDEMPOTENCY_TTL_SEC });
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
    // Claim absent on race-loss (KV TTL window) — fall through and let
    // the per-(owner, src) lock below serialise the retry.
  }

  // Helper — every early-return below must release the idempotency claim
  // with the appropriate status, otherwise a transient 4xx would poison
  // the next 30 min of retries.
  async function finaliseClaim(
    status: BridgeSendRecord["status"],
    relayStatus: number,
    relayBody: Record<string, unknown>,
  ): Promise<void> {
    const finishedAt = Date.now();
    const finalTtl = status === "success" ? IDEMPOTENCY_TTL_SEC : 60;
    await kv.set(
      idempotencyKey,
      { status, startedAt, finishedAt, sendId, relayStatus, relayBody },
      { ex: finalTtl },
    );
  }

  // ── Per-(owner, src) concurrency lock ───────────────────────────────────
  // Prevents two DISTINCT-intent bridges from racing on the LINK balance
  // RMW. The lock is per-source-chain because the LINK/native debit is
  // per-source-chain; cross-chain parallelism is still allowed.
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
    const destReceiver = wallet.address;  // same EOA across chains

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

    // Server-side slippage ceiling. Client may *lower* the cap (e.g. a
    // strict batch wants a tighter bound) but cannot *raise* it past
    // the server's 10% ceiling.
    const serverCap = (feeRaw * 11n) / 10n;
    const clientCap = body.maxFeeRaw ? BigInt(body.maxFeeRaw) : serverCap;
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
          deposit: `Send LINK on ${src} to the Q402 facilitator to top up.`,
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
    //
    // The bridge tx is sent by the Agent Wallet itself (signed with its
    // server-held private key) and pays its own source-chain gas. That
    // would normally force the user to deposit native directly to the
    // Agent Wallet address — defeating the Mode C promise that the user
    // only ever has to fund the Gas Tank.
    //
    // Money-flow invariant (P1 — closed by FIX 44):
    //   The relayer hot wallet's actual outlay = fundDeltaWei sent + the
    //   gas the funding tx itself burned. Both MUST land on the user's
    //   side of the ledger the moment the funding tx mines, REGARDLESS of
    //   whether the downstream bridge tx succeeds. Otherwise a bridge
    //   that reverts after a successful fund leaks relayer ETH.
    //
    //   Implementation: record the debit IMMEDIATELY after `fundTx.wait()`
    //   returns a success receipt, BEFORE calling executeBridge. If the
    //   record-debit call itself throws, abort with a critical ops alert
    //   so the drift can be reconciled by hand — never silently swallow.
    //
    // Relayer pre-check (P2 — closed by FIX 46):
    //   Probe the relayer's on-chain ETH balance and ensure it covers
    //   (fundDeltaWei + the funding-tx gas ceiling). If short, surface
    //   RELAYER_LOW directly instead of letting sendTransaction throw
    //   downstream with a less specific error.
    //
    // Funding-tx gas debit (P2 — closed by FIX 45):
    //   Charge the user for the actual gas the funding tx burned, taken
    //   from the receipt (`gasUsed × effectiveGasPrice`). Otherwise the
    //   relayer absorbs an ongoing ~21k-gas cost per bridge.
    //
    // Wait-timeout (FIX 47):
    //   Bound `fundTx.wait()` so a chain hiccup can't blow the 60s Vercel
    //   function ceiling. On timeout return AUTOFUND_PENDING with
    //   Retry-After so the retry sees the agent wallet already funded
    //   and skips the auto-fund leg entirely.
    let agentFundEth = 0;
    let agentFundTxHash: string | undefined;
    const FUND_GAS_LIMIT = 21_000n;  // bare native transfer; no calldata
    const FUND_TX_WAIT_MS = 25_000;
    try {
      const probeProvider = getCCIPProvider(src);

      // ── Reconcile a pending fund tx from a previous attempt ────────
      // If the previous attempt's `fundTx.wait()` timed out, the KV row
      // here carries the txHash + planned debit. Before doing anything
      // else, fetch the receipt:
      //   - mined success → debit (gasUsed × effectiveGasPrice + value),
      //     delete the row, set agentFundEth/agentFundTxHash so this
      //     attempt's history record carries the funding tx, and fall
      //     through to the Agent Wallet balance probe (may still need a
      //     small top-up if gas spiked since)
      //   - mined reverted → delete the row, no debit owed; fall through
      //   - receipt absent → tx still pending; return AUTOFUND_PENDING
      //     and let the user retry in 30s
      const pending = await getPendingFund(owner, src);
      if (pending) {
        // ── Cross-intent drift guard ─────────────────────────────────
        // The pending fund record was written for a SPECIFIC intent
        // (src/dst/amount/feeToken combo, fingerprinted as intentFp).
        // If THIS retry is for a different intent (e.g. user changed
        // dst from avax→arbitrum, or amount from 1→100 USDC), the
        // pending fund delta and the new intent's gas needs don't
        // line up — agentFundTxHash would link the user's bridge
        // history record to a tx that funded a DIFFERENT bridge. Bail
        // and let the user wait for the cron to settle the old intent
        // (~5 min) so this route runs against a clean state.
        //
        // Treat a MISSING intentFp the same way: rows written by the
        // pre-deploy code path don't carry the binding, so they are
        // by definition unsafe to reconcile against a new request.
        // Forces the cron path to settle them.
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
        // ── CAS lock against the cron reconciler ─────────────────────
        // The /api/cron/ccip-pending-fund-reconcile cron can race this
        // inline path: both fetch the same receipt and both INCRBYFLOAT
        // the user's bridge_native_used bucket → double debit. SETNX
        // with 30s TTL ensures only one writer proceeds; loser returns
        // AUTOFUND_PENDING so the user retries after the cron completes.
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
              // Atomic per-txHash claim + INCRBYFLOAT in one Redis EVAL.
              // If another writer (cron OR another inline retry) already
              // settled this hash, the script returns "already_claimed"
              // and we skip the INCR — the bucket is already correct.
              // If the script reaches INCR and the network drops the
              // response, the claim survives on the server and our
              // retry will see "already_claimed" — no double debit
              // and no missed debit.
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
            // Reverted — clear and continue. We owe nothing for a reverted tx.
            await clearPendingFund(owner, src);
          }
        } finally {
          await releasePendingFundReconcileLock(owner, src, reconcileLockToken);
        }
      }

      // ── EIP-7702 delegation gate ───────────────────────────────────
      // Q402's payment impl contract has no `receive()` function (the
      // Mode A/B docs flag this as a known v1 limitation). So any
      // Agent Wallet that has ever processed a /api/wallet/agentic/send
      // gets delegated to Q402 impl via the type-4 tx, and from that
      // point on a plain native transfer to that wallet REVERTS. That
      // includes the auto-fund tx below. Detect and fail closed with a
      // specific code so the dashboard can guide the user to clear the
      // delegation (q402_clear_delegation MCP tool, dashboard button)
      // before bridging.
      //
      // TODO follow-up: have the auto-fund block call broadcastClear()
      // server-side before sendTransaction, debit the user for the
      // clear-tx gas, and continue inline. That removes the manual
      // step but adds ~50k gas per bridge — defer until we have a
      // baseline on bridge volume.
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
      // executeBridge does a one-time USDC.approve(Sender, MAX) on the
      // first bridge per (wallet, chain). On every subsequent bridge
      // the allowance is already infinite, so we don't need to fund
      // for that 56k-ish gas. Probe the live allowance and size the
      // budget accordingly.
      const usdcAddr = CHAIN_CONFIG[src as ChainKey].usdc.address;
      const senderAddr = CCIP_CONFIG[src].sender;
      const ALLOWANCE_SELECTOR = "0xdd62ed3e"; // allowance(address,address)
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
        // Allowance probe failed — assume approve needed (safer to
        // overfund slightly than to under-fund and revert).
      }

      // ── Fee estimate ──────────────────────────────────────────────
      // `maxFeePerGas` from getFeeData() is `baseFee × 2 + tip` which
      // is what Ethereum requires as the balance-check at submission
      // time. But the bridge tx pays only `currentBaseFee + tip` at
      // mining, so funding for full maxFeePerGas leaves a big spare
      // sitting in the Agent Wallet. Use `baseFee × 1.5 + tip` —
      // still covers one block of baseFee growth (EIP-1559 max +12.5%)
      // and the tip surface, while shaving ~25% off the fund amount.
      const baseFee = latestBlock?.baseFeePerGas ?? 0n;
      const tipFee  = feeData.maxPriorityFeePerGas
        ?? ethers.parseUnits("0.2", "gwei");
      // Submission ceiling: what the chain requires at tx-submit time.
      const submitMaxFeePerGas = baseFee > 0n
        ? (baseFee * 15n) / 10n + tipFee
        : (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n);
      // Gas budget: approve (56k) + bridge (315k) = 371k. Pad to 380k
      // with approve, 320k without. Tighter than the previous 400k
      // because the actual usage from real receipts is 313k bridge +
      // 56k approve, so even 380k leaves only 7k headroom (well
      // within the tolerance of the 50% buffer above on the fee).
      const gasNeeded = needsApprove ? 380_000n : 320_000n;
      const gasCeilingWei = submitMaxFeePerGas * gasNeeded;
      // When paying the CCIP fee in NATIVE, the Sender's ccipSend is
      // `payable` — the fee comes out of msg.value, which the Agent
      // Wallet must hold IN ADDITION to source-chain gas. If we only
      // require `agentEth >= gasCeilingWei` and the wallet happens to
      // have exactly the gas amount, the bridge submission reverts
      // "insufficient funds for value+gas". Add feeRaw to the threshold
      // so the auto-fund top-up covers gas + fee together; otherwise
      // the user hits AGENT_WALLET_GAS_LOW with a Gas Tank that's
      // already at 0 for the native bucket.
      const feeShortfallWei = feeToken === "native" ? feeRaw : 0n;
      const agentEthThreshold = gasCeilingWei + feeShortfallWei;
      if (agentEth < agentEthThreshold) {
        // 10% buffer over the bare delta. Down from 20% — combined
        // with the tighter fee estimate above, this cuts the "first
        // bridge" upfront cost roughly in half without risking
        // submission-time reverts. The actual leftover (mining price
        // < submit ceiling) still gets carried forward to subsequent
        // bridges, so cumulative spend over many bridges is unchanged.
        const fundDeltaWei = ((agentEthThreshold - agentEth) * 11n) / 10n;
        const fundDeltaEth = Number(fundDeltaWei) / 1e18;
        // Worst-case funding-tx gas cost — used for both the relayer
        // pre-check below and the upper bound of what the user could be
        // billed if the receipt comes back with effectiveGasPrice == 0
        // (which would be a chain bug, but we surface it cleanly).
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

        // ── Gate 2: relayer has on-chain native to fund + pay tx gas ─
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
        // Need fund + funding gas + a 1.5× margin for bridge-side
        // settlements that may race on the same hot wallet.
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

        // Write the pending KV record IMMEDIATELY after broadcast (and
        // BEFORE wait) so an upstream timeout / Vercel kill still leaves
        // a reconciliation breadcrumb. The inline reconciliation block
        // above + the cron in /api/cron/ccip-pending-fund-reconcile
        // both key off this; without it, the only path to debit a slow
        // fund tx would be the user retrying with the same intent
        // fingerprint within the idempotency window — but the wait-then-
        // debit path below CANNOT close the loop if it fails to fire
        // (Vercel function kill, RPC blip during wait), so the KV row is
        // the ONLY durable breadcrumb. P1 — FIX 63.
        //
        // Retry up to 3× with backoff. If still failing, page ops with
        // the full reconciliation info (owner, chain, txHash, fundDelta,
        // submittedAt, intentFp) so the row can be backfilled by hand.
        // We do NOT abort the bridge — the fund tx is already on chain,
        // so the user's response should still complete; ops just has to
        // re-create the KV row before the cron can reconcile it.
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
            console.error("[ccip/send] setPendingFund attempt failed", {
              attempt,
              owner,
              src,
              txHash: fundTx.hash,
              err: e instanceof Error ? e.message : String(e),
            });
            if (attempt < 2) await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          }
        }
        if (!pendingWritten) {
          // Last-resort durable breadcrumb — write to the orphan-fund
          // bucket (no TTL, keyed by txHash) so the row survives even
          // if the Telegram ops alert is missed or archived. The
          // orphan-reconcile pass in the existing cron scans this
          // prefix and credits the debit on the next tick.
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
            // CRITICAL: even the orphan write failed. The fund tx is
            // on-chain, no durable breadcrumb exists, and the user
            // SHOULD be debited. Distinct alert + structured console
            // log so ops can immediately reconstruct manually.
            console.error("[ccip/send] CRITICAL: pending AND orphan writes both failed", {
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
          // Leave the pending KV row in place. The next retry hits the
          // reconciliation block at the top of this try, which fetches
          // the receipt + debits + clears. Cron is the backstop if the
          // user never retries.
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
          // wait() returned null (no receipt) — defensive abort. Leave
          // the pending KV row for reconciliation.
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

        // ── If the funding tx reverted (almost impossible for a bare
        //    native transfer but guard anyway), there's nothing to debit.
        //    Clear the pending row so the retry doesn't think it owes us.
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
        // From here on, the relayer's ETH has already left. ANY failure
        // below this line MUST either (a) succeed at recording the debit
        // and proceed, or (b) record the debit anyway + alert ops + abort.
        // We never reach executeBridge without the debit being on the
        // ledger; that's the whole P1 close.
        const actualFundGasUsed   = fundReceipt.gasUsed ?? 0n;
        const actualFundGasPrice  = fundReceipt.gasPrice ?? submitMaxFeePerGas;
        const actualFundGasWei    = actualFundGasUsed * actualFundGasPrice;
        const actualFundGasEth    = Number(actualFundGasWei) / 1e18;
        const debitEth            = fundDeltaEth + actualFundGasEth;
        try {
          // Atomic per-txHash claim + INCRBYFLOAT. If a concurrent
          // retry or the reconcile cron already settled this fund tx
          // the script returns "already_claimed" and we don't re-INCR
          // (no double debit). If the network drops the response after
          // INCR ran, the claim guarantees our retry sees the same
          // "already_claimed" verdict.
          await claimAndDebitNativeBridge(fundTx.hash, owner, src, debitEth);
          // Debit landed (or was already on the ledger) — pending row no
          // longer needed.
          await clearPendingFund(owner, src).catch(() => { /* TTL will sweep */ });
        } catch (debitErr) {
          const err = debitErr instanceof Error ? debitErr.message : String(debitErr);
          // Leave the pending row in place so the cron / next retry
          // tries the debit again. Page ops with the full delta so they
          // can choose to reconcile manually instead of waiting.
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
      // Pre-fund probe / gas-tank check threw. Fail-closed so ops sees
      // the real error and the user retries cleanly. No relayer ETH at
      // risk here because sendTransaction wasn't reached.
      const err = e instanceof Error ? e.message : String(e);
      const errName = e instanceof Error ? e.constructor.name : "Error";
      console.error("[ccip/send] auto-fund pre-broadcast threw — failing closed", {
        owner,
        src,
        errName,
        err,
      });
      void sendOpsAlert(
        `<b>⚠ CCIP auto-fund pre-broadcast threw</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `Chain: ${src}\n` +
        `Agent Wallet: <code>${destReceiver}</code>\n` +
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
    //
    // Money state at this point:
    //   - If we auto-funded, agentFundEth is ALREADY debited from the
    //     native bucket; a bridge failure here does NOT leak relayer ETH.
    //   - The CCIP fee (LINK or native) is debited AFTER a successful
    //     executeBridge — that's correct because if the bridge fails, no
    //     CCIP fee was burned on chain.
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
      // Late detection — pre-fund probe may have missed (RPC blip), gas
      // spiked between probe and submit, or the funding tx hadn't
      // propagated to every RPC node by the time executeBridge fetched
      // the wallet balance. Promote the underlying viem error to a
      // friendly code that points users at the right action (just wait
      // and retry — they're already funded).
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
    // Every KV write here happens AFTER the bridge tx has already mined
    // on-chain. The user has spent. Any KV failure must:
    //   1. NOT propagate back to the user (their on-chain side is fine)
    //   2. NOT swallow the failure silently — accounting drift between
    //      on-chain spend and our ledger is exactly the class of incident
    //      we need ops to know about within seconds, not next quarter
    //   3. Preserve the success response shape so the dashboard renders
    //      messageId / source tx / CCIP explorer link and the user can
    //      track the message — the receipt is more important than the
    //      bookkeeping.
    const actualFeeWhole = Number(result.feeRaw) / 1e18;
    // Auto-fund (fund native amount + funding-tx gas) is already debited
    // ABOVE, immediately after the funding tx receipt confirmed — that's
    // the P1 close, so the relayer can't leak ETH on a downstream bridge
    // failure. Here we only debit the CCIP fee itself (either LINK or
    // native bucket, depending on feeToken). Counters are atomic
    // (INCRBYFLOAT) per chain.
    try {
      if (feeToken === "LINK") {
        await recordLinkUsage(owner, src, actualFeeWhole);
      } else {
        await recordNativeBridgeUsage(owner, src, actualFeeWhole);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[ccip/send] gas-tank fee debit failed (on-chain tx already mined)", {
        owner,
        src,
        feeToken,
        actualFeeWhole,
        agentFundEth,
        messageId: result.messageId,
        err,
      });
      // Fire-and-forget — ops alert MUST NOT delay the success response
      // back to the user (their tx is on-chain regardless).
      void sendOpsAlert(
        `<b>⚠ CCIP fee debit failed (on-chain tx already mined)</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `Chain: ${src} · feeToken: ${feeToken}\n` +
        `Fee owed: ${actualFeeWhole} ${feeToken === "LINK" ? "LINK" : "native"}\n` +
        (agentFundEth > 0 ? `(Auto-fund of ${agentFundEth.toFixed(6)} native was already debited above.)\n` : "") +
        `messageId: <code>${result.messageId}</code>\n` +
        `Error: ${err.slice(0, 200)}`,
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
      amount:       body.amount,
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
        kv.set(messageIdMapKey(result.messageId), histRec, { ex: 30 * 24 * 60 * 60 }), // 30d TTL
      ]);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[ccip/send] history write failed (on-chain tx already mined)", {
        owner,
        messageId: result.messageId,
        err,
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
      // Present iff the Agentic Wallet's USDC allowance was insufficient and
      // we auto-submitted approve(MAX) before the bridge. One-time per wallet
      // per chain — subsequent bridges skip this leg.
      approveTxHash:  result.approveTxHash,
      // Present iff Q402 auto-funded the Agent Wallet's source-chain gas
      // from the user's Gas Tank ETH bucket. Surfaced so the dashboard can
      // attribute the Gas Tank delta and link the on-chain top-up tx.
      ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
      sendId,
    };
    // finaliseClaim is best-effort — the on-chain tx already succeeded,
    // so a transient KV write failure on the success record must NOT
    // mask the success response from the user. (The cost of returning
    // 500 here is the user re-firing the bridge with a fresh challenge,
    // which would actually double-spend if the second attempt happens
    // to hit a KV-recovered state.) Ops gets a durable Telegram marker
    // so the missing claim row can be backfilled by hand if needed.
    try {
      await finaliseClaim("success", 200, responseBody);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[ccip/send] success-claim finalisation failed (on-chain tx already mined)", {
        owner,
        messageId: result.messageId,
        sendId,
        err,
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
