/**
 * POST /api/oft/send
 *
 * Owner-EIP-712-intent-bound USDT0 (LayerZero OFT) bridge entry — the dashboard
 * path. Companion to /api/ccip/send (USDC). The Mode C API-key path is
 * /api/wallet/agentic/oft-bridge; both hand off to the same runOftBridge, so the
 * money-flow invariants live in one place.
 *
 *   1. Validate the bridge intent body.
 *   2. Verify the owner signed exactly this intent (action="oft.bridge").
 *   3. Subscription gate (Multichain only).
 *   4. Hand off to runOftBridge.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireIntentAuth } from "@/app/lib/auth";
import { isChainDisabled, CHAIN_DISABLED_MESSAGE } from "@/app/lib/chain-status";
import { isOftChain, isOftLane, OFT_CONFIG, type OftChainKey } from "@/app/lib/usdt0";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { runOftBridge } from "@/app/lib/oft-bridge-runner";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SendBody {
  address?: string;
  nonce?: string;
  signature?: string;
  walletId?: string;
  src?: string;
  dst?: string;
  amount?: string;
  maxFeeRaw?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "oft-bridge-send", 6, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.src || !isOftChain(body.src)) {
    return NextResponse.json({ error: "src must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  if (!body.dst || !isOftChain(body.dst)) {
    return NextResponse.json({ error: "dst must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  const src = body.src as OftChainKey;
  const dst = body.dst as OftChainKey;
  if (src === dst) return NextResponse.json({ error: "src and dst must differ" }, { status: 400 });
  if (!isOftLane(src, dst)) return NextResponse.json({ error: `Lane ${src} -> ${dst} is not a supported USDT0 route` }, { status: 400 });
  if (isChainDisabled(src) || isChainDisabled(dst)) {
    return NextResponse.json({ error: CHAIN_DISABLED_MESSAGE }, { status: 400 });
  }
  if (!body.amount || !/^\d+$/.test(body.amount)) {
    return NextResponse.json({ error: "amount must be a non-negative integer string (raw local-decimal USDT0)" }, { status: 400 });
  }
  if (BigInt(body.amount) === 0n) return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  if (body.maxFeeRaw !== undefined && (typeof body.maxFeeRaw !== "string" || !/^\d+$/.test(body.maxFeeRaw))) {
    return NextResponse.json({ error: "maxFeeRaw must be a non-negative integer string (raw 18-dec wei)" }, { status: 400 });
  }
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId is required" }, { status: 400 });
  }

  if (!OFT_CONFIG[src].sender) {
    return NextResponse.json({
      error: "OFT_SENDER_NOT_DEPLOYED",
      detail: `Q402OftSender not yet deployed on ${src}.`,
    }, { status: 503 });
  }

  // ── Intent-bound auth — binds owner + walletId + src + dst + amount ─────
  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "oft.bridge",
    intent: {
      walletId: body.walletId.toLowerCase(),
      src,
      dst,
      amount: body.amount,
      // Bind the fee cap into the signature so a tampered/MITM'd request can't swap in
      // a different maxFeeRaw than the owner saw (empty = no client cap -> server ceiling).
      maxFeeRaw: body.maxFeeRaw ?? "",
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
  }
  const owner = authResult;
  const walletId = body.walletId.toLowerCase();

  const sub = await getSubscription(owner);
  if (!hasMultichainScope(sub)) {
    return NextResponse.json({
      error: "SUBSCRIPTION_REQUIRED",
      message: "Cross-chain USDT0 bridging requires an active Multichain subscription.",
    }, { status: 402 });
  }

  return runOftBridge({
    owner,
    walletId,
    src,
    dst,
    amount: body.amount,
    clientMaxFeeRaw: body.maxFeeRaw ? BigInt(body.maxFeeRaw) : undefined,
  });
}
