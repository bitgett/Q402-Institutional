import { describe, it, expect } from "vitest";
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
