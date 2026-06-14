import { describe, it, expect } from "vitest";
import {
  isChainDisabled,
  DISABLED_CHAINS,
  CHAIN_DISABLED_MESSAGE,
} from "@/app/lib/chain-status";

// Mantle/Injective/Monad/Scroll/Arbitrum were redeployed + verified 2026-06-15
// (correct per-chain NAME + owner-binding), but stay held until production env
// points at the new addresses and old delegations are cleared. The guarded
// production chains stay active.
describe("chain-status — settlement allow-list", () => {
  it("holds exactly the five chains pending production cutover", () => {
    expect([...DISABLED_CHAINS].sort()).toEqual(
      ["arbitrum", "injective", "mantle", "monad", "scroll"],
    );
  });

  it("keeps the production chains active", () => {
    for (const c of ["bnb", "avax", "eth", "stable", "xlayer"]) {
      expect(isChainDisabled(c)).toBe(false);
    }
  });

  it("holds every chain in the list (case-insensitive)", () => {
    for (const c of ["mantle", "injective", "monad", "scroll", "arbitrum"]) {
      expect(isChainDisabled(c)).toBe(true);
    }
    expect(isChainDisabled("Scroll")).toBe(true);
  });

  it("is null/undefined/empty-safe", () => {
    expect(isChainDisabled(null)).toBe(false);
    expect(isChainDisabled(undefined)).toBe(false);
    expect(isChainDisabled("")).toBe(false);
    expect(isChainDisabled("BNB")).toBe(false);
  });

  it("exposes a caller-safe message constant", () => {
    expect(CHAIN_DISABLED_MESSAGE).toMatch(/temporarily|unavailable|disabled/i);
  });
});
