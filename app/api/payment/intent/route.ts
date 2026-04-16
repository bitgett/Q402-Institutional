import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { randomBytes } from "crypto";
import { intentKey } from "@/app/lib/payment-intent";

/**
 * POST /api/payment/intent
 *
 * Records what the user INTENDS to pay before they send the on-chain transaction.
 * /api/payment/activate validates the found TX against this intent, preventing:
 *   - Wrong-chain activations (BNB TX activating on ETH subscription)
 *   - Accidental activation from unrelated transfers
 *   - Sender mismatch (someone else's TX activating your subscription)
 *
 * Body: { address, nonce, signature, chain, expectedUSD, token? }
 *   token: "USDC" | "USDT" | "USDT0" (optional — used for cross-check in activate)
 *
 * Intent is stored for 2 hours (enough time to send TX + verify).
 * Only one active intent per address — overwritten when plan selection changes.
 */

const INTENT_TTL = 2 * 60 * 60; // 2 hours

const VALID_CHAINS = ["bnb", "avax", "eth", "xlayer", "stable"];
const VALID_TOKENS = ["USDC", "USDT", "USDT0"];


export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "payment-intent", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: {
    address?: string;
    nonce?: string;
    signature?: string;
    chain?: string;
    expectedUSD?: number;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { address, nonce, signature, chain, expectedUSD, token } = body;

  // Verify ownership
  const authResult = await requireAuth(address, nonce, signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  if (!chain || !VALID_CHAINS.includes(chain)) {
    return NextResponse.json(
      { error: `chain must be one of: ${VALID_CHAINS.join(", ")}` },
      { status: 400 },
    );
  }

  if (typeof expectedUSD !== "number" || expectedUSD <= 0) {
    return NextResponse.json({ error: "expectedUSD must be a positive number" }, { status: 400 });
  }

  // token is optional — if provided, activate will cross-check
  if (token !== undefined && !VALID_TOKENS.includes(token)) {
    return NextResponse.json(
      { error: `token must be one of: ${VALID_TOKENS.join(", ")}` },
      { status: 400 },
    );
  }

  const intentId = randomBytes(8).toString("hex");
  const intent = {
    intentId,
    chain,
    expectedUSD,
    token: token ?? null,   // null = any token accepted
    address: addr,
    createdAt: new Date().toISOString(),
  };

  await kv.set(intentKey(addr), intent, { ex: INTENT_TTL });

  return NextResponse.json({ intentId, chain, expectedUSD, token: token ?? null, expiresIn: INTENT_TTL });
}

