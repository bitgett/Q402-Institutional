import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  listUsageAlertAddresses,
  getUsageAlert,
  getSubscription,
  getQuotaCredits,
  recordAlertSent,
  clearUsageAlert,
} from "@/app/lib/db";
import { sendEmail, renderUsageAlertHtml } from "@/app/lib/email";
import { pickAlertTier } from "@/app/lib/alert-tier";

/**
 * GET /api/cron/usage-alert
 *
 * Vercel Cron (vercel.json) fires this daily. Fan-out iterates
 * `usage_alert:_index` — the Set of opted-in wallet addresses — so there's no
 * KV key scan and the cost scales with subscriber count, not KV size.
 *
 * Per-wallet logic:
 *   total     = subscription.quotaBonus  (peak remaining at last top-up)
 *   remaining = atomic quota counter     (DECRBY'd by each successful relay)
 *   pct       = remaining / total * 100
 *
 * Alert thresholds (fire once per downward crossing):
 *   - pct ≤ 20  and  lastThresholdAlerted > 20 (or null)  → send "20% left"
 *   - pct ≤ 10  and  lastThresholdAlerted > 10 (or null)  → send "10% left"
 *
 * The hysteresis is stored in usage_alert:{addr}.lastThresholdAlerted and reset
 * to null by payment/activate on every credit grant. Without that reset the
 * cron would never re-alert a repeat customer who tops up, burns down, tops up
 * again — the intended behaviour is that each downward burn-down triggers one
 * email per tier, with a fresh cycle after each top-up.
 *
 * Outer guard: Vercel-issued `Authorization: Bearer ${CRON_SECRET}`. Fail-
 * closed when CRON_SECRET is unset so a leaked deployment URL cannot be used
 * to spray emails.
 *
 * Email dispatch is best-effort — one failed send does not block the rest of
 * the batch. Failures show up in the response counters + Resend dashboard.
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  const expected   = cronSecret ? `Bearer ${cronSecret}` : "";
  if (
    !cronSecret ||
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const base        = process.env.NEXT_PUBLIC_BASE_URL ?? "https://q402.quackai.ai";
  const dashboardUrl = `${base}/dashboard`;
  const paymentUrl   = `${base}/payment`;

  const addresses = await listUsageAlertAddresses();
  let checked  = 0;
  let alerted  = 0;
  let cleaned  = 0;  // orphan index entries removed (cfg vanished)
  let failed   = 0;

  for (const addrRaw of addresses) {
    const addr = (addrRaw ?? "").toLowerCase();
    if (!addr) continue;
    checked++;

    const [cfg, sub, remaining] = await Promise.all([
      getUsageAlert(addr),
      getSubscription(addr),
      getQuotaCredits(addr),
    ]);

    if (!cfg) {
      // Stale index entry — wipe so future runs skip it.
      await clearUsageAlert(addr).catch(() => {});
      cleaned++;
      continue;
    }
    const total = sub?.quotaBonus ?? 0;
    if (total <= 0) continue;  // nothing ever purchased — no denominator

    const tier = pickAlertTier({
      remaining,
      total,
      lastThresholdAlerted: cfg.lastThresholdAlerted,
    });
    if (!tier) continue;

    const { subject, html, text } = renderUsageAlertHtml({
      address:       addr,
      threshold:     tier,
      remainingTxs:  remaining,
      totalTxs:      total,
      dashboardUrl,
      paymentUrl,
    });
    const res = await sendEmail({ to: cfg.email, subject, html, text });
    if (res.ok) {
      await recordAlertSent(addr, tier).catch(() => {});
      alerted++;
    } else {
      failed++;
    }
  }

  return NextResponse.json({
    checked,
    alerted,
    cleaned,
    failed,
    timestamp: new Date().toISOString(),
  });
}
