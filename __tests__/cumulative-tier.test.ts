/**
 * cumulative-tier.test.ts
 *
 * Verifies the cumulative tier-upgrade logic introduced in v1.18.
 *
 * A subscriber can reach a higher tier by paying more within an active
 * 30-day window; the window resets when the prior expiry has lapsed before
 * the next payment. Cross-chain payments are normalized to BNB-equivalent
 * USD (divide out the chain's price multiplier) so cumulative spend is
 * fair regardless of which chain the user paid on.
 *
 * The function under test is the pure tier-selection logic that the
 * activate route performs before writing the subscription. We replicate
 * it here so we can assert on it without spinning up the KV layer.
 */
import { describe, it, expect } from "vitest";
import { planFromAmount, toBnbEquivUSD, maxTier, tierRank } from "@/app/lib/blockchain";

// Pure tier decision: mirror of the block in app/api/payment/activate/route.ts
function pickTier(args: {
  existing: { plan: string; paidAt: string; amountUSD: number; windowPaidBnbUSD?: number } | null;
  now: Date;
  paymentUSD: number;
  paymentChain: string; // e.g. "BNB Chain", "Ethereum"
  thisTier: string | null; // intent.quotedPlan
}) {
  const { existing, now, paymentUSD, paymentChain, thisTier } = args;
  const priorExpiry = existing
    ? new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000)
    : new Date(0);
  const windowActive = priorExpiry > now;
  const priorWindow  = windowActive
    ? (existing?.windowPaidBnbUSD ?? existing?.amountUSD ?? 0)
    : 0;
  const thisBnbEquiv = toBnbEquivUSD(paymentUSD, paymentChain);
  const newWindow    = priorWindow + thisBnbEquiv;

  const cumTier   = planFromAmount(newWindow, "BNB Chain");
  const priorTier = windowActive ? (existing?.plan ?? null) : null;
  const plan      = maxTier(maxTier(thisTier, cumTier), priorTier) ?? "starter";
  return { plan, newWindow, windowActive };
}

const ACTIVE_SUB = (plan: string, amountUSD: number, windowPaidBnbUSD?: number) => ({
  plan,
  paidAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
  amountUSD,
  windowPaidBnbUSD,
});

const EXPIRED_SUB = (plan: string, amountUSD: number, windowPaidBnbUSD?: number) => ({
  plan,
  paidAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), // 40 days ago
  amountUSD,
  windowPaidBnbUSD,
});

const NOW = new Date();

// ── Single-payment (no prior subscription) ──────────────────────────────────

describe("first payment sets initial tier from quotedPlan", () => {
  it("$29 BNB first payment → starter", () => {
    const r = pickTier({
      existing: null, now: NOW,
      paymentUSD: 29, paymentChain: "BNB Chain", thisTier: "starter",
    });
    expect(r.plan).toBe("starter");
    expect(r.newWindow).toBe(29);
  });

  it("$149 BNB first payment → pro", () => {
    const r = pickTier({
      existing: null, now: NOW,
      paymentUSD: 149, paymentChain: "BNB Chain", thisTier: "pro",
    });
    expect(r.plan).toBe("pro");
  });

  it("$219 ETH first payment → pro (via thisTier, even though BNB-equiv < $149)", () => {
    // This is the critical rounding case: $219 / 1.5 = $146 < $149 Pro threshold.
    // Without thisTier we'd wrongly return growth. thisTier rescues it.
    const r = pickTier({
      existing: null, now: NOW,
      paymentUSD: 219, paymentChain: "Ethereum", thisTier: "pro",
    });
    expect(r.plan).toBe("pro");
  });
});

// ── Cumulative upgrade within active window ─────────────────────────────────

describe("cumulative upgrade — active window", () => {
  it("$29 BNB (Starter) + $120 BNB → cumulative $149 → Pro upgrade", () => {
    const existing = ACTIVE_SUB("starter", 29, 29);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 120, paymentChain: "BNB Chain", thisTier: "basic", // $120 alone = Basic
    });
    expect(r.plan).toBe("pro");
    expect(r.newWindow).toBe(149);
  });

  it("$89 BNB (Growth) + $60 BNB → cumulative $149 → Pro upgrade", () => {
    const existing = ACTIVE_SUB("growth", 89, 89);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 60, paymentChain: "BNB Chain", thisTier: "basic", // $60 alone = Basic
    });
    expect(r.plan).toBe("pro");
  });

  it("$29 BNB + $20 BNB → cumulative $49 → Basic upgrade (was Starter)", () => {
    const existing = ACTIVE_SUB("starter", 29, 29);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 20, paymentChain: "BNB Chain", thisTier: null, // $20 alone = null
    });
    expect(r.plan).toBe("basic");
    expect(r.newWindow).toBe(49);
  });

  it("never downgrades within window — existing Pro + tiny payment stays Pro", () => {
    const existing = ACTIVE_SUB("pro", 149, 149);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 29, paymentChain: "BNB Chain", thisTier: "starter",
    });
    expect(r.plan).toBe("pro");
  });

  it("large single payment inside window — Starter → Enterprise jump allowed", () => {
    const existing = ACTIVE_SUB("starter", 29, 29);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 1999, paymentChain: "BNB Chain", thisTier: "enterprise_flex",
    });
    expect(r.plan).toBe("enterprise_flex");
  });
});

