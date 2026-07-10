/**
 * POST /api/wallet/agentic/oft-bridge
 *
 * Mode C (server-managed Agent Wallet) — API-key authenticated USDT0 (LayerZero
 * OFT) bridge entry. Companion to /api/wallet/agentic/bridge (USDC/CCIP). Same
 * trust model: the live Multichain apiKey IS the user's authorization. Hands off
 * to runOftBridge.
 *
 * Body:
 *   apiKey       — q402_live_… (sandbox keys rejected)
 *   walletId?    — optional Agent Wallet id; defaults to the owner's default wallet
 *   src          — eth | arbitrum | mantle | monad | xlayer
 *   dst          — one of the above (MUST differ from src, must be a live lane)
 *   amount       — raw local-decimal USDT0 string
 *   maxFeeRaw?   — optional client-side native fee cap (raw 18-dec wei); the runner
 *                  still clamps to its server-side 10% ceiling
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { isOftChain, isOftLane, OFT_CONFIG, type OftChainKey } from "@/app/lib/usdt0";
import { getApiKeyRecord, getSubscription, hasMultichainScope } from "@/app/lib/db";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import { runOftBridge } from "@/app/lib/oft-bridge-runner";

export const runtime = "nodejs";
export const maxDuration = 60;

interface OftBridgeBody {
  apiKey?: string;
  walletId?: string;
  src?: string;
  dst?: string;
  amount?: string;
  maxFeeRaw?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-oft-bridge-send", 6, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: OftBridgeBody;
  try {
    body = (await req.json()) as OftBridgeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Body validation ─────────────────────────────────────────────────────
  if (!body.src || !isOftChain(body.src)) {
    return NextResponse.json({ error: "src must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  if (!body.dst || !isOftChain(body.dst)) {
    return NextResponse.json({ error: "dst must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  const src = body.src as OftChainKey;
  const dst = body.dst as OftChainKey;
  if (src === dst) {
    return NextResponse.json({ error: "src and dst must differ" }, { status: 400 });
  }
  if (!isOftLane(src, dst)) {
    return NextResponse.json({ error: `Lane ${src} -> ${dst} is not a supported USDT0 route` }, { status: 400 });
  }
  if (!body.amount || !/^\d+$/.test(body.amount)) {
    return NextResponse.json({ error: "amount must be a non-negative integer string (raw local-decimal USDT0)" }, { status: 400 });
  }
  if (BigInt(body.amount) === 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }
  if (body.maxFeeRaw !== undefined && (typeof body.maxFeeRaw !== "string" || !/^\d+$/.test(body.maxFeeRaw))) {
    return NextResponse.json({ error: "maxFeeRaw must be a non-negative integer string (raw 18-dec wei)" }, { status: 400 });
  }

  // ── Sender contract must be deployed ────────────────────────────────────
  if (!OFT_CONFIG[src].sender) {
    return NextResponse.json({
      error: "OFT_SENDER_NOT_DEPLOYED",
      detail: `Q402OftSender not yet deployed on ${src}. USDT0 bridge disabled here until the manifest carries the deployed address.`,
    }, { status: 503 });
  }

  // ── API key auth ────────────────────────────────────────────────────────
  if (!body.apiKey || typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json({ error: "AUTH_REQUIRED", message: "Provide a live apiKey (q402_live_…)." }, { status: 401 });
  }
  if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
    return NextResponse.json({ error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for Agent Wallet bridges." }, { status: 401 });
  }
  const rec = await getApiKeyRecord(body.apiKey);
  if (!rec || !rec.active) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  // ── Subscription gate — bridging is Multichain-only ─────────────────────
  const sub = await getSubscription(owner);
  if (!hasMultichainScope(sub)) {
    return NextResponse.json({
      error: "SUBSCRIPTION_REQUIRED",
      message: "Cross-chain USDT0 bridging requires an active Multichain subscription (q402.quackai.ai/payment).",
    }, { status: 402 });
  }
  if (body.apiKey !== sub?.apiKey) {
    return NextResponse.json({
      error: "STALE_API_KEY",
      message: "This apiKey is not the live multichain key (or it's a trial key). Rotate to the current key and retry.",
    }, { status: 401 });
  }

  // ── Resolve Agent Wallet ────────────────────────────────────────────────
  const wallet = await resolveWallet(owner, body.walletId ?? null);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND", message: "No Agent Wallet found for this apiKey owner." }, { status: 404 });
  }
  const walletId = wallet.address.toLowerCase();

  return runOftBridge({
    owner,
    walletId,
    src,
    dst,
    amount: body.amount,
    clientMaxFeeRaw: body.maxFeeRaw ? BigInt(body.maxFeeRaw) : undefined,
  });
}
