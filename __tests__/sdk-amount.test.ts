/**
 * sdk-amount.test.ts
 *
 * Guards the SDK's human-readable-decimal → raw-uint256 conversion.
 *
 * The previous implementation used `Math.round(parseFloat(amount) * 10 ** decimals)`,
 * which silently lost precision for 18-decimal tokens (BNB USDC/USDT, Stable USDT0):
 *   parseFloat("1.000000000000000001") === 1.0000000000000002
 * The new `toRawAmount` uses ethers.parseUnits and rejects any input that
 * would have been silently rounded.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";

// The browser SDK references `ethers` as a global. Inject it before require()
// so the CJS export evaluates with the same binding the browser bundle gets.
beforeAll(() => {
  (globalThis as unknown as { ethers: typeof ethers }).ethers = ethers;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { toRawAmount } = require("../public/q402-sdk.js") as {
  toRawAmount: (amount: string, decimals: number) => string;
};

describe("toRawAmount — exact decimal conversion", () => {
  it('"5.000001" @ 6 decimals → 5000001', () => {
    expect(toRawAmount("5.000001", 6)).toBe("5000001");
  });

  it('"1.000000000000000001" @ 18 decimals → 1000000000000000001 (no precision loss)', () => {
    expect(toRawAmount("1.000000000000000001", 18)).toBe("1000000000000000001");
  });

  it('"0.123456789123456789" @ 18 decimals → 123456789123456789 (full 18-digit fraction)', () => {
    expect(toRawAmount("0.123456789123456789", 18)).toBe("123456789123456789");
  });

  it('"5.00" @ 6 decimals → 5000000', () => {
    expect(toRawAmount("5.00", 6)).toBe("5000000");
  });

  it('"1" @ 18 decimals → 1000000000000000000', () => {
    expect(toRawAmount("1", 18)).toBe("1000000000000000000");
  });
});

describe("toRawAmount — input validation", () => {
  it("rejects more decimal places than the token supports", () => {
    expect(() => toRawAmount("1.1234567", 6)).toThrow(/more than 6 decimal places/);
  });

  it("rejects an empty string", () => {
    expect(() => toRawAmount("", 6)).toThrow(/non-empty decimal string/);
  });

  it("rejects whitespace-only input", () => {
    expect(() => toRawAmount("   ", 6)).toThrow(/non-empty decimal string/);
  });

  it("rejects non-numeric garbage", () => {
    expect(() => toRawAmount("abc", 6)).toThrow(/invalid amount/);
    expect(() => toRawAmount("1.2.3", 6)).toThrow(/invalid amount/);
  });

  it("rejects scientific notation", () => {
    expect(() => toRawAmount("1e6", 6)).toThrow(/invalid amount/);
  });

  it("rejects signed values (negative and explicit-positive)", () => {
    expect(() => toRawAmount("-1", 6)).toThrow(/invalid amount/);
    expect(() => toRawAmount("+1", 6)).toThrow(/invalid amount/);
  });

  it("rejects zero", () => {
    expect(() => toRawAmount("0", 6)).toThrow(/greater than zero/);
    expect(() => toRawAmount("0.0", 6)).toThrow(/greater than zero/);
  });

  it("rejects non-string input (Number rejected — IEEE-754 is the whole bug)", () => {
    expect(() => toRawAmount(5 as unknown as string, 6)).toThrow(/non-empty decimal string/);
  });
});

describe("SDK never falls back to Number/parseFloat for amount conversion", () => {
  it("has no parseFloat / Math.round amount conversion left in the SDK source", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolve } = require("node:path") as typeof import("node:path");
    const src = readFileSync(resolve(__dirname, "..", "public", "q402-sdk.js"), "utf8");
    expect(src).not.toMatch(/parseFloat\s*\(\s*amount/);
    expect(src).not.toMatch(/Math\.round\s*\(\s*parseFloat/);
  });
});
