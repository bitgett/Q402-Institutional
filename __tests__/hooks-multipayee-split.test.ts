/**
 * hooks-multipayee-split.test.ts
 *
 * MultiPayeeSplit (#3) — beforeSettle transform. Mocks the per-wallet
 * config. The load-bearing assertions are the EXACT-SUM math: leg
 * amounts must sum to the original total to the wei, with rounding dust
 * absorbed by the last leg.
 *
 * Fund-safety: a STORED default split must NOT silently redirect a
 * payment away from its named recipient — covered below.
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

/** ctx carrying an EXPLICIT per-payment split (the safe path — bypasses
 *  the default-override guard, since the caller named these legs). */
function explicitCtx(amount: string, splits: SplitSpec[], over: Partial<HookContext> = {}): HookContext {
  return ctx(amount, { params: { splits }, ...over });
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
  it("allows a single-leg split when the leg IS the payment recipient (no-op)", async () => {
    const TO = "0x" + "9".repeat(40); // matches ctx default recipient
    enable([{ recipient: TO, bps: 10000 }]);
    const r = await multiPayeeSplit.run(ctx("1"));
    expect(r.action).toBe("allow");
  });
});

describe("MultiPayeeSplit.run — explicit-only (P1 consent fix)", () => {
  it("IGNORES a stored default split — a normal pay settles to the named recipient, NOT the legs", async () => {
    // The P1 footgun: owner config fans out to A/B, caller named 0x999.
    // The hook must NOT silently redirect to A/B — it ignores the stored
    // default entirely and lets the normal single-recipient pay proceed.
    enable([{ recipient: A, bps: 7000 }, { recipient: B, bps: 3000 }]);
    const r = await multiPayeeSplit.run(ctx("1.00")); // no explicit split
    expect(r.action).toBe("allow");
  });

  it("IGNORES a stored single-leg default too", async () => {
    enable([{ recipient: A, bps: 10000 }]);
    const r = await multiPayeeSplit.run(ctx("1"));
    expect(r.action).toBe("allow");
  });

  it("runs an EXPLICIT per-payment split (caller named the legs in THIS request)", async () => {
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("1.00", [{ recipient: A, bps: 7000 }, { recipient: B, bps: 3000 }]));
    expect(r.action).toBe("split");
  });

  it("DENIES an explicit single-leg split whose leg differs from `to`", async () => {
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("1", [{ recipient: A, bps: 10000 }]));
    expect(r).toMatchObject({ action: "deny", code: "SPLIT_SINGLE_LEG_MISMATCH" });
  });

  it("DENIES an explicit split when Multi-Payee Split is DISABLED (no silent single-pay to `to`)", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({ multiPayeeSplit: { enabled: false } });
    const r = await multiPayeeSplit.run(explicitCtx("1", [{ recipient: A, bps: 6000 }, { recipient: B, bps: 4000 }]));
    expect(r).toMatchObject({ action: "deny", code: "MULTI_PAYEE_SPLIT_DISABLED" });
  });

  it("shouldRun is true for an explicit split even when disabled (so run() can reject)", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({ multiPayeeSplit: { enabled: false } });
    expect(await multiPayeeSplit.shouldRun(explicitCtx("1", [{ recipient: A, bps: 6000 }, { recipient: B, bps: 4000 }]))).toBe(true);
  });
});

describe("MultiPayeeSplit.run — exact-sum math (load-bearing)", () => {
  it("70/30 of 1.00 USDC → 0.70 + 0.30, exact sum", async () => {
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("1.00", [{ recipient: A, bps: 7000 }, { recipient: B, bps: 3000 }]));
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    expect(r.parts).toEqual([
      { recipient: A, amount: "0.7" },
      { recipient: B, amount: "0.3" },
    ]);
    assertExactSum(r.parts, "1.00", 6);
  });

  it("1/3 split of 1.00 USDC → dust to last leg, exact sum", async () => {
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("1.00", [
      { recipient: A, bps: 3333 },
      { recipient: B, bps: 3333 },
      { recipient: C, bps: 3334 },
    ]));
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    expect(r.parts.map((p) => p.amount)).toEqual(["0.3333", "0.3333", "0.3334"]);
    assertExactSum(r.parts, "1.00", 6);
  });

  it("odd amount 0.07 USDC 70/25/5 → exact sum, dust absorbed", async () => {
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("0.07", [
      { recipient: A, bps: 7000 },
      { recipient: B, bps: 2500 },
      { recipient: C, bps: 500 },
    ]));
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
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("1.0", [{ recipient: A, bps: 6000 }, { recipient: B, bps: 4000 }], { chain: "bnb" }));
    expect(r.action).toBe("split");
    if (r.action !== "split") return;
    assertExactSum(r.parts, "1.0", 18);
  });
});

describe("MultiPayeeSplit.run — deny paths", () => {
  it("denies SPLIT_INVALID when bps don't sum to 10000", async () => {
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("1.00", [{ recipient: A, bps: 7000 }, { recipient: B, bps: 2000 }]));
    expect(r).toMatchObject({ action: "deny", code: "SPLIT_INVALID" });
  });

  it("denies SPLIT_LEG_TOO_SMALL when a leg rounds to zero", async () => {
    // 0.000001 USDC (1 raw unit at 6-dec) split 50/50 → leg 0 = 0 raw.
    enable();
    const r = await multiPayeeSplit.run(explicitCtx("0.000001", [{ recipient: A, bps: 5000 }, { recipient: B, bps: 5000 }]));
    expect(r).toMatchObject({ action: "deny", code: "SPLIT_LEG_TOO_SMALL" });
  });
});
