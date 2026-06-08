/**
 * hooks-conditional-oracle.test.ts
 *
 * ConditionalOracle (#4) — beforeSettle. Timestamp branch is
 * deterministic; price branch mocks viem's createPublicClient so we
 * control latestRoundData / decimals / description without a live RPC.
 *
 * Key assertions: fail-CLOSED on every read error (unknown feed, RPC
 * fail, stale round, description mismatch), and "condition not met"
 * surfaces as a soft 412, distinct from the 5xx error denies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = vi.hoisted(() => ({ readContract: vi.fn() }));
const mockViem = vi.hoisted(() => ({
  createPublicClient: vi.fn(() => mockClient),
  http: vi.fn(() => ({})),
}));
const mockRelayer = vi.hoisted(() => ({ getPrimaryRpc: vi.fn(() => "https://rpc.test") }));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: mockViem.createPublicClient, http: mockViem.http };
});
vi.mock("@/app/lib/relayer", () => mockRelayer);

import { conditionalOracle } from "@/app/lib/hooks/conditional-oracle";
import type { HookContext, OracleCondition } from "@/app/lib/hooks/types";

function ctx(condition: OracleCondition, chain = "eth"): HookContext {
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

/** Wire the mock client to return a given round for a given pair. */
function feedReturns(opts: { description: string; decimals: number; answer: bigint; updatedAt: number }) {
  mockClient.readContract.mockImplementation(async (args: { functionName: string }) => {
    switch (args.functionName) {
      case "description": return opts.description;
      case "decimals": return opts.decimals;
      case "latestRoundData": return [1n, opts.answer, 0n, BigInt(opts.updatedAt), 1n];
      default: throw new Error("unexpected fn " + args.functionName);
    }
  });
}

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.clearAllMocks();
  mockViem.createPublicClient.mockReturnValue(mockClient);
});

describe("ConditionalOracle.shouldRun", () => {
  it("false when no condition", () => {
    const c = ctx({ kind: "timestamp", op: "after", value: 0 });
    c.params = {};
    expect(conditionalOracle.shouldRun(c)).toBe(false);
  });
  it("true when condition present", () => {
    expect(conditionalOracle.shouldRun(ctx({ kind: "timestamp", op: "after", value: 0 }))).toBe(true);
  });
});

describe("ConditionalOracle — timestamp branch (deterministic)", () => {
  it("allows when now is after target", async () => {
    const r = await conditionalOracle.run(ctx({ kind: "timestamp", op: "after", value: NOW() - 3600 }));
    expect(r.action).toBe("allow");
  });
  it("412 CONDITION_NOT_MET when now is before target", async () => {
    const r = await conditionalOracle.run(ctx({ kind: "timestamp", op: "after", value: NOW() + 3600 }));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_NOT_MET", status: 412 });
  });
  it("before op works", async () => {
    const r = await conditionalOracle.run(ctx({ kind: "timestamp", op: "before", value: NOW() + 3600 }));
    expect(r.action).toBe("allow");
  });
});

describe("ConditionalOracle — price branch happy path", () => {
  it("allows when BTC >= target and feed fresh + matching", async () => {
    feedReturns({ description: "BTC / USD", decimals: 8, answer: 85000_00000000n, updatedAt: NOW() - 60 });
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "BTC/USD", op: ">=", value: 80000 }, "eth"));
    expect(r.action).toBe("allow");
  });
  it("412 CONDITION_NOT_MET when price below target", async () => {
    feedReturns({ description: "BTC / USD", decimals: 8, answer: 75000_00000000n, updatedAt: NOW() - 60 });
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "BTC/USD", op: ">=", value: 80000 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_NOT_MET", status: 412 });
  });
  it("normalises description whitespace ('BTC / USD' vs 'BTC/USD')", async () => {
    feedReturns({ description: "BTC / USD", decimals: 8, answer: 90000_00000000n, updatedAt: NOW() });
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "BTC/USD", op: ">", value: 1 }, "avax"));
    expect(r.action).toBe("allow");
  });
});

describe("ConditionalOracle — price branch fail-CLOSED paths", () => {
  it("unknown feed/chain → deny CONDITION_FEED_UNKNOWN", async () => {
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "DOGE/USD", op: ">=", value: 1 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_FEED_UNKNOWN" });
  });
  it("price condition with no feed → deny CONDITION_FEED_REQUIRED", async () => {
    const r = await conditionalOracle.run(ctx({ kind: "price", op: ">=", value: 1 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_FEED_REQUIRED" });
  });
  it("RPC read throws → deny CONDITION_FEED_READ_FAILED (502)", async () => {
    mockClient.readContract.mockRejectedValue(new Error("rpc down"));
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "ETH/USD", op: ">=", value: 1 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_FEED_READ_FAILED", status: 502 });
  });
  it("description mismatch → deny CONDITION_FEED_MISMATCH (wrong-address guard)", async () => {
    feedReturns({ description: "LINK / USD", decimals: 8, answer: 1500000000n, updatedAt: NOW() });
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "BTC/USD", op: ">=", value: 1 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_FEED_MISMATCH" });
  });
  it("stale round (>25h) → deny CONDITION_FEED_STALE", async () => {
    feedReturns({ description: "BTC / USD", decimals: 8, answer: 90000_00000000n, updatedAt: NOW() - 26 * 3600 });
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "BTC/USD", op: ">=", value: 1 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_FEED_STALE" });
  });
  it("non-positive answer → deny CONDITION_FEED_BAD_PRICE", async () => {
    feedReturns({ description: "BTC / USD", decimals: 8, answer: 0n, updatedAt: NOW() });
    const r = await conditionalOracle.run(ctx({ kind: "price", feed: "BTC/USD", op: ">=", value: 1 }, "eth"));
    expect(r).toMatchObject({ action: "deny", code: "CONDITION_FEED_BAD_PRICE" });
  });
});
