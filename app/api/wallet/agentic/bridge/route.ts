/**
 * POST /api/wallet/agentic/bridge
 *
 * Mode C (server-managed Agentic Wallet) — API-key authenticated CCIP
 * bridge entry. Mirrors `/api/ccip/send` but accepts an `apiKey` instead
 * of an owner EIP-712 signature. Same destination: hand off to
 * `runCCIPBridge` from `app/lib/ccip-bridge-runner.ts`.
 *
 * Why this exists: the MCP `q402_bridge_send` tool runs in clients
 * (Claude Desktop / Codex CLI / Cursor / Cline) that cannot trigger a
 * MetaMask popup to sign the `ccip.bridge` intent. Mode C users have a
 * Multichain API key + a server-managed Agent Wallet, so the API key
 * IS the user's authorization — same trust model as
 * `/api/wallet/agentic/send`. This route lets that user bridge from
 * the MCP without falling back to the dashboard.
 *
 * Body:
 *   apiKey       — q402_live_… (NOT q402_test_…; sandbox keys rejected)
 *   walletId?    — optional Agent Wallet id; defaults to the owner's default wallet
 *   src          — eth | avax | arbitrum
 *   dst          — eth | avax | arbitrum (MUST differ from src)
 *   amount       — raw 6-decimal USDC string
 *   feeToken?    — "LINK" (default) | "native"
 *   maxFeeRaw?   — optional client-side fee cap (raw 18-dec). The
 *                  runner still clamps to its server-side 10% ceiling.
 *
 * Auth + scope:
 *   - rate-limit 6 req/min per IP (same as /api/ccip/send)
 *   - apiKey must exist + be active + NOT a sandbox key
 *   - The owner the apiKey resolves to MUST have a Multichain subscription
 *     (`hasMultichainScope`) — same trial-bypass guard the owner-sig
 *     route enforces. A trial key never reaches this route because the
 *     "not q402_test_" check + apiKey record lookup would 401 the
 *     trial-tier key (no Multichain scope on its plan).
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  isCCIPChain,
  CCIP_CONFIG,
  type CCIPChainKey,
  type FeeTokenKind,
} from "@/app/lib/ccip";
import {
  getApiKeyRecord,
  getSubscription,
  hasMultichainScope,
} from "@/app/lib/db";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import { runCCIPBridge } from "@/app/lib/ccip-bridge-runner";

export const runtime = "nodejs";
export const maxDuration = 60;

interface BridgeBody {
  apiKey?:    string;
  walletId?:  string;
  src?:       string;
  dst?:       string;
  amount?:    string;
  feeToken?:  string;
  maxFeeRaw?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-bridge-send", 6, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: BridgeBody;
  try {
    body = (await req.json()) as BridgeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Body validation ─────────────────────────────────────────────────────
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
  if (BigInt(body.amount) === 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }
  // Validate maxFeeRaw shape BEFORE BigInt() — `BigInt("abc")` would
  // throw SyntaxError uncaught and return a 500 instead of a clean
  // 400. Integer string only (raw 18-dec wei).
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

  // ── API key auth ────────────────────────────────────────────────────────
  if (!body.apiKey || typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json(
      { error: "AUTH_REQUIRED", message: "Provide a live apiKey (q402_live_…)." },
      { status: 401 },
    );
  }
  // Reject both modern (`q402_test_`) AND legacy (`q402_sandbox_`)
  // sandbox prefixes — db.ts still treats both as sandbox in the
  // transaction-iteration path, so a paid-owner-attached legacy
  // q402_sandbox_ key that's still active would otherwise hit this
  // live bridge route. Matches recurring-by-key's posture; the send
  // route was patched in the same audit batch.
  if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
    return NextResponse.json(
      { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for Agent Wallet bridges." },
      { status: 401 },
    );
  }
  const rec = await getApiKeyRecord(body.apiKey);
  if (!rec || !rec.active) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  // ── Subscription gate — bridging is Multichain-only ─────────────────────
  // Trial-tier keys resolve to a subscription without Multichain scope
  // (or none at all), so this is the same gate the owner-sig route
  // enforces. Without it, the Mode C path would be a free-bridge backdoor
  // around the paid-only requirement.
  const sub = await getSubscription(owner);
  if (!hasMultichainScope(sub)) {
    return NextResponse.json(
      {
        error: "SUBSCRIPTION_REQUIRED",
        message:
          "Cross-chain CCIP bridging requires an active Multichain subscription. " +
          "If you have a trial key, switch to a Multichain key (q402.quackai.ai/payment).",
      },
      { status: 402 },
    );
  }

  // ── Resolve Agent Wallet ────────────────────────────────────────────────
  // Mode C accepts an explicit walletId OR falls back to the owner's
  // default. resolveWallet refuses cross-owner reads, so a leaked
  // walletId from a different owner can't be used to bridge their
  // wallet (the apiKey owner check above already binds the request).
  const wallet = await resolveWallet(owner, body.walletId ?? null);
  if (!wallet) {
    return NextResponse.json(
      { error: "AGENTIC_WALLET_NOT_FOUND", message: "No Agent Wallet found for this apiKey owner." },
      { status: 404 },
    );
  }
  // walletId is the lower-cased Agent Wallet address (per agentic-wallet
  // schema). The record itself doesn't carry a separate walletId field.
  const walletId = wallet.address.toLowerCase();

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
