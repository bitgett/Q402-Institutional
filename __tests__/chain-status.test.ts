import { describe, it, expect } from "vitest";
import {
  isChainDisabled,
  DISABLED_CHAINS,
  CHAIN_DISABLED_MESSAGE,
} from "@/app/lib/chain-status";

// Held: the 5 chains whose 2026-06-15 redeploy compiled with the wrong domain
// NAME. Held until a corrected impl is deployed + verified + delegations cleared.
describe("chain-status — settlement allow-list", () => {
  it("holds exactly the 5 chains pending the corrected redeploy", () => {
    expect([...DISABLED_CHAINS].sort()).toEqual(
      ["arbitrum", "injective", "mantle", "monad", "scroll"],
    );
  });

  it("keeps the guarded chains active", () => {
    for (const c of ["bnb", "avax", "eth", "stable", "xlayer"]) {
      expect(isChainDisabled(c)).toBe(false);
    }
  });

  it("holds every chain in the list", () => {
    for (const c of ["mantle", "injective", "monad", "scroll", "arbitrum"]) {
      expect(isChainDisabled(c)).toBe(true);
    }
  });

  it("is null/undefined/empty-safe and case-insensitive", () => {
    expect(isChainDisabled(null)).toBe(false);
    expect(isChainDisabled(undefined)).toBe(false);
    expect(isChainDisabled("")).toBe(false);
    expect(isChainDisabled("BNB")).toBe(false);
    expect(isChainDisabled("Scroll")).toBe(true);
  });

  it("exposes a caller-safe message constant", () => {
    expect(CHAIN_DISABLED_MESSAGE).toMatch(/temporarily|unavailable|disabled/i);
  });
});
