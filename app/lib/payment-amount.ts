const AMOUNT_EPSILON = 0.000001;

/**
 * Subscription checkout uses exact stablecoin transfers, so percentage
 * underpayment tolerance would become a revenue leak. The epsilon is only for
 * JS decimal formatting noise after parsing token units.
 */
export function isPaymentAmountSufficient(paidAmount: number, expectedUSD: number): boolean {
  return paidAmount + AMOUNT_EPSILON >= expectedUSD;
}
