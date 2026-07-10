import { describe, it, expect } from "vitest";
import {
  isChainDisabled,
  DISABLED_CHAINS,
  CHAIN_DISABLED_MESSAGE,
} from "@/app/lib/chain-status";

// Every chain EXCEPT robinhood runs the verified guarded build (owner-binding +
// correct per-chain EIP-712 NAME). robinhood is HELD 2026-07-10: its live impl
// 0x2fb2…f350 is an unguarded build (no owner==address(this) binding), confirmed
// on-chain, so new settlements/delegations are blocked until the guarded impl is
// redeployed + re-wired. See app/lib/chain-status.ts.
describe("chain-status — settlement allow-list", () => {
  it("holds only robinhood while its unguarded impl is redeployed", () => {
    expect(DISABLED_CHAINS.size).toBe(1);
    expect(isChainDisabled("robinhood")).toBe(true);
  });

  it("keeps every other chain active", () => {
    for (const c of [
      "bnb", "avax", "eth", "stable", "xlayer",
      "mantle", "injective", "monad", "scroll", "arbitrum", "base",
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
