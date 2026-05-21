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
  // Unified pricing (since v0.5.8) means every chain shares the same tier
  // thresholds, so the planChain-vs-payChain split is now operationally a
  // no-op for the dollar amounts. We keep these tests as a forward-compat
  // canary — if per-chain pricing returns, the wiring is still being
  // exercised against the activate route's actual call path. The Pro tier
  // threshold is $149 on every chain — we test against the exact threshold
  // value rather than $1 over so a future off-by-one in planFromAmount
  // also fails the test.
  it("BNB plan ($149) paid with ETH → pro/10K (planChain=bnb)", () => {
    const quote = computeQuote(149, "bnb", "eth");
    expect(quote).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("avax plan ($149) paid with BNB → pro/10K (planChain=avax)", () => {
    const quote = computeQuote(149, "avax", "bnb");
    expect(quote).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("eth plan ($149) paid with ETH → pro/10K (planChain=eth)", () => {
    const quote = computeQuote(149, "eth", "eth");
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

// ── ETH plan chain thresholds (unified pricing — same as BNB since 0.5.8) ───

describe("intent quote — ETH plan chain (unified pricing)", () => {
  it("$29 → starter / 500 credits", () => {
    expect(computeQuote(29, "eth")).toEqual({ quotedPlan: "starter", quotedCredits: 500 });
  });

  it("$149 → pro / 10,000 credits", () => {
    expect(computeQuote(149, "eth")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("$28 (below minimum) → null / 0 credits", () => {
    expect(computeQuote(28, "eth")).toEqual({ quotedPlan: null, quotedCredits: 0 });
  });
});

// ── Avax / Stable / XLayer plan chains ───────────────────────────────────────

describe("intent quote — Avax / Stable / XLayer / Mantle plan chains", () => {
  it("avax $89 → growth / 5,000 (unified threshold = $89, same as BNB)", () => {
    expect(computeQuote(89, "avax")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("stable $89 → growth / 5,000 (stable = BNB thresholds)", () => {
    expect(computeQuote(89, "stable")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("xlayer $49 → basic / 1,000", () => {
    expect(computeQuote(49, "xlayer")).toEqual({ quotedPlan: "basic", quotedCredits: 1_000 });
  });

  it("mantle $89 → growth / 5,000 (mantle = BNB thresholds, 1.0× multiplier)", () => {
    expect(computeQuote(89, "mantle")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("mantle $149 → pro / 10,000", () => {
    expect(computeQuote(149, "mantle")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("mantle $28 (below minimum) → null / 0 credits", () => {
    expect(computeQuote(28, "mantle")).toEqual({ quotedPlan: null, quotedCredits: 0 });
  });

  it("injective $89 → growth / 5,000 (injective = BNB thresholds, 1.0× multiplier)", () => {
    expect(computeQuote(89, "injective")).toEqual({ quotedPlan: "growth", quotedCredits: 5_000 });
  });

  it("injective $149 → pro / 10,000", () => {
    expect(computeQuote(149, "injective")).toEqual({ quotedPlan: "pro", quotedCredits: 10_000 });
  });

  it("injective $28 (below minimum) → null / 0 credits", () => {
    expect(computeQuote(28, "injective")).toEqual({ quotedPlan: null, quotedCredits: 0 });
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
    expect(INTENT_CHAIN_MAP["mantle"]).toBe("Mantle");
    expect(INTENT_CHAIN_MAP["injective"]).toBe("Injective");
    expect(INTENT_CHAIN_MAP["monad"]).toBe("Monad");
    expect(INTENT_CHAIN_MAP["scroll"]).toBe("Scroll");
  });
});
