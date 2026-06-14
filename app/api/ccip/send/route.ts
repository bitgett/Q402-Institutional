/**
 * POST /api/ccip/send
 *
 * Owner-EIP-712-intent-bound bridge entry. The actual bridge execution
 * lives in `app/lib/ccip-bridge-runner.ts` and is shared with the Mode C
 * API-key route at `/api/wallet/agentic/bridge`. This route's job:
 *
 *   1. Parse + validate the bridge intent body
 *   2. Verify the owner signed exactly this intent (action="ccip.bridge")
 *   3. Subscription gate (Multichain only)
 *   4. Hand off to runCCIPBridge
 *
 * Everything past auth — idempotency, lock, wallet lookup, quote, gas
 * tank, auto-fund, delegation gate, executeBridge, debit, history — is
 * in the runner. Keeping the money-flow invariants in one place is the
 * whole point.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireIntentAuth } from "@/app/lib/auth";
import { isChainDisabled, CHAIN_DISABLED_MESSAGE } from "@/app/lib/chain-status";
import {
  isCCIPChain,
  CCIP_CONFIG,
  type CCIPChainKey,
  type FeeTokenKind,
} from "@/app/lib/ccip";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { runCCIPBridge } from "@/app/lib/ccip-bridge-runner";

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
  // Held chains (chain-status.ts) — refuse a bridge whose src or dst is held.
  if (isChainDisabled(src) || isChainDisabled(dst)) {
    return NextResponse.json({ error: CHAIN_DISABLED_MESSAGE }, { status: 400 });
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
  // Validate maxFeeRaw shape BEFORE BigInt() — `BigInt("abc")` throws
  // SyntaxError uncaught and returns a 500 to the user instead of a
  // clean 400. The fee cap is raw 18-dec wei; integer string only.
  if (body.maxFeeRaw !== undefined && (typeof body.maxFeeRaw !== "string" || !/^\d+$/.test(body.maxFeeRaw))) {
    return NextResponse.json({ error: "maxFeeRaw must be a non-negative integer string (raw 18-dec wei)" }, { status: 400 });
  }
  const feeToken: FeeTokenKind = body.feeToken === "native" ? "native" : "LINK";

  // ── Sender contract must be deployed ────────────────────────────────────
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

  return runCCIPBridge({
    owner,
    walletId,
    src,
    dst,
    amount: body.amount,
    feeToken,
    clientMaxFeeRaw: body.maxFeeRaw ? BigInt(body.maxFeeRaw) : undefined,
  });
}
