import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  listUsageAlertAddresses,
  getUsageAlert,
  getSubscription,
  getQuotaCredits,
  recordAlertSent,
  clearUsageAlert,
  listTrialSubscriptionAddresses,
  getTrialAlertState,
  recordTrialAlertSent,
  removeTrialSubscriptionFromIndex,
} from "@/app/lib/db";
import {
  sendEmail,
  renderUsageAlertHtml,
  renderTrialExpiryHtml,
} from "@/app/lib/email";
import { pickAlertTier } from "@/app/lib/alert-tier";

// Trial-expiry reminder tiers (in days). Mirror the 20%/10% downward
// hysteresis used by the credit-low alerts: a tier fires exactly once when
// daysLeft first crosses below the threshold.
const TRIAL_ALERT_TIERS = [7, 3, 1] as const;

function pickTrialTier(daysLeft: number, lastAlerted: number | null): number | null {
  for (const tier of TRIAL_ALERT_TIERS) {
    if (daysLeft <= tier) {
      if (lastAlerted == null || lastAlerted > tier) return tier;
    }
  }
  return null;
}

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

  // ── Trial expiration reminders (7d / 3d / 1d) ───────────────────────────
  // Separate index from usage_alert because trial users don't opt-in via the
  // dashboard email settings — their email is captured at signup. The index
  // is populated by /api/trial/activate when finalEmail is present.
  const trialAddrs = await listTrialSubscriptionAddresses();
  let trialChecked = 0;
  let trialAlerted = 0;
  let trialPruned = 0;
  let trialFailed = 0;

  for (const addrRaw of trialAddrs) {
    const addr = (addrRaw ?? "").toLowerCase();
    if (!addr) continue;
    trialChecked++;

    const sub = await getSubscription(addr);
    if (!sub || sub.plan !== "trial" || !sub.trialExpiresAt || !sub.email) {
      // Subscription was upgraded to paid, expired and was overwritten, or
      // never had an email. Drop the index entry so future runs skip it.
      await removeTrialSubscriptionFromIndex(addr).catch(() => {});
      trialPruned++;
      continue;
    }

    const msLeft = new Date(sub.trialExpiresAt).getTime() - Date.now();
    const daysLeft = Math.ceil(msLeft / 86_400_000);

    // Expired: clean up and skip. The trial's effects (revoked live key,
    // blocked relays) are enforced at request time elsewhere — the cron's
    // only responsibility is the reminder email.
    if (daysLeft <= 0) {
      await removeTrialSubscriptionFromIndex(addr).catch(() => {});
      trialPruned++;
      continue;
    }

    const state = await getTrialAlertState(addr);
    const tier = pickTrialTier(daysLeft, state?.lastDaysAlerted ?? null);
    if (!tier) continue;

    const { subject, html, text } = renderTrialExpiryHtml({
      email: sub.email,
      daysLeft,
      trialExpiresAt: sub.trialExpiresAt,
      paymentUrl,
      dashboardUrl,
    });
    const res = await sendEmail({ to: sub.email, subject, html, text });
    if (res.ok) {
      await recordTrialAlertSent(addr, tier).catch(() => {});
      trialAlerted++;
    } else {
      trialFailed++;
    }
  }

  return NextResponse.json({
    checked,
    alerted,
    cleaned,
    failed,
    trial: {
      checked: trialChecked,
      alerted: trialAlerted,
      pruned: trialPruned,
      failed: trialFailed,
    },
    timestamp: new Date().toISOString(),
  });
}
