import { describe, it, expect } from "vitest";
import { __test } from "@/app/lib/quack-price";

// token0 = USDT, token1 = Q (both 18 dec) → USD/Q = 1.0001^(-tick).
describe("quack-price tick→USD math", () => {
  it("tick 0 == $1 (parity)", () => {
    expect(__test.tickToQuackUsd(0)).toBeCloseTo(1, 9);
  });

  it("observed pool tick 40753 ≈ $0.017", () => {
    const p = __test.tickToQuackUsd(40753);
    expect(p).toBeGreaterThan(0.015);
    expect(p).toBeLessThan(0.019);
  });

  it("higher tick = cheaper Q (USDT is token0)", () => {
    expect(__test.tickToQuackUsd(50000)).toBeLessThan(__test.tickToQuackUsd(40000));
  });

  it("price is positive and finite across the live range", () => {
    for (const t of [30000, 40753, 60000]) {
      const p = __test.tickToQuackUsd(t);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });
});
