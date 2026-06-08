/**
 * hooks-multipayee-split.test.ts
 *
 * MultiPayeeSplit (#3) — beforeSettle transform. Mocks the per-wallet
 * config. The load-bearing assertions are the EXACT-SUM math: leg
 * amounts must sum to the original total to the wei, with rounding dust
 * absorbed by the last leg.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseUnits } from "viem";

const mockConfig = vi.hoisted(() => ({
  getWalletHookConfig: vi.fn(),
  // assertSplitsSumTo10000 is pure — keep the real one.
}));

vi.mock("@/app/lib/hooks/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks/config")>();
  return { ...actual, getWalletHookConfig: mockConfig.getWalletHookConfig };
});

import { multiPayeeSplit } from "@/app/lib/hooks/multipayee-split";
import type { HookContext, SplitSpec } from "@/app/lib/hooks/types";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);

function ctx(amount: string, over: Partial<HookContext> = {}): HookContext {
  return {
    lifecycle: "beforeSettle",
    owner: "0xowner",
    walletId: "0xwallet",
    chain: "eth", // USDC 6-dec on eth
    token: "USDC",
    recipient: "0x" + "9".repeat(40),
    amount,
    amountUsd: Number(amount),
    source: "send",
    ...over,
  };
}

function enable(defaultSplits?: SplitSpec[]) {
  mockConfig.getWalletHookConfig.mockResolvedValue({
    multiPayeeSplit: { enabled: true, defaultSplits },
  });
}

/** Sum leg amounts back to raw units at `decimals` and assert == total. */
function assertExactSum(parts: Array<{ amount: string }>, total: string, decimals: number) {
  const legSum = parts.reduce((acc, p) => acc + parseUnits(p.amount, decimals), 0n);
  expect(legSum).toBe(parseUnits(total, decimals));
}

beforeEach(() => vi.clearAllMocks());

describe("MultiPayeeSplit.shouldRun", () => {
  it("false when not enabled", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue(null);
    expect(await multiPayeeSplit.shouldRun(ctx("1"))).toBe(false);
  });
  it("true when enabled", async () => {
    enable();
    expect(await multiPayeeSplit.shouldRun(ctx("1"))).toBe(true);
  });
});

describe("MultiPayeeSplit.run — allow (no-op) paths", () => {
  it("allows when enabled but no splits configured", async () => {
    enable();
    const r = await multiPayeeSplit.run(ctx("1"));
    expect(r.action).toBe("allow");
  });
  it("allows when a single-leg split (degenerate)", async () => {
    enable([{ recipient: A, bps: 10000 }]);
    const r = await multiPayeeSplit.run(ctx("1"));
    expect(r.action).toBe("allow");
  });
});

describe("MultiPayeeSplit.run — exact-sum math (load-bearing)", () => {
  it("70/30 of 1.00 USDC → 0.70 + 0.30, exact sum", async () => {
    enable([{ recipient: A, bps: 7000 }, { recipient: B, bps: 3000 }]);
    const r = await multiPayeeSplit.run(ctx("1.00"));
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    expect(r.parts).toEqual([
      { recipient: A, amount: "0.7" },
      { recipient: B, amount: "0.3" },
    ]);
    assertExactSum(r.parts, "1.00", 6);
  });

  it("1/3 split of 1.00 USDC → dust to last leg, exact sum", async () => {
    // 3333 + 3333 + 3334 = 10000
    enable([
      { recipient: A, bps: 3333 },
      { recipient: B, bps: 3333 },
      { recipient: C, bps: 3334 },
    ]);
    const r = await multiPayeeSplit.run(ctx("1.00"));
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    // 1.00 USDC = 1_000_000 raw. 3333 bps = 333_300 each; last = 1_000_000 - 666_600 = 333_400.
    expect(r.parts.map((p) => p.amount)).toEqual(["0.3333", "0.3333", "0.3334"]);
    assertExactSum(r.parts, "1.00", 6);
  });

  it("odd amount 0.07 USDC 70/25/5 → exact sum, dust absorbed", async () => {
    enable([
      { recipient: A, bps: 7000 },
      { recipient: B, bps: 2500 },
      { recipient: C, bps: 500 },
    ]);
    const r = await multiPayeeSplit.run(ctx("0.07"));
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    assertExactSum(r.parts, "0.07", 6);
  });

  it("per-payment params.splits override wallet defaultSplits", async () => {
    enable([{ recipient: A, bps: 5000 }, { recipient: B, bps: 5000 }]);
    const r = await multiPayeeSplit.run(
      ctx("1.00", { params: { splits: [{ recipient: B, bps: 9000 }, { recipient: C, bps: 1000 }] } }),
    );
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    expect(r.parts).toEqual([
      { recipient: B, amount: "0.9" },
      { recipient: C, amount: "0.1" },
    ]);
  });

  it("honors 18-dec token on BNB chain", async () => {
    enable([{ recipient: A, bps: 6000 }, { recipient: B, bps: 4000 }]);
    const r = await multiPayeeSplit.run(ctx("1.0", { chain: "bnb" })); // USDC 18-dec on bnb
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    assertExactSum(r.parts, "1.0", 18);
  });
});

describe("MultiPayeeSplit.run — deny paths", () => {
  it("denies SPLIT_INVALID when bps don't sum to 10000", async () => {
    enable([{ recipient: A, bps: 7000 }, { recipient: B, bps: 2000 }]);
    const r = await multiPayeeSplit.run(ctx("1.00"));
    expect(r).toMatchObject({ action: "deny", code: "SPLIT_INVALID" });
  });

  it("denies SPLIT_LEG_TOO_SMALL when a leg rounds to zero", async () => {
    // 0.000001 USDC (1 raw unit at 6-dec) split 50/50 → leg 0 = 0 raw.
    enable([{ recipient: A, bps: 5000 }, { recipient: B, bps: 5000 }]);
    const r = await multiPayeeSplit.run(ctx("0.000001"));
    expect(r).toMatchObject({ action: "deny", code: "SPLIT_LEG_TOO_SMALL" });
  });
});
