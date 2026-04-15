import { NextRequest, NextResponse } from "next/server";
import { checkPaymentOnChain, planFromAmount, txQuotaFromAmount } from "@/app/lib/blockchain";
import { getSubscription, setSubscription, generateApiKey, generateSandboxKey } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { getPaymentIntent, clearPaymentIntent } from "@/app/api/payment/intent/route";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/payment/activate
 *
 * Scans the blockchain for an on-chain USDC/USDT payment from `address`,
 * then activates a subscription and issues a live API key.
 *
 * Requires nonce-based EIP-191 proof-of-ownership to prevent address spoofing.
 * Validates the found TX against the payment intent (chain + expectedUSD) recorded
 * by POST /api/payment/intent before the user sent the on-chain transaction.
 *
 * Body: { address, nonce, signature }
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 */

export async function POST(req: NextRequest) {
  // ── Rate limit: 5 activation attempts / 60 s per IP ──────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "activate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; nonce?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Verify wallet ownership ───────────────────────────────────────────────
  const authResult = await requireAuth(body.address, body.nonce, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const existing = await getSubscription(addr);

  // ── Verify payment intent (chain + expectedUSD must match TX) ───────────
  const intent = await getPaymentIntent(addr);
  if (!intent) {
    return NextResponse.json(
      { error: "No payment intent found. Call POST /api/payment/intent first.", code: "NO_INTENT" },
      { status: 402 },
    );
  }

  // ── Verify on-chain payment ───────────────────────────────────────────────
  // Note: no early return for already_active — users can top up at any time.
  const result = await checkPaymentOnChain(addr, intent.chain);
  if (!result.found) {
    return NextResponse.json({ error: "No payment found on-chain" }, { status: 402 });
  }

  // ── Validate TX matches intent ────────────────────────────────────────────
  // result.chain is full name ("BNB Chain"), intent.chain is short id ("bnb")
  // Since we already filtered the scan to intent.chain, this is a belt-and-suspenders check
  if (result.chain) {
    const CHAIN_NAME_MAP: Record<string, string> = {
      bnb: "BNB Chain", eth: "Ethereum", avax: "Avalanche", xlayer: "X Layer", stable: "Stable",
    };
    const expectedName = CHAIN_NAME_MAP[intent.chain];
    if (expectedName && result.chain !== expectedName) {
      return NextResponse.json(
        { error: `Payment found on ${result.chain} but intent was for ${intent.chain}`, code: "CHAIN_MISMATCH" },
        { status: 402 },
      );
    }
  }
  // Allow 5% tolerance on USD amount (price feed drift)
  const minExpected = intent.expectedUSD * 0.95;
  if ((result.amountUSD ?? 0) < minExpected) {
    return NextResponse.json(
      { error: `Payment amount $${result.amountUSD} is less than intended $${intent.expectedUSD}`, code: "AMOUNT_LOW" },
      { status: 402 },
    );
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

  const addedTxs = txQuotaFromAmount(result.amountUSD ?? 0, result.chain);
  if (addedTxs === 0) {
    return NextResponse.json({ error: "Payment amount too low for this chain" }, { status: 402 });
  }

  // ── Every payment: +30 days + TX transactions, plan set on first payment ─
  const plan = existing?.plan ?? planFromAmount(result.amountUSD ?? 0, result.chain)!;

  // Restore or create live API key
  let apiKey = existing?.apiKey ?? null;
  if (apiKey) {
    const { getApiKeyRecord } = await import("@/app/lib/db");
    const rec = await getApiKeyRecord(apiKey);
    if (!rec || !rec.active) apiKey = await generateApiKey(addr, plan);
  } else {
    apiKey = await generateApiKey(addr, plan);
  }

  // Ensure sandbox key exists
  let sandboxApiKey = existing?.sandboxApiKey ?? null;
  if (!sandboxApiKey) {
    sandboxApiKey = await generateSandboxKey(addr, plan);
  }

  // Extend from current expiry if still active, otherwise from now
  const currentExpiry = existing
    ? new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000)
    : new Date(0);
  const base = currentExpiry > new Date() ? currentExpiry : new Date();
  const newExpiry = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
  const totalTxs = (existing?.quotaBonus ?? 0) + addedTxs;

  await setSubscription(addr, {
    ...(existing ?? {}),
    paidAt:        base.toISOString(),
    apiKey,
    sandboxApiKey,
    plan,
    txHash:        result.txHash!,
    amountUSD:     result.amountUSD!,
    quotaBonus:    totalTxs,
  });

  // Clear intent after successful activation — prevents replay
  await clearPaymentIntent(addr);

  return NextResponse.json({
    status:    "activated",
    plan,
    addedTxs,
    totalTxs,
    expiresAt: newExpiry.toISOString(),
  });
}
