import { describe, it, expect } from "vitest";
import { planFromAmount, txQuotaFromAmount } from "@/app/lib/blockchain";

// ── planFromAmount ─────────────────────────────────────────────────────────────

describe("planFromAmount", () => {
  describe("BNB Chain thresholds", () => {
    it("returns null below temporary smoke-test minimum ($0.01)", () => {
      expect(planFromAmount(0, "BNB Chain")).toBeNull();
      expect(planFromAmount(0.009, "BNB Chain")).toBeNull();
    });

    it("returns starter at $0.01", () => {
      expect(planFromAmount(0.01, "BNB Chain")).toBe("starter");
    });

    it("returns basic at $49", () => {
      expect(planFromAmount(49, "BNB Chain")).toBe("basic");
      expect(planFromAmount(88, "BNB Chain")).toBe("basic");
    });

    it("returns growth at $89", () => {
      expect(planFromAmount(89, "BNB Chain")).toBe("growth");
    });

    it("returns pro at $149", () => {
      expect(planFromAmount(149, "BNB Chain")).toBe("pro");
    });

    it("returns scale at $449", () => {
      expect(planFromAmount(449, "BNB Chain")).toBe("scale");
    });

    it("returns business at $799", () => {
      expect(planFromAmount(799, "BNB Chain")).toBe("business");
    });

    it("returns enterprise_flex at $1999", () => {
      expect(planFromAmount(1999, "BNB Chain")).toBe("enterprise_flex");
      expect(planFromAmount(9999, "BNB Chain")).toBe("enterprise_flex");
    });
  });

  describe("Ethereum thresholds (higher multiplier)", () => {
    it("returns null below $39", () => {
      expect(planFromAmount(38, "Ethereum")).toBeNull();
    });

    it("returns starter at $39", () => {
      expect(planFromAmount(39, "Ethereum")).toBe("starter");
    });

    it("returns business at $1199", () => {
      expect(planFromAmount(1199, "Ethereum")).toBe("business");
    });

    it("returns enterprise_flex at $2999", () => {
      expect(planFromAmount(2999, "Ethereum")).toBe("enterprise_flex");
    });
  });

  describe("Avalanche thresholds", () => {
    it("returns null below $29", () => {
      expect(planFromAmount(28, "Avalanche")).toBeNull();
    });

    it("returns starter at $29", () => {
      expect(planFromAmount(29, "Avalanche")).toBe("starter");
    });

    it("returns growth at $99 (Avalanche-specific)", () => {
      expect(planFromAmount(99, "Avalanche")).toBe("growth");
    });
  });

  describe("Stable chain thresholds (same as BNB)", () => {
    it("returns null below $29", () => {
      expect(planFromAmount(28, "Stable")).toBeNull();
    });

    it("returns starter at $29", () => {
      expect(planFromAmount(29, "Stable")).toBe("starter");
    });

    it("returns enterprise_flex at $1999", () => {
      expect(planFromAmount(1999, "Stable")).toBe("enterprise_flex");
    });
  });

  describe("unknown chain falls back to BNB defaults", () => {
    it("uses BNB thresholds for undefined chain", () => {
      expect(planFromAmount(0.009)).toBeNull();
      expect(planFromAmount(0.01)).toBe("starter");
      expect(planFromAmount(799)).toBe("business");
    });

    it("uses BNB thresholds for unrecognised chain string", () => {
      expect(planFromAmount(29, "UnknownChain")).toBe("starter");
    });
  });
});

// ── txQuotaFromAmount ──────────────────────────────────────────────────────────

describe("txQuotaFromAmount", () => {
  describe("BNB Chain", () => {
    it("returns 0 below temporary smoke-test minimum ($0.01)", () => {
      expect(txQuotaFromAmount(0, "BNB Chain")).toBe(0);
      expect(txQuotaFromAmount(0.009, "BNB Chain")).toBe(0);
    });

    it("returns 500 at $0.01", () => {
      expect(txQuotaFromAmount(0.01, "BNB Chain")).toBe(500);
    });

    it("returns 1000 at $49", () => {
      expect(txQuotaFromAmount(49, "BNB Chain")).toBe(1000);
    });

    it("returns 5000 at $89", () => {
      expect(txQuotaFromAmount(89, "BNB Chain")).toBe(5000);
    });

    it("returns 10000 at $149", () => {
      expect(txQuotaFromAmount(149, "BNB Chain")).toBe(10_000);
    });

    it("returns 50000 at $449", () => {
      expect(txQuotaFromAmount(449, "BNB Chain")).toBe(50_000);
    });

    it("returns 100000 at $799", () => {
      expect(txQuotaFromAmount(799, "BNB Chain")).toBe(100_000);
    });

    it("returns 500000 at $1999", () => {
      expect(txQuotaFromAmount(1999, "BNB Chain")).toBe(500_000);
    });
  });

  describe("Ethereum (higher thresholds)", () => {
    it("returns 0 below $39", () => {
      expect(txQuotaFromAmount(38, "Ethereum")).toBe(0);
    });

    it("returns 500 at $39", () => {
      expect(txQuotaFromAmount(39, "Ethereum")).toBe(500);
    });

    it("returns 100000 at $1199", () => {
      expect(txQuotaFromAmount(1199, "Ethereum")).toBe(100_000);
    });
  });

  describe("plan and quota are consistent (same tier boundaries)", () => {
    it("planFromAmount and txQuotaFromAmount agree at every BNB tier boundary", () => {
      const cases: [number, string, number][] = [
        [0.01, "starter",        500],
        [49,   "basic",        1_000],
        [89,   "growth",       5_000],
        [149,  "pro",         10_000],
        [449,  "scale",       50_000],
        [799,  "business",   100_000],
        [1999, "enterprise_flex", 500_000],
      ];
      for (const [usd, plan, quota] of cases) {
        expect(planFromAmount(usd, "BNB Chain"), `plan at $${usd}`).toBe(plan);
        expect(txQuotaFromAmount(usd, "BNB Chain"), `quota at $${usd}`).toBe(quota);
      }
    });
  });
});
