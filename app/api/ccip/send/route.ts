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
  type CCIPChainKey,
  type FeeTokenKind,
} from "@/app/lib/ccip";
import {
  getLinkBalance,
  recordLinkUsage,
  getGasBalance,
  recordNativeBridgeUsage,
  getSubscription,
  hasMultichainScope,
} from "@/app/lib/db";

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
      const body: Record<string, unknown> = {
        error: "CCIP_BRIDGE_FAILED",
        detail: msg.slice(0, 400),
      };
      await finaliseClaim("failed", 502, body);
      return NextResponse.json(body, { status: 502 });
    }

    // ── KV updates (debit Gas Tank + record history) ────────────────────
    // Tolerate KV write failures here: the on-chain tx already mined, so
    // the user owes the fee. Logging the failure + writing the history
    // record afterwards is best-effort — the idempotency claim still
    // carries the messageId so a retry can re-debit if the first attempt
    // truly dropped on the floor.
    const actualFeeWhole = Number(result.feeRaw) / 1e18;
    try {
      if (feeToken === "LINK") {
        await recordLinkUsage(owner, src, actualFeeWhole);
      } else {
        await recordNativeBridgeUsage(owner, src, actualFeeWhole);
      }
    } catch (e) {
      console.error("[ccip/send] gas-tank debit failed (on-chain tx already mined)", {
        owner,
        src,
        messageId: result.messageId,
        err: e instanceof Error ? e.message : String(e),
      });
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
    };
    try {
      await Promise.all([
        kv.rpush(bridgeHistKey(owner), histRec),
        kv.set(messageIdMapKey(result.messageId), histRec, { ex: 30 * 24 * 60 * 60 }), // 30d TTL
      ]);
    } catch (e) {
      console.error("[ccip/send] history write failed (on-chain tx already mined)", {
        owner,
        messageId: result.messageId,
        err: e instanceof Error ? e.message : String(e),
      });
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
      sendId,
    };
    await finaliseClaim("success", 200, responseBody);
    return NextResponse.json(responseBody);
  } finally {
    await releaseLock();
  }
}
