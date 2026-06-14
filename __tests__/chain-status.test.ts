import { describe, it, expect } from "vitest";
import {
  isChainDisabled,
  DISABLED_CHAINS,
  CHAIN_DISABLED_MESSAGE,
} from "@/app/lib/chain-status";

// All 10 chains now run the guarded implementation, so the held set is empty.
// The kill-switch stays in place as the mechanism for re-holding a chain.
describe("chain-status — settlement allow-list", () => {
  it("holds no chains — every chain runs the guarded implementation", () => {
    expect([...DISABLED_CHAINS]).toEqual([]);
  });

  it("treats every supported chain as active", () => {
    for (const c of ["bnb", "avax", "eth", "stable", "xlayer", "monad", "scroll", "arbitrum", "mantle", "injective"]) {
      expect(isChainDisabled(c)).toBe(false);
    }
  });

  it("is null/undefined/empty-safe and case-insensitive", () => {
    expect(isChainDisabled(null)).toBe(false);
    expect(isChainDisabled(undefined)).toBe(false);
    expect(isChainDisabled("")).toBe(false);
    expect(isChainDisabled("BNB")).toBe(false);
  });

  it("exposes a caller-safe message constant", () => {
    expect(CHAIN_DISABLED_MESSAGE).toMatch(/temporarily|unavailable|disabled/i);
  });
});
