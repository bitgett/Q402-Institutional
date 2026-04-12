import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { checkPaymentOnChain, planFromAmount, txQuotaFromAmount } from "@/app/lib/blockchain";
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

  // ── Verify on-chain payment ───────────────────────────────────────────────
  // Note: no early return for already_active — users can top up at any time.
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

  const newCredits = txQuotaFromAmount(result.amountUSD ?? 0, result.chain);
  if (newCredits === 0) {
    return NextResponse.json({ error: "Payment amount too low for this chain" }, { status: 402 });
  }

  if (!existing) {
    // ── First payment: set plan tier + TX credits + 30-day period ─────────
    const plan = planFromAmount(result.amountUSD ?? 0, result.chain)!;

    const apiKey = await generateApiKey(addr, plan);
    await setSubscription(addr, {
      paidAt:     new Date().toISOString(),
      apiKey,
      plan,
      txHash:     result.txHash!,
      amountUSD:  result.amountUSD!,
      quotaBonus: newCredits,
    });
    return NextResponse.json({ status: "activated", plan, txCredits: newCredits });

  } else {
    // ── Additional payment: add credits + extend 30 days (plan unchanged) ─
    const plan = existing.plan; // keep existing plan tier

    // Restore API key if it was deactivated
    let apiKey = existing.apiKey;
    if (apiKey) {
      const { getApiKeyRecord } = await import("@/app/lib/db");
      const rec = await getApiKeyRecord(apiKey);
      if (!rec || !rec.active) {
        apiKey = await generateApiKey(addr, plan);
      }
    } else {
      apiKey = await generateApiKey(addr, plan);
    }

    // Extend from current expiry if still active, otherwise from now
    const currentExpiry = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    const base = currentExpiry > new Date() ? currentExpiry : new Date();

    const addedCredits = newCredits;
    const totalCredits = (existing.quotaBonus ?? 0) + addedCredits;

    await setSubscription(addr, {
      ...existing,
      paidAt:     base.toISOString(),
      apiKey,
      txHash:     result.txHash!,
      amountUSD:  result.amountUSD!,
      quotaBonus: totalCredits,
    });
    return NextResponse.json({
      status:        "credits_added",
      plan,
      txCredits:     totalCredits,
      addedCredits,
      expiresAt:     new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
}
