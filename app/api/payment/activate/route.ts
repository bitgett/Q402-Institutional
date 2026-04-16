import { NextRequest, NextResponse } from "next/server";
import { checkPaymentOnChain, verifyPaymentTx } from "@/app/lib/blockchain";
import { getSubscription, setSubscription, generateApiKey, generateSandboxKey, getQuotaCredits, addCredits } from "@/app/lib/db";
import { requireFreshAuth } from "@/app/lib/auth";
import { getPaymentIntent, clearPaymentIntent } from "@/app/lib/payment-intent";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/payment/activate
 *
 * Scans the blockchain for an on-chain USDC/USDT payment from `address`,
 * then activates a subscription and issues a live API key.
 *
 * Requires a fresh one-time challenge (GET /api/auth/challenge) to prevent replay.
 * Validates the found TX against the payment intent (chain + expectedUSD) recorded
 * by POST /api/payment/intent before the user sent the on-chain transaction.
 *
 * Body: { address, challenge, signature }
 *   challenge obtained from GET /api/auth/challenge?address={addr}
 */

export async function POST(req: NextRequest) {
  // ── Rate limit: 5 activation attempts / 60 s per IP ──────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "activate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; challenge?: string; signature?: string; txHash?: string; intentId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Verify wallet ownership (fresh one-time challenge) ────────────────────
  const authResult = await requireFreshAuth(body.address, body.challenge, body.signature);
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

  // If the client passed the intentId it received from POST /api/payment/intent,
  // validate it matches — catches stale tabs that have a different quote open.
  if (body.intentId && intent.intentId !== body.intentId) {
    return NextResponse.json(
      { error: "Intent ID mismatch. Your quote may have changed — please refresh and try again.", code: "INTENT_MISMATCH" },
      { status: 409 },
    );
  }

  // ── Verify on-chain payment ───────────────────────────────────────────────
  // If the client provided a txHash, use direct single-TX verification (deterministic).
  // Otherwise fall back to block-window scan (handles wallets that don't expose txHash).
  const clientTxHash = typeof body.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)
    ? body.txHash
    : null;

  const result = clientTxHash
    ? await verifyPaymentTx(clientTxHash, addr)
    : await checkPaymentOnChain(addr, intent.chain);

  if (!result.found) {
    return NextResponse.json(
      { error: clientTxHash ? "Transaction not found or does not match your address" : "No payment found on-chain" },
      { status: 402 },
    );
  }

  // ── Validate TX matches intent ────────────────────────────────────────────

  // 1. Sender must be the authenticated address (prevents using someone else's TX)
  if (result.from && result.from.toLowerCase() !== addr) {
    return NextResponse.json(
      { error: "TX sender does not match your address", code: "SENDER_MISMATCH" },
      { status: 402 },
    );
  }

  // 2. Chain must match (belt-and-suspenders — scan was already filtered by intentChain)
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

  // 3. Token must match if specified in intent
  if (intent.token && result.token && result.token !== intent.token) {
    return NextResponse.json(
      { error: `Payment was in ${result.token} but intent specified ${intent.token}`, code: "TOKEN_MISMATCH" },
      { status: 402 },
    );
  }

  // 4. Amount: allow 5% tolerance (price feed drift / fee deduction)
  const minExpected = intent.expectedUSD * 0.95;
  if ((result.amountUSD ?? 0) < minExpected) {
    return NextResponse.json(
      { error: `Payment amount $${result.amountUSD} is less than intended $${intent.expectedUSD}`, code: "AMOUNT_LOW" },
      { status: 402 },
    );
  }

  // ── Claim/commit pattern for atomic activation ───────────────────────────
  //
  //   PHASE 1 — Claim:
  //     a. Check used_txhash — if set, permanently committed → reject.
  //     b. SET NX on activation_claim:{txHash} (5-min TTL) — distributed lock.
  //        Only one concurrent request wins; the rest get 409 immediately.
  //
  //   PHASE 2 — Write (idempotent by design):
  //     a. addCredits guarded by credit_grant:{txHash} SET NX (90-day TTL):
  //          NX wins  → call addCredits (INCRBY); if it throws, DEL grant key
  //                     so the next retry can re-attempt cleanly.
  //          NX loses → credits already granted in a prior attempt; skip.
  //        This eliminates the double-credit risk on partial failure + retry.
  //     b. setSubscription is idempotent (overwrites same data) — always safe.
  //
  //   PHASE 3 — Commit:
  //     Only on full success: mark used_txhash permanently (90 days).
  //     Release claim + clear intent (best-effort).

  const { kv } = await import("@vercel/kv");
  const USED_TTL       = 90 * 24 * 60 * 60;
  const usedKey        = `used_txhash:${result.txHash}`;
  const claimKey       = `activation_claim:${result.txHash}`;
  const creditGrantKey = `credit_grant:${result.txHash}`;

  // Phase 1a — permanent used check
  const alreadyUsed = await kv.get(usedKey);
  if (alreadyUsed) {
    return NextResponse.json(
      { error: "This transaction has already been used for activation" },
      { status: 402 },
    );
  }

  // Phase 1b — atomic claim (SET NX EX 300)
  // Returns "OK" (truthy) if we own the lock, null if another request beat us.
  const CLAIM_TTL = 5 * 60; // 5 min — enough time for writes to complete
  const claimed = await kv.set(claimKey, addr, { nx: true, ex: CLAIM_TTL });
  if (!claimed) {
    return NextResponse.json(
      { error: "This transaction is already being processed. Please wait a moment and try again.", code: "ACTIVATION_IN_PROGRESS" },
      { status: 409 },
    );
  }

  // ── Quota + plan — use intent's locked quote ─────────────────────────────
  // quotedPlan and quotedCredits were computed server-side at intent creation,
  // so the user always gets exactly what the payment page showed them.
  // Fallback to recalculation only for intents created before this field existed.
  const addedTxs = intent.quotedCredits > 0
    ? intent.quotedCredits
    : 0;
  if (addedTxs === 0) {
    kv.del(claimKey).catch(() => {});
    return NextResponse.json({ error: "Payment amount too low for this chain" }, { status: 402 });
  }

  // ── Every payment: +30 days + TX credits, plan set on first payment ───────
  const plan = existing?.plan ?? (intent.quotedPlan ?? "starter");

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
  // ── Phase 2 — Write (idempotent) ─────────────────────────────────────────
  try {
    // addCredits (INCRBY) is non-idempotent — guard with credit_grant NX key.
    const canGrant = await kv.set(creditGrantKey, addedTxs, { nx: true, ex: USED_TTL });
    if (canGrant) {
      try {
        await addCredits(addr, addedTxs);
      } catch (e) {
        // addCredits failed — roll back grant key so next retry can re-attempt.
        kv.del(creditGrantKey).catch(() => {});
        throw e;
      }
    }
    // Read actual balance after grant (correct on first attempt and on retry).
    const totalTxs = await getQuotaCredits(addr);

    // setSubscription is idempotent (overwrites same data) — safe on every attempt.
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

    // ── Phase 3 — Commit ───────────────────────────────────────────────────
    // Only reached if all writes succeeded.
    await kv.set(usedKey, addr, { ex: USED_TTL });
    kv.del(claimKey).catch(() => {});
    clearPaymentIntent(addr).catch(() => {});

    return NextResponse.json({
      status:    "activated",
      plan,
      addedTxs,
      totalTxs,
      expiresAt: newExpiry.toISOString(),
    });
  } catch (e) {
    kv.del(claimKey).catch(() => {});
    console.error(`[activate] write failure addr=${addr} txHash=${result.txHash}:`, e);
    return NextResponse.json(
      { error: "Activation failed during save. Please try again.", code: "ACTIVATION_RETRY" },
      { status: 500 },
    );
  }
}
