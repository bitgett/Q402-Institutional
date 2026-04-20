import { describe, it, expect } from "vitest";
import { pickAlertTier } from "@/app/lib/alert-tier";

/**
 * Regression coverage for the pure tier-selection logic used by
 * /api/cron/usage-alert. Extracted so each branch of the hysteresis
 * state machine is exercised without KV / Resend mocking.
 */
describe("pickAlertTier — baseline (no prior alert)", () => {
  it("returns null when remaining > 20% of total", () => {
    expect(pickAlertTier({ remaining: 5000, total: 10000, lastThresholdAlerted: null })).toBeNull();
  });

  it("returns null at 21% (just above threshold)", () => {
    expect(pickAlertTier({ remaining: 2100, total: 10000, lastThresholdAlerted: null })).toBeNull();
  });

  it("fires tier=20 at exactly 20%", () => {
    expect(pickAlertTier({ remaining: 2000, total: 10000, lastThresholdAlerted: null })).toBe(20);
  });

  it("fires tier=20 between 10% and 20%", () => {
    expect(pickAlertTier({ remaining: 1500, total: 10000, lastThresholdAlerted: null })).toBe(20);
  });

  it("fires tier=10 at exactly 10% (picks deepest crossed)", () => {
    expect(pickAlertTier({ remaining: 1000, total: 10000, lastThresholdAlerted: null })).toBe(10);
  });

  it("fires tier=10 below 10%", () => {
    expect(pickAlertTier({ remaining: 500, total: 10000, lastThresholdAlerted: null })).toBe(10);
  });

  it("fires tier=10 at 0% (fully drained)", () => {
    expect(pickAlertTier({ remaining: 0, total: 10000, lastThresholdAlerted: null })).toBe(10);
  });
});

describe("pickAlertTier — hysteresis after 20% alert", () => {
  it("returns null when still at 20% (no re-alert at same tier)", () => {
    expect(pickAlertTier({ remaining: 2000, total: 10000, lastThresholdAlerted: 20 })).toBeNull();
  });

  it("returns null when bouncing back above 20% (no upward re-alert)", () => {
    expect(pickAlertTier({ remaining: 2500, total: 10000, lastThresholdAlerted: 20 })).toBeNull();
  });

  it("fires tier=10 when burn continues to 10% (deeper tier still eligible)", () => {
    expect(pickAlertTier({ remaining: 1000, total: 10000, lastThresholdAlerted: 20 })).toBe(10);
  });
});

describe("pickAlertTier — hysteresis after 10% alert (terminal tier)", () => {
  it("returns null at 10% (no re-alert)", () => {
    expect(pickAlertTier({ remaining: 1000, total: 10000, lastThresholdAlerted: 10 })).toBeNull();
  });

  it("returns null at 5% (no spam below the deepest tier)", () => {
    expect(pickAlertTier({ remaining: 500, total: 10000, lastThresholdAlerted: 10 })).toBeNull();
  });

  it("returns null at 0% after already alerted at 10", () => {
    expect(pickAlertTier({ remaining: 0, total: 10000, lastThresholdAlerted: 10 })).toBeNull();
  });
});

describe("pickAlertTier — total guard", () => {
  it("returns null when total is 0 (no denominator)", () => {
    expect(pickAlertTier({ remaining: 0, total: 0, lastThresholdAlerted: null })).toBeNull();
  });

  it("returns null when total is negative (malformed input)", () => {
    expect(pickAlertTier({ remaining: 100, total: -1, lastThresholdAlerted: null })).toBeNull();
  });
});

describe("pickAlertTier — top-up reset cycle", () => {
  it("reset to null after top-up re-arms tier=20 firing on next downward crossing", () => {
    // Prior window: burned through to 10% → lastThresholdAlerted=10.
    // User tops up → activate route resets lastThresholdAlerted to null,
    // and total becomes the new peak (sub.quotaBonus=20000).
    // Next cron pass sees 4000/20000 = 20% remaining → should fire tier=20.
    expect(
      pickAlertTier({ remaining: 4000, total: 20000, lastThresholdAlerted: null }),
    ).toBe(20);
  });

  it("without reset, a new top-up window never re-fires (regression: activate must reset)", () => {
    // If activate route forgets to reset, lastThresholdAlerted stays at 10
    // and the wallet would never re-alert even at 0% of the new window.
    // This test freezes that invariant so anyone removing the reset trips it.
    expect(
      pickAlertTier({ remaining: 1500, total: 20000, lastThresholdAlerted: 10 }),
    ).toBeNull();
  });
});
