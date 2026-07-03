/**
 * redstone-condition-source.test.ts
 *
 * Phase 3 — ConditionalOracle can gate on a RedStone feed (source="redstone")
 * as well as Chainlink (default). The RedStone reader is mocked so we control
 * the value without a live gateway; the point is the hook's dispatch + the same
 * fail-closed / 412-not-met contract as the Chainlink path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the RedStone reader — the hook delegates price reads to it.
const mockRedstone = vi.hoisted(() => ({
  redstoneEnabled: vi.fn(() => true),
  redstonePrice: vi.fn(),
}));
vi.mock("@/app/lib/redstone", () => mockRedstone);

// Keep Chainlink path inert (we only test the redstone branch + the default
// routing away from redstone).
const mockClient = vi.hoisted(() => ({ readContract: vi.fn() }));
const mockViem = vi.hoisted(() => ({
  createPublicClient: vi.fn(() => mockClient),
  http: vi.fn(() => ({})),
}));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: mockViem.createPublicClient, http: mockViem.http };
});
vi.mock("@/app/lib/relayer", () => ({ getPrimaryRpc: vi.fn(() => "https://rpc.test") }));

import { conditionalOracle } from "@/app/lib/hooks/conditional-oracle";
import type { HookContext, OracleCondition } from "@/app/lib/hooks/types";

function ctx(condition: OracleCondition, chain = "bnb"): HookContext {
  return {
    lifecycle: "beforeSettle",
    owner: "0xowner",
    walletId: "0xwallet",
    chain,
    token: "USDC",
    recipient: "0x" + "a".repeat(40),
    amount: "1.5",
    amountUsd: 1.5,
    source: "send",
    params: { condition },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedstone.redstoneEnabled.mockReturnValue(true);
});

describe("ConditionalOracle — source=redstone", () => {
  it("ALLOWS when the RedStone price meets the condition", async () => {
    mockRedstone.redstonePrice.mockResolvedValue({ feedId: "ETH", value: 2500 });
    const out = await conditionalOracle.run(ctx({ kind: "price", source: "redstone", feed: "ETH", op: ">=", value: 2000 }));
    expect(out.action).toBe("allow");
    expect(mockRedstone.redstonePrice).toHaveBeenCalledWith("ETH");
  });

  it("soft-412 CONDITION_NOT_MET when the price is below the threshold", async () => {
    mockRedstone.redstonePrice.mockResolvedValue({ feedId: "ETH", value: 1500 });
    const out = await conditionalOracle.run(ctx({ kind: "price", source: "redstone", feed: "ETH", op: ">=", value: 2000 }));
    expect(out.action).toBe("deny");
    if (out.action === "deny") {
      expect(out.code).toBe("CONDITION_NOT_MET");
      expect(out.status).toBe(412);
    }
  });

  it("fails CLOSED (deny) when the reader throws", async () => {
    mockRedstone.redstonePrice.mockRejectedValue(new Error("stale package"));
    const out = await conditionalOracle.run(ctx({ kind: "price", source: "redstone", feed: "ETH", op: ">=", value: 2000 }));
    expect(out.action).toBe("deny");
    if (out.action === "deny") {
      expect(out.code).toBe("CONDITION_FEED_READ_FAILED");
      expect(out.status).toBe(502);
    }
  });

  it("denies when RedStone is disabled on this deployment", async () => {
    mockRedstone.redstoneEnabled.mockReturnValue(false);
    const out = await conditionalOracle.run(ctx({ kind: "price", source: "redstone", feed: "ETH", op: ">=", value: 2000 }));
    expect(out.action).toBe("deny");
    if (out.action === "deny") {
      expect(out.code).toBe("CONDITION_REDSTONE_DISABLED");
    }
    // Reader must NOT be consulted when disabled.
    expect(mockRedstone.redstonePrice).not.toHaveBeenCalled();
  });

  it("<= NAV-drop semantics (redemption trigger) allows on a low value", async () => {
    mockRedstone.redstonePrice.mockResolvedValue({ feedId: "NAVUSD", value: 0.97 });
    const out = await conditionalOracle.run(ctx({ kind: "price", source: "redstone", feed: "NAVUSD", op: "<=", value: 0.98 }));
    expect(out.action).toBe("allow");
  });
});

describe("ConditionalOracle — default source stays Chainlink", () => {
  it("a condition with no source never touches the RedStone reader", async () => {
    // Unknown chainlink feed on this chain → CONDITION_FEED_UNKNOWN, and the
    // redstone reader is never called.
    const out = await conditionalOracle.run(ctx({ kind: "price", feed: "DOGE/USD", op: ">=", value: 1 }, "bnb"));
    expect(out.action).toBe("deny");
    if (out.action === "deny") expect(out.code).toBe("CONDITION_FEED_UNKNOWN");
    expect(mockRedstone.redstonePrice).not.toHaveBeenCalled();
  });
});
