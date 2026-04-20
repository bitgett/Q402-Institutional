/**
 * Pure decision function used by /api/cron/usage-alert to choose which
 * threshold email (if any) to fire for a given wallet.
 *
 * Returns the deepest tier the wallet has crossed downward that it hasn't
 * been alerted at yet, or null if no email is warranted.
 *
 *   pct > 20                                              → null
 *   pct ≤ 20,  lastThresholdAlerted > 20 (or null)        → 20
 *   pct ≤ 10,  lastThresholdAlerted > 10 (or null)        → 10  (wins over 20)
 *
 * `lastThresholdAlerted === null` means "never alerted in this credit
 * window" and is treated as +∞ so the first downward crossing fires.
 * The activate route resets it back to null on every top-up, giving
 * repeat customers a fresh alert cycle.
 */
export type AlertTier = 20 | 10;

export function pickAlertTier(params: {
  remaining: number;
  total: number;
  lastThresholdAlerted: number | null;
}): AlertTier | null {
  const { remaining, total, lastThresholdAlerted } = params;
  if (total <= 0) return null;
  const pct = (remaining / total) * 100;
  const lastTier = lastThresholdAlerted ?? Number.POSITIVE_INFINITY;
  if (pct <= 10 && lastTier > 10) return 10;
  if (pct <= 20 && lastTier > 20) return 20;
  return null;
}
