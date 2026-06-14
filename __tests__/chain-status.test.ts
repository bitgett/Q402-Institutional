import { describe, it, expect } from "vitest";
import {
  isChainDisabled,
  DISABLED_CHAINS,
  CHAIN_DISABLED_MESSAGE,
} from "@/app/lib/chain-status";

// The impl deployed on these 5 chains is missing the owner-binding check the
// guarded chains carry, so settlement is held until the impl is refreshed.
describe("chain-status — settlement allow-list", () => {
  it("holds exactly the chains still pending an impl refresh", () => {
    expect([...DISABLED_CHAINS].sort()).toEqual(["injective", "mantle"]);
  });

  it("keeps the guarded chains active (incl. the refreshed monad/scroll/arbitrum)", () => {
    for (const c of ["bnb", "avax", "eth", "stable", "xlayer", "monad", "scroll", "arbitrum"]) {
      expect(isChainDisabled(c)).toBe(false);
    }
  });

  it("holds every chain in the list", () => {
    for (const c of ["mantle", "injective"]) {
      expect(isChainDisabled(c)).toBe(true);
    }
  });

  it("is case-insensitive and null/undefined-safe", () => {
    expect(isChainDisabled("Mantle")).toBe(true);
    expect(isChainDisabled("INJECTIVE")).toBe(true);
    expect(isChainDisabled(null)).toBe(false);
    expect(isChainDisabled(undefined)).toBe(false);
    expect(isChainDisabled("")).toBe(false);
  });

  it("exposes a caller-safe disabled message", () => {
    expect(CHAIN_DISABLED_MESSAGE).toMatch(/disabled|security|temporarily/i);
  });
});
