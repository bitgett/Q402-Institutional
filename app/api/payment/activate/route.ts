import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { checkPaymentOnChain, planFromAmount } from "@/app/lib/blockchain";
import { getSubscription, setSubscription, generateApiKey } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/payment/activate
 *
 * Scans the blockchain for an on-chain USDC/USDT payment from `address`,
 * then activates a subscription and issues an API key.
 *
 * Requires a personal_sign proof-of-ownership signature identical to
 * /api/keys/provision — prevents an attacker from triggering key rotation
 * on behalf of another address.
 *
 * Body: { address: string, signature: string }
 */

// Shared with provision — same proof-of-ownership message
const ACTIVATE_MSG = (addr: string) =>
  `Q402 API Key Request\nAddress: ${addr.toLowerCase()}`;

export async function POST(req: NextRequest) {
  // ── Rate limit: 5 activation attempts / 60 s per IP ──────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "activate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { address, signature } = body;
  if (!address || !signature) {
    return NextResponse.json({ error: "address and signature required" }, { status: 400 });
  }

  const addr = address.toLowerCase();

  // ── Verify wallet ownership ───────────────────────────────────────────────
  try {
    const recovered = ethers.verifyMessage(ACTIVATE_MSG(addr), signature);
    if (recovered.toLowerCase() !== addr) {
      return NextResponse.json({ error: "Signature does not match address" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const existing = await getSubscription(addr);

  // ── Already activated and not expired? ───────────────────────────────────
  if (existing) {
    const expiresAt = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    if (new Date() < expiresAt) {
      return NextResponse.json({ status: "already_active", plan: existing.plan });
    }
  }

  // ── Verify on-chain payment ───────────────────────────────────────────────
  const result = await checkPaymentOnChain(addr);
  if (!result.found) {
    return NextResponse.json({ error: "No payment found on-chain" }, { status: 402 });
  }

  // ── Prevent TX hash reuse (same TX cannot activate twice) ────────────────
  const { kv } = await import("@vercel/kv");
  const usedKey = `used_txhash:${result.txHash}`;
  const alreadyUsed = await kv.get(usedKey);
  if (alreadyUsed) {
    return NextResponse.json({ error: "This transaction has already been used for activation" }, { status: 402 });
  }
  // Mark as used for 90 days (well beyond any block scan window)
  await kv.set(usedKey, addr, { ex: 90 * 24 * 60 * 60 });

  const plan = planFromAmount(result.amountUSD ?? 0);
  if (!plan) {
    return NextResponse.json({ error: "Payment amount too low" }, { status: 402 });
  }

  // ── Renew: keep existing API key to avoid breaking integrations ───────────
  // Only generate a new key if the account has no key at all.
  let apiKey = existing?.apiKey ?? null;
  if (apiKey) {
    // Re-activate the existing key in case it was deactivated
    const { getApiKeyRecord } = await import("@/app/lib/db");
    const rec = await getApiKeyRecord(apiKey);
    if (!rec || !rec.active) {
      // Key was deactivated (e.g. manually rotated) — issue fresh one
      apiKey = await generateApiKey(addr, plan);
    }
  } else {
    apiKey = await generateApiKey(addr, plan);
  }

  // Extend from current expiry if renewing early, otherwise from now
  let newPaidAt: string;
  if (existing) {
    const currentExpiry = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    const base = currentExpiry > new Date() ? currentExpiry : new Date();
    newPaidAt = base.toISOString();
  } else {
    newPaidAt = new Date().toISOString();
  }

  await setSubscription(addr, {
    ...(existing ?? {}),
    paidAt:    newPaidAt,
    apiKey,
    plan,
    txHash:    result.txHash!,
    amountUSD: result.amountUSD!,
  });

  return NextResponse.json({ status: "activated", plan });
}
