import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { randomBytes } from "crypto";

/**
 * POST /api/payment/intent
 *
 * Records what the user INTENDS to pay before they send the on-chain transaction.
 * /api/payment/activate validates the found TX against this intent, preventing:
 *   - Wrong-chain activations (BNB TX activating on ETH subscription)
 *   - Accidental activation from unrelated transfers
 *
 * Body: { address, nonce, signature, chain, expectedUSD }
 *
 * Intent is stored for 2 hours (enough time to send TX + verify).
 * Only one active intent per address — overwritten when plan selection changes.
 */

const INTENT_TTL = 2 * 60 * 60; // 2 hours

const VALID_CHAINS = ["bnb", "avax", "eth", "xlayer", "stable"];

function intentKey(addr: string) {
  return `payment_intent:${addr.toLowerCase()}`;
}

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
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { address, nonce, signature, chain, expectedUSD } = body;

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

  const intentId = randomBytes(8).toString("hex");
  const intent = {
    intentId,
    chain,
    expectedUSD,
    address: addr,
    createdAt: new Date().toISOString(),
  };

  await kv.set(intentKey(addr), intent, { ex: INTENT_TTL });

  return NextResponse.json({ intentId, chain, expectedUSD, expiresIn: INTENT_TTL });
}

/** Internal: read intent for an address (used by activate route). */
export async function getPaymentIntent(addr: string) {
  return kv.get<{
    intentId: string;
    chain: string;
    expectedUSD: number;
    address: string;
    createdAt: string;
  }>(intentKey(addr));
}

/** Internal: delete intent after successful activation. */
export async function clearPaymentIntent(addr: string) {
  await kv.del(intentKey(addr));
}
