/**
 * q-payment-discount.test.ts
 *
 * Locks the invariants of paying a Q402 subscription in Q (QuackAI token) at a
 * fixed 50% discount:
 *
 *   1. Q amount = 50% of the plan's USD price, priced off the Q/USD TWAP, and
 *      rounded UP to 4 dp (so display == send == activate check, and rounding
 *      can never underpay us).
 *   2. Plan + credits are computed from the FULL price — the discount applies
 *      to the payment only, never to what the subscriber receives.
 *   3. activate's amount gate accepts paidQ >= requiredQ (with a tiny epsilon)
 *      and rejects a short payment.
 *   4. Drift guards: the 50% constant + the exact rounding formula are identical
 *      in POST /api/payment/intent and GET /api/payment/q-quote, and the Q token
 *      address lives ONLY in the dedicated Q scan path — never in the general
 *      CHAINS token list (a stray Q entry there would let a large Q transfer win
 *      "largest amountUSD" selection over a real stablecoin payment).
 */
import { describe, it, expect } from "vitest";
import { planFromAmount, txQuotaFromAmount } from "@/app/lib/blockchain";

const Q_DISCOUNT_BPS = 5000; // 50% — mirrors intent/route.ts + q-quote/route.ts

// Mirror the Q-amount math in intent/route.ts and q-quote/route.ts exactly.
function computeQ(expectedUSD: number, qPriceUsd: number) {
  const discountedUsd  = expectedUSD * (1 - Q_DISCOUNT_BPS / 10_000);
  const quotedQAmount  = Math.ceil((discountedUsd / qPriceUsd) * 1e4) / 1e4;
  return { discountedUsd, quotedQAmount };
}

// Mirror activate's Q gate: paidQ + 1e-6 >= requiredQ.
function qGateAccepts(paidQ: number, requiredQ: number) {
  return paidQ + 1e-6 >= requiredQ;
}

// ── 50% discount applied to the payment ──────────────────────────────────────

describe("Q payment — 50% discount on the USD value", () => {
  it("$149 plan → user pays the Q worth of $74.50", () => {
    const { discountedUsd } = computeQ(149, 0.01755);
    expect(discountedUsd).toBeCloseTo(74.5, 6);
  });

  it("$29 plan → $14.50 of Q", () => {
    expect(computeQ(29, 1).discountedUsd).toBeCloseTo(14.5, 6);
  });

  it("at qPrice = $1, the Q amount equals the discounted USD (rounded up 4dp)", () => {
    // $89 → $44.50 → 44.5 Q at $1
    expect(computeQ(89, 1).quotedQAmount).toBe(44.5);
  });

  it("prices off the TWAP: $149 at $0.01755 → ~4245.01 Q", () => {
    // 74.5 / 0.01755 = 4245.0142... → ceil to 4dp = 4245.0143
    expect(computeQ(149, 0.01755).quotedQAmount).toBe(4245.0143);
  });
});

// ── Rounding is always UP (never underpay the treasury) ──────────────────────

describe("Q amount rounds UP to 4 dp", () => {
  it("never rounds below the exact discounted value", () => {
    for (const usd of [29, 49, 89, 149, 449, 799, 1999]) {
      for (const price of [0.001, 0.01755, 0.1, 1, 7.3]) {
        const { discountedUsd, quotedQAmount } = computeQ(usd, price);
        // The Q we ask for, valued back at the same price, is >= the target USD.
        expect(quotedQAmount * price + 1e-9).toBeGreaterThanOrEqual(discountedUsd);
        // And it is a clean 4-dp number.
        expect(Number.isInteger(Math.round(quotedQAmount * 1e4))).toBe(true);
      }
    }
  });

  it("rounds a non-terminating quotient up, not down", () => {
    // 0.5 / 0.03 = 16.666... → ceil 4dp = 16.6667
    expect(computeQ(1, 0.03).quotedQAmount).toBe(16.6667);
  });
});

// ── Plan + credits use the FULL price (cumulative tier on list price) ─────────

describe("plan/credits are based on the FULL price, not the discounted one", () => {
  it("$149 Q payment → pro / 10K (same as a $149 stablecoin payment)", () => {
    // The discount must NOT drop the tier to the $74.50 bracket (growth/5K).
    expect(planFromAmount(149, "BNB Chain")).toBe("pro");
    expect(txQuotaFromAmount(149, "BNB Chain")).toBe(10_000);
    // Sanity: the discounted $74.50 sits in the basic bracket ($49–$89) — so
    // charging tiers on the discounted price would drop pro/10K to basic/1K.
    expect(planFromAmount(74.5, "BNB Chain")).toBe("basic");
    expect(txQuotaFromAmount(74.5, "BNB Chain")).toBe(1_000);
  });

  it("$799 Q payment → business / 100K on the full price", () => {
    expect(planFromAmount(799, "BNB Chain")).toBe("business");
    expect(txQuotaFromAmount(799, "BNB Chain")).toBe(100_000);
  });
});

// ── activate's amount gate ───────────────────────────────────────────────────

describe("activate Q amount gate — paidQ >= requiredQ (epsilon tolerant)", () => {
  const required = computeQ(149, 0.01755).quotedQAmount; // 4245.0143

  it("accepts an exact payment", () => {
    expect(qGateAccepts(required, required)).toBe(true);
  });

  it("accepts an overpayment", () => {
    expect(qGateAccepts(required + 100, required)).toBe(true);
  });

  it("tolerates float dust just under the required amount", () => {
    expect(qGateAccepts(required - 1e-9, required)).toBe(true);
  });

  it("rejects a real short payment (1 Q light)", () => {
    expect(qGateAccepts(required - 1, required)).toBe(false);
  });
});

// ── Drift guards on the source (formula + constant must stay in lockstep) ─────

describe("source drift — discount constant + formula stay in lockstep", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolve } = require("node:path") as typeof import("node:path");
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  const intentSrc  = read("app/api/payment/intent/route.ts");
  const quoteSrc   = read("app/api/payment/q-quote/route.ts");
  const blockchain = read("app/lib/blockchain.ts");

  it("both routes define Q_DISCOUNT_BPS = 5000 (fixed 50%)", () => {
    expect(intentSrc).toMatch(/Q_DISCOUNT_BPS\s*=\s*5000/);
    expect(quoteSrc).toMatch(/Q_DISCOUNT_BPS\s*=\s*5000/);
  });

  it("both routes use the identical round-UP-to-4dp Q formula", () => {
    const formula = /Math\.ceil\(\(discountedUsd \/ qPriceUsd\) \* 1e4\) \/ 1e4/;
    expect(intentSrc).toMatch(formula);
    expect(quoteSrc).toMatch(formula);
  });

  it("the Q token address appears exactly once in blockchain.ts (dedicated Q path, never in CHAINS)", () => {
    const matches = blockchain.match(/0xc07e1300dc138601FA6B0b59f8D0FA477e690589/gi) ?? [];
    expect(matches.length).toBe(1);
  });

  it("Q amount gate in activate uses paidQ vs quotedQAmount (never re-derives USD on-chain)", () => {
    const activateSrc = read("app/api/payment/activate/route.ts");
    expect(activateSrc).toMatch(/quotedQAmount/);
    expect(activateSrc).toMatch(/qAmount/);
  });
});
