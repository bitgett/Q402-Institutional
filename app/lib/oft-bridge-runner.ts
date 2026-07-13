/**
 * oft-bridge-runner.ts — shared USDT0 (LayerZero OFT) bridge executor.
 *
 * Companion to ccip-bridge-runner.ts (USDC/CCIP). Both `/api/oft/send`-style
 * entrypoints and `/api/wallet/agentic/oft-bridge` (Mode C) call into this once
 * auth lifts. The money-flow invariants are the SAME as the CCIP runner and use
 * the SAME db.ts primitives (settled-fingerprint backstop, atomic idempotency
 * claim, per-(owner,src) lock, atomic claim+debit keyed by txHash, pending-fee
 * breadcrumb, permanent settled marker) — the only differences are:
 *
 *   - Native fee only (LayerZero has no LINK path), so the Gas Tank LINK slot is
 *     never touched here.
 *   - The bridge is RELAYER-submitted (Q402OftSender.bridgeFor is facilitator-
 *     gated), so the Agent Wallet EOA only ever needs source-chain gas for the
 *     ONE-TIME token approval of the Sender — not for the bridge itself. The
 *     approval gas is topped up on demand, once per (wallet, chain).
 *
 * Returns a NextResponse; owns the idempotency lifecycle (callers must not
 * re-claim the same fingerprint).
 */

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { kv } from "@vercel/kv";
import { getActiveAgenticWallet, decryptPrivateKey } from "@/app/lib/agentic-wallet";
import {
  OFT_CONFIG,
  quoteOftBridge,
  executeOftBridge,
  getOftProvider,
  OFT_SENDER_ABI,
  type OftChainKey,
} from "@/app/lib/usdt0";
import {
  getGasBalance,
  claimAndDebitNativeBridge,
  setPendingFeeDebit,
  markBridgeSettled,
  getBridgeSettled,
} from "@/app/lib/db";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { rateLimit } from "@/app/lib/ratelimit";
import { isChainDisabled, CHAIN_DISABLED_MESSAGE } from "@/app/lib/chain-status";

export interface OftBridgeHistoryRecord {
  guid:         string;
  txHash:       string;
  blockNumber:  number;
  owner:        string;
  walletId:     string;
  src:          string;
  dst:          string;
  amount:       string;
  amountReceived: string;
  feeRaw:       string;
  feeWhole:     number;
  initiatedAt:  number;
  approveTxHash?:   string;
  agentFundTxHash?: string;
  agentFundEth?:    number;
}

interface OftSendRecord {
  status:      "processing" | "success" | "failed";
  startedAt:   number;
  finishedAt?: number;
  sendId:      string;
  relayStatus?: number;
  relayBody?:  Record<string, unknown>;
}

const IDEMPOTENCY_TTL_PROCESSING_SEC = 30 * 60;
const IDEMPOTENCY_TTL_SUCCESS_SEC    = 24 * 60 * 60;

export function oftBridgeHistKey(owner: string): string {
  return `oft_bridge:${owner.toLowerCase()}`;
}
export function oftGuidMapKey(guid: string): string {
  return `oft_guid:${guid.toLowerCase()}`;
}

/** Per-(owner, walletId, src, dst, amount) fingerprint. USDT always, so no feeToken axis. */
export function oftFingerprint(
  owner: string, walletId: string, src: string, dst: string, amount: string,
): string {
  const seed = [owner.toLowerCase(), walletId.toLowerCase(), src, dst, amount, "usdt0"].join("|");
  return ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(2, 18);
}
function oftClaimKey(fp: string): string { return `oft_send:${fp}`; }
function oftLockKey(owner: string, src: string): string { return `oft_lock:${owner.toLowerCase()}:${src}`; }

export interface RunOftBridgeArgs {
  owner:           string;
  walletId:        string;
  src:             OftChainKey;
  dst:             OftChainKey;
  amount:          string;   // raw local-decimal USDT0 (validated positive integer string)
  clientMaxFeeRaw?: bigint;  // client slippage cap (native wei); clamped to server ceiling
  extraOptions?:   string;
}

