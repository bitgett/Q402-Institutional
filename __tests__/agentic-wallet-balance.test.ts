import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { __test, formatUsd } from "@/app/lib/agentic-wallet-balance";

describe("tokenBalanceFromRaw", () => {
  it("converts 6-decimal USDC raw to USD with full precision", () => {
    const tb = __test.tokenBalanceFromRaw(1_234_567_890n, 6);
    // 1_234_567_890 / 10^6 = 1234.56789
    expect(tb.usd).toBeCloseTo(1234.56789, 5);
    expect(tb.raw).toBe("1234567890");
    expect(tb.decimals).toBe(6);
  });

  it("handles 18-decimal BNB-USDT raw without floating-point drift", () => {
    const tb = __test.tokenBalanceFromRaw(5n * 10n ** 18n, 18);
    expect(tb.usd).toBe(5);
    expect(tb.raw).toBe("5000000000000000000");
  });

  it("handles a zero balance", () => {
    const tb = __test.tokenBalanceFromRaw(0n, 6);
    expect(tb.usd).toBe(0);
    expect(tb.raw).toBe("0");
  });

  it("handles sub-cent amounts without losing precision", () => {
    const tb = __test.tokenBalanceFromRaw(1n, 6);  // 0.000001 USDC
    expect(tb.usd).toBeCloseTo(0.000001, 9);
  });
});

describe("formatUsd", () => {
  it("renders a positive value with two decimals + thousands separators", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
  it("renders zero as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("collapses microscopic positive values to <$0.01", () => {
    expect(formatUsd(0.0001)).toBe("<$0.01");
  });
  it("renders an em-dash for non-finite", () => {
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Infinity)).toBe("—");
  });
});

describe("agentic-wallet-balance — multicall3 wiring", () => {
  // First canary on preview returned "Chain does not support contract
  // multicall3" for every chain that ran the multi-token path,
  // collapsing every BNB-USDT-only deposit to TOTAL $0. The minimal
  // viem chain object we build per-chain was missing
  // `contracts.multicall3.address`, which viem's `multicall()`
  // requires. This guard pins both the constant address and the
  // presence of the `contracts.multicall3` shape so the regression
  // can't sneak back in via a refactor.
  const src = readFileSync(
    resolve(__dirname, "..", "app", "lib", "agentic-wallet-balance.ts"),
    "utf8",
  );

  it("declares the canonical Multicall3 address", () => {
    expect(src).toMatch(/0xcA11bde05977b3631167028862bE2a173976CA11/);
  });

  it("attaches `contracts.multicall3` to every viemChain it builds", () => {
    expect(src).toMatch(/contracts:\s*\{\s*multicall3:/);
  });
});
