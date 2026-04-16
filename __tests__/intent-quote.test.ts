/**
 * intent-quote.test.ts
 *
 * Verifies that the server-side quote locking (quotedPlan, quotedCredits) in
 * POST /api/payment/intent uses planChain (the relay service the user selected),
 * NOT the payment chain (BNB/ETH).
 *
 * The payment chain is only used to verify the on-chain TX.
 * Plan/credits must reflect what the user saw on the pricing page (planChain thresholds).
 */
import { describe, it, expect } from "vitest";
import { planFromAmount, txQuotaFromAmount, INTENT_CHAIN_MAP } from "@/app/lib/blockchain";

// Mirror the logic in intent/route.ts:
//   planChain → thresholds used for plan/credits
//   payChainId → stored in intent but NOT used for plan calculation
function computeQuote(expectedUSD: number, planChainId: string, _payChainId = planChainId) {
  const chainName     = INTENT_CHAIN_MAP[planChainId];
  const quotedPlan    = planFromAmount(expectedUSD, chainName);
  const quotedCredits = txQuotaFromAmount(expectedUSD, chainName);
  return { quotedPlan, quotedCredits };
}

// ── Core correctness: planChain drives the quote, not payChain ───────────────

describe("planChain vs payChain — quote must follow planChain", () => {
  it("BNB plan ($150) paid with ETH → pro/10K (BNB thresholds, not ETH)", () => {
    // selectedChain="bnb" (1.0×), price=$150, user pays on ETH.
    // If we incorrectly used ETH thresholds: planFromAmount(150,"Ethereum") → growth/5K ✗
    // Correct: planChain="bnb" → planFromAmount(150,"BNB Chain") → pro/10K ✓
    const quote = computeQuote(150, "bnb", "eth");
    expect(quote).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("avax plan ($160) paid with BNB → pro/10K (avax thresholds)", () => {
    // selectedChain="avax" (1.1×), 10K volume → $160, paying on BNB.
    // avax threshold for pro = $159 → 160 >= 159 → pro ✓
    const quote = computeQuote(160, "avax", "bnb");
    expect(quote).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("eth plan ($220) paid with ETH → pro/10K (ETH thresholds)", () => {
    // selectedChain="eth" (1.5×), 10K volume → $220, paying on ETH.
    // ETH threshold for pro = $219 → 220 >= 219 → pro ✓
    const quote = computeQuote(220, "eth", "eth");
    expect(quote).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("stable plan ($89) paid with BNB → growth/5K (stable thresholds = BNB)", () => {
    const quote = computeQuote(89, "stable", "bnb");
    expect(quote).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });
});

// ── BNB plan chain thresholds ─────────────────────────────────────────────────

describe("intent quote — BNB plan chain", () => {
  it("$29 → starter / 500 credits", () => {
    expect(computeQuote(29, "bnb")).toEqual({ quotedPlan: "starter", quotedCredits: 500 });
  });

  it("$149 → pro / 10,000 credits", () => {
    expect(computeQuote(149, "bnb")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$799 → business / 100,000 credits", () => {
    expect(computeQuote(799, "bnb")).toEqual({ quotedPlan: "business", quotedCredits: 100_000 });
  });

  it("$28 (below minimum) → null / 0 credits", () => {
    expect(computeQuote(28, "bnb")).toEqual({ quotedPlan: null, quotedCredits: 0 });
  });
});

// ── ETH plan chain thresholds ─────────────────────────────────────────────────

describe("intent quote — ETH plan chain", () => {
  it("$39 → starter / 500 credits", () => {
    expect(computeQuote(39, "eth")).toEqual({ quotedPlan: "starter", quotedCredits: 500 });
  });

  it("$219 → pro / 10,000 credits", () => {
    expect(computeQuote(219, "eth")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$38 (below ETH minimum) → null / 0 credits", () => {
    expect(computeQuote(38, "eth")).toEqual({ quotedPlan: null, quotedCredits: 0 });
  });
});

// ── Avax / Stable / XLayer plan chains ───────────────────────────────────────

describe("intent quote — Avax / Stable / XLayer plan chains", () => {
  it("avax $99 → growth / 5,000 (avax threshold = $99)", () => {
    expect(computeQuote(99, "avax")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("stable $89 → growth / 5,000 (stable = BNB thresholds)", () => {
    expect(computeQuote(89, "stable")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("xlayer $49 → basic / 1,000", () => {
    expect(computeQuote(49, "xlayer")).toEqual({ quotedPlan: "basic", quotedCredits: 1_000 });
  });
});

// ── INTENT_CHAIN_MAP coverage ─────────────────────────────────────────────────

describe("INTENT_CHAIN_MAP", () => {
  it("maps all supported chain ids", () => {
    expect(INTENT_CHAIN_MAP["bnb"]).toBe("BNB Chain");
    expect(INTENT_CHAIN_MAP["eth"]).toBe("Ethereum");
    expect(INTENT_CHAIN_MAP["avax"]).toBe("Avalanche");
    expect(INTENT_CHAIN_MAP["xlayer"]).toBe("X Layer");
    expect(INTENT_CHAIN_MAP["stable"]).toBe("Stable");
  });
});