// Approval-gas top-up: how much native to leave in the EOA for the one-time
// approve(). Estimated per attempt from the live gas price; capped so a spike
// can't drain the Gas Tank.
const APPROVAL_GAS_UNITS = 80_000n;
// Per-chain ceiling on the one-time approve-gas top-up, in NATIVE units. A chain with a
// high gas price denominated in a low-value token (Monad/Mantle run ~200 gwei) needs a
// far larger native cap than ETH/Arbitrum, where the same 80k-gas approve costs a sliver
// of a valuable token. The old single ETH-sized cap (0.003) starved the Monad approve
// (it needs ~0.016 MON), so the top-up funded only 0.003 and the approve reverted
// "Signer had insufficient balance".
const APPROVAL_FUND_CAP_WEI_DEFAULT = ethers.parseEther("0.003");
const APPROVAL_FUND_CAP_WEI: Record<string, bigint> = {
  eth:      ethers.parseEther("0.005"),
  arbitrum: ethers.parseEther("0.005"),
  mantle:   ethers.parseEther("0.10"),
  monad:    ethers.parseEther("0.10"),
  xlayer:   ethers.parseEther("0.03"),
};

export async function runOftBridge(args: RunOftBridgeArgs): Promise<NextResponse> {
  const { owner, walletId, src, dst } = args;
  // Controlled-launch gate: even with the Q402OftSender addresses wired into the
  // manifest, the USDT0 rail stays OFF until OFT_ENABLED=1. Lets the contracts
  // deploy + the code ship dark, then flip the rail on when the pools are funded.
  if (process.env.OFT_ENABLED !== "1") {
    return NextResponse.json({
      error: "OFT_DISABLED",
      message: "The USDT0 (LayerZero) bridge is not enabled yet. Use q402_bridge_send for USDC in the meantime.",
    }, { status: 503 });
  }
  if (isChainDisabled(src) || isChainDisabled(dst)) {
    return NextResponse.json({ error: CHAIN_DISABLED_MESSAGE }, { status: 400 });
  }
  const amount = args.amount;
  const amountRaw = BigInt(amount);

  // ── Settled-fingerprint backstop (no TTL) ──────────────────────────────────
  const fp = oftFingerprint(owner, walletId, src, dst, amount);
  const settled = await getBridgeSettled(fp);
  if (settled) {
    return NextResponse.json({
      success: true, idempotent: true, fromSettledMarker: true,
      guid: settled.messageId, txHash: settled.txHash,
      src: settled.src, dst: settled.dst, amount: settled.amount,
      settledAt: settled.settledAt,
      lzScan: `${OFT_CONFIG[src].lzScan}/tx/${settled.txHash}`,
      note: "This USDT0 bridge intent settled previously (durable marker). To bridge again, vary the amount or chain pair.",
    }, { status: 200 });
  }

  // ── Rate limit: 10 bridges/hour per (wallet, src). fail-OPEN. ──────────────
  if (!(await rateLimit(`wallet:${walletId}:${src}`, "oft-bridge-wallet", 10, 3600, false))) {
    return NextResponse.json({
      error: "BRIDGE_RATE_LIMITED",
      message: "This Agent Wallet has fired more than 10 USDT0 bridges on this source chain in the last hour. Wait a bit and retry.",
    }, { status: 429 });
  }

  // ── Idempotency claim ──────────────────────────────────────────────────────
  const idempotencyKey = oftClaimKey(fp);
  const startedAt = Date.now();
  const sendId = ethers.hexlify(ethers.randomBytes(8)).slice(2);
  const claimed = await kv.set(idempotencyKey, { status: "processing", startedAt, sendId } as OftSendRecord, {
    nx: true, ex: IDEMPOTENCY_TTL_PROCESSING_SEC,
  });
  if (!claimed) {
    const live = await kv.get<OftSendRecord>(idempotencyKey);
    if (live) {
      const isProcessing = live.status === "processing";
      const httpStatus = live.relayStatus ?? (isProcessing ? 202 : 500);
      return NextResponse.json({
        ...((live.relayBody as Record<string, unknown>) ?? {}),
        idempotent: true,
        ...(isProcessing ? { pending: true, retryAfterSec: 10 } : {}),
        status: live.status, startedAt: live.startedAt, finishedAt: live.finishedAt, sendId: live.sendId,
      }, { status: httpStatus, ...(isProcessing ? { headers: { "Retry-After": "10" } } : {}) });
    }
    // Lost the claim but the winner's record is unreadable — fail CLOSED.
    return NextResponse.json({
      error: "CLAIM_RACE_UNRESOLVED",
      message: "A concurrent bridge holds this idempotency claim but its state is momentarily unreadable. Retry in ~10s.",
    }, { status: 503, headers: { "Retry-After": "10" } });
  }

  async function finaliseClaim(status: OftSendRecord["status"], relayStatus: number, relayBody: Record<string, unknown>): Promise<void> {
    await kv.set(idempotencyKey, { status, startedAt, finishedAt: Date.now(), sendId, relayStatus, relayBody },
      { ex: status === "success" ? IDEMPOTENCY_TTL_SUCCESS_SEC : 60 });
  }

  // ── Per-(owner, src) lock (atomic CAS release) ─────────────────────────────
  const lockKey = oftLockKey(owner, src);
  const lockAcquired = await kv.set(lockKey, sendId, { nx: true, ex: 90 });
  if (!lockAcquired) {
    const body = { error: "OFT_BRIDGE_BUSY", message: "Another USDT0 bridge is in flight on this source chain. Retry in ~30s." };
    await finaliseClaim("failed", 409, body);
    return NextResponse.json(body, { status: 409, headers: { "Retry-After": "30" } });
  }
  const releaseLock = async (): Promise<void> => {
    try {
      const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      await (kv as unknown as { eval: (s: string, k: string[], a: string[]) => Promise<unknown> }).eval(script, [lockKey], [sendId]);
    } catch { /* TTL cleans up */ }
  };

  let agentFundTxHash: string | undefined;
  let agentFundEth = 0;

  try {
    // ── Wallet lookup + decrypt ──────────────────────────────────────────────
    const wallet = await getActiveAgenticWallet(owner, walletId);
    if (!wallet) {
      const body = { error: "AGENTIC_WALLET_NOT_FOUND" };
      await finaliseClaim("failed", 404, body);
      return NextResponse.json(body, { status: 404 });
    }
    const agenticWalletKey = decryptPrivateKey(wallet);

    const senderAddr = OFT_CONFIG[src].sender;
    if (!senderAddr) {
      const body = { error: "OFT_NOT_DEPLOYED", chain: src, message: `Q402OftSender is not yet deployed on ${src}.` };
      await finaliseClaim("failed", 503, body);
      return NextResponse.json(body, { status: 503 });
    }

    // ── Quote + fee guard ────────────────────────────────────────────────────
    let nativeFee: bigint;
    let minAmountLD: bigint;
    try {
      const q = await quoteOftBridge(src, dst, amountRaw, wallet.address, { extraOptions: args.extraOptions });
      nativeFee = q.nativeFee;
      minAmountLD = q.minAmountLD;
    } catch (e) {
      const body = { error: "OFT_QUOTE_FAILED", detail: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
      await finaliseClaim("failed", 502, body);
      return NextResponse.json(body, { status: 502 });
    }
    const serverCap = (nativeFee * 11n) / 10n;
    const clientCap = args.clientMaxFeeRaw ?? serverCap;
    const maxFeeRaw = clientCap < serverCap ? clientCap : serverCap;
    if (nativeFee > maxFeeRaw) {
      const body = { error: "FEE_EXCEEDS_MAX", feeRaw: nativeFee.toString(), maxFeeRaw: maxFeeRaw.toString() };
      await finaliseClaim("failed", 400, body);
      return NextResponse.json(body, { status: 400 });
    }

    // ── Gas Tank gate (native only) ──────────────────────────────────────────
    const feeWhole = Number(nativeFee) / 1e18;
    const gasBal = await getGasBalance(owner);
    if ((gasBal[src] ?? 0) < feeWhole) {
      const body = {
        error: "INSUFFICIENT_NATIVE_BALANCE",
        required: feeWhole, available: gasBal[src] ?? 0, chain: src,
        message: `Your Gas Tank native balance on ${src} can't cover the LayerZero fee. Top up and retry.`,
      };
      await finaliseClaim("failed", 402, body);
      return NextResponse.json(body, { status: 402 });
    }

    // ── One-time approval-gas top-up ─────────────────────────────────────────
    // The bridge is relayer-submitted, but the Agent Wallet still signs the
    // first-ever approve(sender) itself and needs a little source-chain gas for
    // it. Top up on demand (once per wallet+chain), debited from the Gas Tank.
    try {
      const provider = getOftProvider(src);
      const senderRead = new ethers.Contract(senderAddr, OFT_SENDER_ABI, provider);
      const tokenAddr = (await senderRead.TOKEN()) as string;
      const erc20 = new ethers.Contract(tokenAddr, ["function allowance(address,address) view returns (uint256)"], provider);
      const allowance = (await erc20.allowance(wallet.address, senderAddr)) as bigint;
      if (allowance < amountRaw) {
        const [walletNative, feeData] = await Promise.all([provider.getBalance(wallet.address), provider.getFeeData()]);
        const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
        // 1.5x headroom: the RPC checks balance >= gasLimit * maxFeePerGas (the ceiling,
        // not gas actually burned), and the price can tick up between this quote and the
        // approve broadcast. Cap per chain so a cheap-native / high-gas chain isn't starved.
        let need = (APPROVAL_GAS_UNITS * gasPrice * 3n) / 2n;
        const cap = APPROVAL_FUND_CAP_WEI[src] ?? APPROVAL_FUND_CAP_WEI_DEFAULT;
        if (need > cap) need = cap;
        if (walletNative < need) {
          const shortfall = need - walletNative;
          const fundWhole = Number(shortfall) / 1e18;
          if ((gasBal[src] ?? 0) < feeWhole + fundWhole) {
            const body = {
              error: "INSUFFICIENT_NATIVE_BALANCE",
              required: feeWhole + fundWhole, available: gasBal[src] ?? 0, chain: src,
              message: `First USDT0 bridge on ${src} needs a one-time approval gas top-up plus the fee. Add a little native to your Gas Tank on ${src}.`,
            };
            await finaliseClaim("failed", 402, body);
            return NextResponse.json(body, { status: 402 });
          }
          const rk = loadRelayerKey();
          if (!rk.ok) throw new Error(`relayer key unavailable (${rk.reason})`);
          const relayer = new ethers.Wallet(rk.privateKey, provider);
          const fundTx = await relayer.sendTransaction({ to: wallet.address, value: shortfall, gasLimit: 60_000n });
          const fundReceipt = await fundTx.wait();
          if (!fundReceipt || fundReceipt.status !== 1) throw new Error(`approval-gas fund tx ${fundTx.hash} failed`);
          agentFundTxHash = fundTx.hash;
          agentFundEth = fundWhole;
          // Atomic claim+debit keyed by the fund txHash (one-time, tiny amount).
          await claimAndDebitNativeBridge(fundTx.hash, owner, src, fundWhole);
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const body = {
        error: "AGENT_WALLET_AUTOFUND_FAILED",
        detail: err.slice(0, 200),
        message: "Q402 couldn't complete the one-time approval-gas top-up. Your Gas Tank wasn't debited for the fee — retry in a moment.",
      };
      await finaliseClaim("failed", 503, body);
      return NextResponse.json(body, { status: 503 });
    }

    // ── Execute bridge (relayer submits bridgeFor) ───────────────────────────
    let result;
    try {
      result = await executeOftBridge({
        src, dst, owner: wallet.address, amountLD: amountRaw, minAmountLD,
        maxNativeFee: maxFeeRaw, agenticWalletKey, extraOptions: args.extraOptions,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isGasLow = /insufficient funds for intrinsic transaction cost|insufficient funds for gas|insufficient balance/i.test(msg);
      const body = isGasLow
        ? { error: "AGENT_WALLET_GAS_LOW", chain: src, address: wallet.address,
            ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
            message: `The one-time approval needs a little more gas on ${src}. Add a small native buffer to your Gas Tank and retry.` }
        : { error: "OFT_BRIDGE_FAILED", detail: msg.slice(0, 400),
            ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}) };
      await finaliseClaim("failed", isGasLow ? 402 : 502, body);
      return NextResponse.json(body, { status: isGasLow ? 402 : 502 });
    }

    // ── Debit the Gas Tank for the LZ fee (atomic, keyed by bridge txHash) ────
    const actualFeeWhole = Number(result.nativeFeePaid) / 1e18;
    try {
      await claimAndDebitNativeBridge(result.txHash, owner, src, actualFeeWhole);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[oft-bridge-runner] gas-tank fee debit failed (tx already mined)", { owner, src, actualFeeWhole, guid: result.guid, err });
      try {
        await setPendingFeeDebit({ txHash: result.txHash, feeToken: "native", amount: actualFeeWhole, ownerLc: owner, chain: src, submittedAt: Date.now(), messageId: result.guid });
      } catch (pendingErr) {
        console.error("[oft-bridge-runner] setPendingFeeDebit failed", { owner, src, txHash: result.txHash, err: pendingErr instanceof Error ? pendingErr.message : String(pendingErr) });
      }
      void sendOpsAlert(
        `<b>OFT fee debit failed — pending-fee-debit row written</b>\n\n` +
        `Owner: <code>${owner}</code>\nChain: ${src}\nFee owed: ${actualFeeWhole} native\n` +
        `guid: <code>${result.guid}</code>\ntxHash: <code>${result.txHash}</code>\nError: ${err.slice(0, 200)}\n\n` +
        `Cron will retry. Manual debit from bridge_native_used:${owner.toLowerCase()}.${src}.`,
        "error",
      ).catch(() => {});
    }

    // ── History ──────────────────────────────────────────────────────────────
    const histRec: OftBridgeHistoryRecord = {
      guid: result.guid, txHash: result.txHash, blockNumber: result.blockNumber,
      owner, walletId, src, dst, amount, amountReceived: result.amountReceivedLD.toString(),
      feeRaw: result.nativeFeePaid.toString(), feeWhole: actualFeeWhole, initiatedAt: Date.now(),
      ...(result.approveTxHash ? { approveTxHash: result.approveTxHash } : {}),
      ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
    };
    try {
      await Promise.all([
        kv.rpush(oftBridgeHistKey(owner), histRec),
        kv.set(oftGuidMapKey(result.guid), histRec, { ex: 30 * 24 * 60 * 60 }),
      ]);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("[oft-bridge-runner] history write failed (tx already mined)", { owner, guid: result.guid, err });
      void sendOpsAlert(`<b>OFT history write failed (tx mined)</b>\nOwner <code>${owner}</code> ${src}->${dst} guid <code>${result.guid}</code> tx <code>${result.txHash}</code>\n${err.slice(0, 200)}`, "error").catch(() => {});
    }

    const responseBody: Record<string, unknown> = {
      success: true, guid: result.guid, txHash: result.txHash, blockNumber: result.blockNumber,
      feeRaw: result.nativeFeePaid.toString(), feeWhole: actualFeeWhole,
      amountReceived: result.amountReceivedLD.toString(),
      lzScan: `${OFT_CONFIG[src].lzScan}/tx/${result.txHash}`,
      srcExplorer: `${OFT_CONFIG[src].explorer}/tx/${result.txHash}`,
      approveTxHash: result.approveTxHash,
      ...(agentFundTxHash ? { agentFundTxHash, agentFundEth } : {}),
      sendId,
    };

    // ── Permanent settled marker (AWAITED before response) ───────────────────
    try {
      await markBridgeSettled(fp, { messageId: result.guid, txHash: result.txHash, src, dst, amount, feeToken: "native", settledAt: Date.now() });
    } catch (markerErr) {
      console.error("[oft-bridge-runner] markBridgeSettled failed", { owner, fp, guid: result.guid, err: markerErr instanceof Error ? markerErr.message : String(markerErr) });
      void sendOpsAlert(`<b>OFT settled-marker write failed</b>\nfp <code>${fp}</code> guid <code>${result.guid}</code> tx <code>${result.txHash}</code>`, "error").catch(() => {});
    }

    try {
      await finaliseClaim("success", 200, responseBody);
    } catch (e) {
      console.error("[oft-bridge-runner] success-claim finalisation failed (tx already mined)", { owner, guid: result.guid, sendId, err: e instanceof Error ? e.message : String(e) });
    }

    return NextResponse.json(responseBody, { status: 200 });
  } finally {
    await releaseLock();
  }
}
