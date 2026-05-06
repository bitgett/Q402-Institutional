import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { randomBytes } from "crypto";
import { intentByIdKey, intentLatestKey } from "@/app/lib/payment-intent";
import { planFromAmount, txQuotaFromAmount, INTENT_CHAIN_MAP } from "@/app/lib/blockchain";
import { SUBSCRIPTION_DEPLOYED_CHAINS } from "@/app/lib/wallets";

/**
 * POST /api/payment/intent
 *
 * Records what the user INTENDS to pay before they send the on-chain transaction.
 * Locks quotedPlan and quotedCredits server-side at creation time so that
 * /api/payment/activate uses these pre-computed values — eliminating drift
 * between the price the user saw and what the server would grant.
 *
 * /api/payment/activate also validates the found TX against this intent,
 * preventing wrong-chain activations, accidental activations from unrelated
 * transfers, and sender mismatches.
 *
 * Body: { address, nonce, signature, chain, expectedUSD, token?, planChain? }
 *   chain:      payment chain id — "bnb" | "eth" (where funds actually move)
 *   planChain:  selected relay chain — "bnb" | "avax" | "eth" | "xlayer" | "stable" | "mantle" | "injective"
 *               (determines plan/credit thresholds; defaults to `chain` if omitted)
 *   token:      "USDC" | "USDT" | "USDT0" (optional — cross-checked in activate)
 *
 * Each intent is stored under its own intentId for 2 hours. The "latest"
 * pointer for the address is updated on every creation — clients that don't
 * echo the intentId back on activate will match against the most recent one.
 */

const INTENT_TTL = 2 * 60 * 60; // 2 hours

// Subscription payment chains track SUBSCRIPTION_DEPLOYED_CHAINS — the single
// source of truth for where the SUBSCRIPTION Safe is actually deployed (see
// app/lib/wallets.ts). A CI drift guard
// (__tests__/subscription-safe-deployed.test.ts) verifies via eth_getCode
// that every chain key here has Safe bytecode at SUBSCRIPTION_ADDRESS, so a
// future PR that adds a chain without deploying the Safe first fails before
// it reaches production.
const VALID_CHAINS: ReadonlyArray<string> = SUBSCRIPTION_DEPLOYED_CHAINS;

// Subscription tokens the BNB/ETH on-chain scanner actually recognizes —
// USDC and USDT only. USDT0 is a Mantle/Stable-chain alias for relay/gas
// contexts and intentionally NOT a subscription rail (no USDT0 contract on
// BNB or ETH for the user to send from). Including it here would let a
// direct API caller create a payment intent that the scanner can never
// match, leaving the user's payment in limbo.
const VALID_TOKENS = ["USDC", "USDT"];


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
    planChain?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { address, nonce, signature, chain, expectedUSD, token, planChain } = body;

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

  // Lock plan and credits at intent creation time.
  //
  // Calculation basis: planChain (the relay service the user selected on the
  // pricing page) — NOT the payment chain.  Payment chain is used only to
  // validate that the on-chain TX came from the right network; it must never
  // influence what plan/credits the user receives.
  //
  //   Example: user selects "BNB plan" ($149, BNB thresholds), pays with ETH.
  //     planChain="bnb" → planFromAmount(149, "BNB Chain") → "pro" / 10K ✓
  //     If we used payChain="eth" → planFromAmount(149, "Ethereum") → "growth" / 5K ✗
  //
  const planChainResolved = planChain ?? chain;   // default: same as payment chain
  const planChainName     = INTENT_CHAIN_MAP[planChainResolved] ?? INTENT_CHAIN_MAP[chain];
  const quotedPlan        = planFromAmount(expectedUSD, planChainName);
  const quotedCredits     = txQuotaFromAmount(expectedUSD, planChainName);

  if (quotedCredits === 0) {
    return NextResponse.json(
      { error: `Payment amount $${expectedUSD} is below the minimum for ${planChainResolved}` },
      { status: 400 },
    );
  }

  const intentId = randomBytes(8).toString("hex");
  const intent = {
    intentId,
    chain,
    expectedUSD,
    token:         token ?? null,   // null = any token accepted
    address:       addr,
    createdAt:     new Date().toISOString(),
    planChain:     planChain ?? chain,
    quotedPlan,
    quotedCredits,
  };

  // Store under the intentId and advance the latest-pointer for this address.
  // Multiple concurrent intents per address coexist until they expire or one
  // of them is consumed by activate.
  await Promise.all([
    kv.set(intentByIdKey(intentId), intent, { ex: INTENT_TTL }),
    kv.set(intentLatestKey(addr), intentId, { ex: INTENT_TTL }),
  ]);

  return NextResponse.json({
    intentId, chain, expectedUSD,
    token:         token ?? null,
    quotedPlan,
    quotedCredits,
    expiresIn:     INTENT_TTL,
  });
}

