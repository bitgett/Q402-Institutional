/**
 * intent-quote.test.ts
 *
 * Verifies that the server-side quote locking (quotedPlan, quotedCredits) in
 * POST /api/payment/intent is consistent with the pricing tables in blockchain.ts.
 *
 * These are the values activate/route.ts will consume directly — if they're
 * wrong at intent creation, the user gets the wrong credits/plan.
 */
import { describe, it, expect } from "vitest";
import { planFromAmount, txQuotaFromAmount, INTENT_CHAIN_MAP } from "@/app/lib/blockchain";

// Simulate what the intent route does when a user submits a quote.
function computeQuote(expectedUSD: number, payChainId: string) {
  const chainName    = INTENT_CHAIN_MAP[payChainId];
  const quotedPlan   = planFromAmount(expectedUSD, chainName);
  const quotedCredits = txQuotaFromAmount(expectedUSD, chainName);
  return { quotedPlan, quotedCredits };
}

// ── BNB payment chain ─────────────────────────────────────────────────────────

describe("intent quote — BNB payment chain", () => {
  it("$29 → starter / 500 credits", () => {
    expect(computeQuote(29, "bnb")).toEqual({ quotedPlan: "starter", quotedCredits: 500 });
  });

  it("$149 → pro / 10,000 credits", () => {
    expect(computeQuote(149, "bnb")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$160 (avax-multiplied 10K price on BNB) still yields pro / 10,000", () => {
    // selectedChain=avax (1.1×), price=$160, paying on BNB.
    // Server uses BNB thresholds ($149 for pro) → 160 >= 149 → pro.
    expect(computeQuote(160, "bnb")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$799 → business / 100,000 credits", () => {
    expect(computeQuote(799, "bnb")).toEqual({ quotedPlan: "business", quotedCredits: 100_000 });
  });

  it("$28 (below minimum) → null plan / 0 credits", () => {
    expect(computeQuote(28, "bnb")).toEqual({ quotedPlan: null, quotedCredits: 0 });
  });
});

// ── ETH payment chain ─────────────────────────────────────────────────────────

describe("intent quote — ETH payment chain", () => {
  it("$39 → starter / 500 credits", () => {
    expect(computeQuote(39, "eth")).toEqual({ quotedPlan: "starter", quotedCredits: 500 });
  });

  it("$219 → pro / 10,000 credits", () => {
    expect(computeQuote(219, "eth")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$220 (eth-multiplied 10K price, paying on ETH) → pro / 10,000", () => {
    // selectedChain=eth (1.5×), price=$220, paying on ETH.
    // ETH threshold for pro is $219 → 220 >= 219 → pro.
    expect(computeQuote(220, "eth")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$38 (below ETH minimum) → null plan / 0 credits", () => {
    expect(computeQuote(38, "eth")).toEqual({ quotedPlan: null, quotedCredits: 0 });
  });
});

// ── Stable / X Layer (same thresholds as BNB) ────────────────────────────────

describe("intent quote — Stable / X Layer", () => {
  it("stable $89 → growth / 5,000 credits (same as BNB)", () => {
    expect(computeQuote(89, "stable")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("xlayer $49 → basic / 1,000 credits", () => {
    expect(computeQuote(49, "xlayer")).toEqual({ quotedPlan: "basic", quotedCredits: 1_000 });
  });
});

// ── INTENT_CHAIN_MAP coverage ─────────────────────────────────────────────────

describe("INTENT_CHAIN_MAP", () => {
  it("maps all supported payment chain ids", () => {
    expect(INTENT_CHAIN_MAP["bnb"]).toBe("BNB Chain");
    expect(INTENT_CHAIN_MAP["eth"]).toBe("Ethereum");
    expect(INTENT_CHAIN_MAP["avax"]).toBe("Avalanche");
    expect(INTENT_CHAIN_MAP["xlayer"]).toBe("X Layer");
    expect(INTENT_CHAIN_MAP["stable"]).toBe("Stable");
  });

  it("is consistent: computeQuote(avax) equals computeQuote(bnb) at same thresholds", () => {
    // avax and bnb have slightly different thresholds for some tiers
    // but at 10K volume (bnb=$149, avax=$159) they should both yield "pro"
    const bnb  = computeQuote(160, "bnb");
    const avax = computeQuote(160, "avax");
    // 160 >= 149 (bnb) → pro; 160 >= 159 (avax) → pro
    expect(bnb.quotedPlan).toBe("pro");
    expect(avax.quotedPlan).toBe("pro");
  });
});
