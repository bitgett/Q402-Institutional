/**
 * gas-ledger.test.ts
 *
 * Exercises the wei-precise withdrawal deduction helper. The scenarios are
 * the ones where the old `parseFloat(formatEther(tx.value)) + Math.min(...)`
 * path could drift: wei-level boundary between on-chain TX value and the
 * float-shaped ledger balance.
 */
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { computeWithdrawDeduction } from "@/app/lib/gas-ledger";

describe("computeWithdrawDeduction", () => {
  it("sent < ledger → deduction = sent (full refund)", () => {
    const sentWei = ethers.parseUnits("0.5", 18);           // 0.5 BNB
    const ledgerFloat = 1.0;
    const { deductionWei, deductionFloat } = computeWithdrawDeduction(sentWei, ledgerFloat);
    expect(deductionWei).toBe(sentWei);
    expect(deductionFloat).toBeCloseTo(0.5, 18);
  });

  it("sent > ledger → deduction = ledger (cap at ledger)", () => {
    const sentWei = ethers.parseUnits("2.0", 18);
    const ledgerFloat = 0.75;
    const { deductionWei, deductionFloat } = computeWithdrawDeduction(sentWei, ledgerFloat);
    expect(deductionWei).toBe(ethers.parseUnits("0.75", 18));
    expect(deductionFloat).toBeCloseTo(0.75, 18);
  });

  it("sent == ledger (float-representable) → deduction equals both", () => {
    // Use a value exactly representable in IEEE-754 so sentWei and the
    // float-derived ledgerWei line up to the wei.
    const sentWei = ethers.parseUnits("0.5", 18);
    const { deductionWei } = computeWithdrawDeduction(sentWei, 0.5);
    expect(deductionWei).toBe(sentWei);
    expect(deductionWei).toBe(ethers.parseUnits("0.5", 18));
  });

  it("wei-level boundary: sent = ledgerWei - 1n → deduction = sent (not ledger)", () => {
    // Guards the bug the refactor was written to prevent: if we had compared
    // floats, sentWei one wei below ledger could round to equal ledger, and
    // Math.min would silently return the ledger — over-deducting by 1 wei.
    const ledgerFloat = 1.0;
    const ledgerWei   = ethers.parseUnits("1.0", 18);
    const sentWei     = ledgerWei - 1n;
    const { deductionWei } = computeWithdrawDeduction(sentWei, ledgerFloat);
    expect(deductionWei).toBe(sentWei);
    expect(deductionWei).not.toBe(ledgerWei);
  });

  it("ledger <= 0 → deduction is zero regardless of sentWei", () => {
    const sentWei = ethers.parseUnits("1.0", 18);
    expect(computeWithdrawDeduction(sentWei, 0)).toEqual({ deductionWei: 0n, deductionFloat: 0 });
    expect(computeWithdrawDeduction(sentWei, -0.1)).toEqual({ deductionWei: 0n, deductionFloat: 0 });
  });

  it("very small sentWei (1 wei) against healthy ledger → deduction = 1 wei", () => {
    const sentWei = 1n;
    const { deductionWei, deductionFloat } = computeWithdrawDeduction(sentWei, 0.01);
    expect(deductionWei).toBe(1n);
    expect(deductionFloat).toBe(1e-18);
  });

  it("ledger float with long fractional part does not throw (toFixed(18) safe)", () => {
    // 0.1 in JS float is 0.1000000000000000055... — toFixed(18) pads to 18
    // digits deterministically so parseUnits never rejects it.
    const sentWei = ethers.parseUnits("0.05", 18);
    const { deductionWei } = computeWithdrawDeduction(sentWei, 0.1);
    expect(deductionWei).toBe(sentWei);
  });
});
