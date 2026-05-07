import { NextRequest, NextResponse } from "next/server";
import { getSubscription, setSubscription, generateSandboxKey } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { isOwnerWallet } from "@/app/lib/owners";

/**
 * POST /api/keys/provision
 *
 * Returns the API keys for the caller's wallet address, creating them if needed.
 * Requires nonce-based EIP-191 proof-of-ownership to prevent address spoofing.
 *
 * Body: { address, nonce, signature }
 *   signature = personal_sign(
 *     "Q402 Auth\nAddress: {addr}\nNonce: {nonce}",
 *     address
 *   )
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 *
 * NEW accounts receive a sandbox key only.
 * Live API key is issued only after on-chain payment via /api/payment/activate.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "provision", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; nonce?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const authResult = await requireAuth(body.address, body.nonce, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  // ── Existing account ──────────────────────────────────────────────────────
  const existing = await getSubscription(addr);
  if (existing) {
    // Ensure sandbox key exists (may be missing on very old accounts)
    if (!existing.sandboxApiKey) {
      const sandboxApiKey = await generateSandboxKey(addr, existing.plan);
      await setSubscription(addr, { ...existing, sandboxApiKey });
      existing.sandboxApiKey = sandboxApiKey;
    }

    const isPaid = (existing.amountUSD ?? 0) > 0 && !!existing.apiKey;
    return NextResponse.json({
      // Live key only returned for accounts that have actually paid
      apiKey:         isPaid ? existing.apiKey : null,
      sandboxApiKey:  existing.sandboxApiKey,
      plan:           existing.plan,
      hasPaid:        isPaid,
      isOwner:        isOwnerWallet(addr),
      quotaBonus:     existing.quotaBonus ?? 0,
      paidAt:         existing.paidAt,
      isNew:          false,
    });
  }

  // ── New account — sandbox key only ────────────────────────────────────────
  // Live key is issued only after a verified on-chain payment (activate route).
  // amountUSD: 0 → hasPaid: false → relay credit check blocks live relay.
  // paidAt: ""  → expiry check skipped for this account.
  const sandboxApiKey = await generateSandboxKey(addr, "starter");
  await setSubscription(addr, {
    paidAt:       "",
    apiKey:       "",        // no live key until payment
    sandboxApiKey,
    plan:         "starter",
    txHash:       "provisioned",
    amountUSD:    0,
  });

  return NextResponse.json({
    apiKey:        null,
    sandboxApiKey,
    plan:          "starter",
    hasPaid:       false,
    isOwner:       isOwnerWallet(addr),
    isNew:         true,
    quotaBonus:    0,
    paidAt:        "",
  });
}