// ── Cross-chain cumulative (normalization) ─────────────────────────────────

describe("cross-chain cumulative — BNB-equivalent normalization", () => {
  it("$149 BNB + $219 ETH → cumulative $149 + $146 = $295 → still Pro (Scale = $449)", () => {
    const existing = ACTIVE_SUB("pro", 149, 149);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 219, paymentChain: "Ethereum", thisTier: "pro",
    });
    expect(r.plan).toBe("pro");
    expect(r.newWindow).toBeCloseTo(149 + 219 / 1.5, 1);
  });

  it("$149 BNB + $489 AVAX (Scale on avax) → stays Scale via thisTier", () => {
    // $489 / 1.1 = $444.5 BNB-equiv + $149 = $593.5 → Scale ($449 threshold)
    const existing = ACTIVE_SUB("pro", 149, 149);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 489, paymentChain: "Avalanche", thisTier: "scale",
    });
    expect(r.plan).toBe("scale");
  });
});

// ── Window reset after expiry ──────────────────────────────────────────────

describe("expired window — cumulative resets", () => {
  it("prior Pro (expired 40d ago) + new $29 BNB → Starter (new window, no upgrade)", () => {
    const existing = EXPIRED_SUB("pro", 149, 149);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 29, paymentChain: "BNB Chain", thisTier: "starter",
    });
    expect(r.plan).toBe("starter");
    expect(r.newWindow).toBe(29); // reset, only this payment counts
    expect(r.windowActive).toBe(false);
  });

  it("prior Starter (expired) + $120 BNB → Growth (alone, no cumulative boost from expired window)", () => {
    const existing = EXPIRED_SUB("starter", 29, 29);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 120, paymentChain: "BNB Chain", thisTier: "growth",
    });
    expect(r.plan).toBe("growth"); // $120 falls in Growth band ($89-$149), not carried up by expired $29
    expect(r.newWindow).toBe(120);
  });
});

// ── Legacy subscription bootstrap (pre-v1.18 has no windowPaidBnbUSD) ─────

describe("legacy sub bootstrap — windowPaidBnbUSD missing", () => {
  it("active legacy Pro ($149) with undefined windowPaidBnbUSD + $100 BNB → Scale? (149+100=249, below $449)", () => {
    const existing = ACTIVE_SUB("pro", 149, undefined);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 100, paymentChain: "BNB Chain", thisTier: "growth",
    });
    expect(r.plan).toBe("pro");
    expect(r.newWindow).toBe(249); // bootstrapped from amountUSD
  });

  it("active legacy Starter ($29) with undefined windowPaidBnbUSD + $120 BNB → Pro ($149 cumulative)", () => {
    const existing = ACTIVE_SUB("starter", 29, undefined);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 120, paymentChain: "BNB Chain", thisTier: "basic",
    });
    expect(r.plan).toBe("pro");
  });
});

// ── Helper behavior ─────────────────────────────────────────────────────────

describe("toBnbEquivUSD", () => {
  it("BNB Chain — passthrough", () => {
    expect(toBnbEquivUSD(149, "BNB Chain")).toBe(149);
  });

  it("Ethereum — divides by 1.5", () => {
    expect(toBnbEquivUSD(219, "Ethereum")).toBeCloseTo(146, 0);
  });

  it("Avalanche — divides by 1.1", () => {
    expect(toBnbEquivUSD(489, "Avalanche")).toBeCloseTo(444.5, 1);
  });

  it("undefined chain — passthrough", () => {
    expect(toBnbEquivUSD(100)).toBe(100);
  });
});

describe("tierRank + maxTier", () => {
  it("tier ordering", () => {
    expect(tierRank("starter")).toBeLessThan(tierRank("pro"));
    expect(tierRank("pro")).toBeLessThan(tierRank("scale"));
    expect(tierRank("scale")).toBeLessThan(tierRank("enterprise_flex"));
  });

  it("maxTier picks higher-ranked", () => {
    expect(maxTier("starter", "pro")).toBe("pro");
    expect(maxTier("scale", "starter")).toBe("scale");
    expect(maxTier(null, "pro")).toBe("pro");
    expect(maxTier("pro", null)).toBe("pro");
    expect(maxTier(null, null)).toBe(null);
  });

  it("unknown tier names are treated as -1 (lowest)", () => {
    expect(maxTier("bogus", "starter")).toBe("starter");
  });
});
