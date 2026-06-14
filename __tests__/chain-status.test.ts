import { describe, it, expect } from "vitest";
import {
  isChainDisabled,
  DISABLED_CHAINS,
  CHAIN_DISABLED_MESSAGE,
} from "@/app/lib/chain-status";

// All ten chains run the verified guarded build (owner-binding + correct
// per-chain EIP-712 NAME). Mantle/Injective/Monad/Scroll/Arbitrum were
// redeployed + verified 2026-06-15 and the stale prod env overrides removed, so
// the allow-list holds nothing.
describe("chain-status — settlement allow-list", () => {
  it("holds no chains — all ten run the verified guarded build", () => {
    expect(DISABLED_CHAINS.size).toBe(0);
  });

  it("keeps every chain active", () => {
    for (const c of [
      "bnb", "avax", "eth", "stable", "xlayer",
      "mantle", "injective", "monad", "scroll", "arbitrum",
    ]) {
      expect(isChainDisabled(c)).toBe(false);
    }
  });

  it("is null/undefined/empty-safe and case-insensitive", () => {
    expect(isChainDisabled(null)).toBe(false);
    expect(isChainDisabled(undefined)).toBe(false);
    expect(isChainDisabled("")).toBe(false);
    expect(isChainDisabled("BNB")).toBe(false);
    expect(isChainDisabled("Scroll")).toBe(false);
  });

  it("exposes a caller-safe message constant for future holds", () => {
    expect(CHAIN_DISABLED_MESSAGE).toMatch(/temporarily|unavailable|disabled/i);
  });
});
