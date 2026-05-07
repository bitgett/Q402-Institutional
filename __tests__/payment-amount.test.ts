import { describe, expect, it } from "vitest";
import { isPaymentAmountSufficient } from "@/app/lib/payment-amount";

describe("subscription payment amount validation", () => {
  it("rejects the old 5% underpayment tolerance", () => {
    expect(isPaymentAmountSufficient(27.55, 29)).toBe(false);
    expect(isPaymentAmountSufficient(1899.05, 1999)).toBe(false);
  });

  it("accepts exact stablecoin payment amounts", () => {
    expect(isPaymentAmountSufficient(29, 29)).toBe(true);
    expect(isPaymentAmountSufficient(1999, 1999)).toBe(true);
  });

  it("allows only tiny decimal formatting noise", () => {
    expect(isPaymentAmountSufficient(28.9999995, 29)).toBe(true);
    expect(isPaymentAmountSufficient(28.999, 29)).toBe(false);
  });
});
