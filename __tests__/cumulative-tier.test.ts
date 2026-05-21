/**
 * cumulative-tier.test.ts
 *
 * Verifies the cumulative tier-upgrade logic introduced in v1.18.
 *
 * A subscriber can reach a higher tier by paying more within an active
 * 30-day window; the window resets when the prior expiry has lapsed before
 * the next payment. Cross-chain payments are normalized to BNB-equivalent
 * USD via toBnbEquivUSD() so cumulative spend is fair regardless of which
 * chain the user paid on.
 *
 * As of 0.5.8 the per-chain price multipliers are all 1.0 (every chain
 * uses the same tier prices), so toBnbEquivUSD() is the identity function
 * and the "BNB-equivalent" normalization becomes a no-op. The tests are
 * kept against the activate route's actual code path so the wiring is
 * still exercised — if a future release reintroduces per-chain pricing,
 * these tests are the canary.
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

  it("$149 ETH first payment → pro (unified pricing — ETH no longer surcharged)", () => {
    // Pre-0.5.8 ETH carried a 1.5× surcharge so Pro tier cost $219 there.
    // Unified pricing: Pro is $149 on every chain, ETH included. thisTier
    // and cumulative resolution agree.
    const r = pickTier({
      existing: null, now: NOW,
      paymentUSD: 149, paymentChain: "Ethereum", thisTier: "pro",
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
  it("$149 BNB + $149 ETH → cumulative $298 → still Pro (Scale = $449)", () => {
    // Unified pricing: ETH at 1.0× multiplier means the BNB-equiv of
    // a $149 ETH payment is $149 (identity). Cumulative window = $298,
    // still below Scale's $449 threshold.
    const existing = ACTIVE_SUB("pro", 149, 149);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 149, paymentChain: "Ethereum", thisTier: "pro",
    });
    expect(r.plan).toBe("pro");
    expect(r.newWindow).toBe(298);
  });

  it("$149 BNB + $449 AVAX (Scale on avax) → upgrades to Scale", () => {
    // Unified pricing: $449 AVAX = $449 BNB-equiv. $149 prior + $449
    // = $598, comfortably above Scale's $449 threshold.
    const existing = ACTIVE_SUB("pro", 149, 149);
    const r = pickTier({
      existing, now: NOW,
      paymentUSD: 449, paymentChain: "Avalanche", thisTier: "scale",
    });
    expect(r.plan).toBe("scale");
    expect(r.newWindow).toBe(598);
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

describe("toBnbEquivUSD — unified pricing makes this the identity function", () => {
  // Pre-0.5.8 Ethereum divided by 1.5 and Avalanche by 1.1. Now every chain
  // is 1.0 multiplier, so cross-chain payments don't get re-scaled. The
  // function stays as a wired-up no-op so the activate route's call-site
  // doesn't need a feature flag if per-chain pricing ever returns.
  it("BNB Chain — passthrough", () => {
    expect(toBnbEquivUSD(149, "BNB Chain")).toBe(149);
  });

  it("Ethereum — identity (was 1.5× in earlier releases)", () => {
    expect(toBnbEquivUSD(149, "Ethereum")).toBe(149);
  });

  it("Avalanche — identity (was 1.1× in earlier releases)", () => {
    expect(toBnbEquivUSD(449, "Avalanche")).toBe(449);
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
