/**
 * GET /api/cron/cron-watchdog
 *
 * Vercel-native staleness watchdog. Most Q402 crons (deposit-scan,
 * ofac-refresh, treasury-rebalance, …) are driven by an EXTERNAL Render
 * heartbeat. If that heartbeat dies, those crons silently stop and their
 * `cron:status:{name}` rows simply freeze — nothing in-repo notices.
 *
 * This route closes that gap: it runs on VERCEL infra (scheduled in
 * vercel.json, independent of Render), reads every tracked cron's last
 * execution, and pages ops when any cron has gone stale past its
 * CRON_META.staleAfterMs window (or never reported in at all). A Render
 * outage now produces an alert instead of an invisible incident.
 *
 * Auth: shared CRON_SECRET via requireCronAuth (same as every other cron).
 */

import { NextRequest, NextResponse } from "next/server";

import { requireCronAuth } from "@/app/lib/cron-auth";
import {
  getCronStatus,
  recordCronStatus,
  CRON_NAMES,
  CRON_META,
  type CronName,
} from "@/app/lib/cron-status";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

export const runtime = "nodejs";

/** Crons this watchdog checks. Every CRON_META entry EXCEPT the watchdog
 *  itself (it can't meaningfully watch its own liveness). Kept derived so a
 *  new cron added to CRON_META is auto-watched. */
const WATCHED: CronName[] = (Object.keys(CRON_META) as CronName[]).filter(
  (n) => n !== CRON_NAMES.CRON_WATCHDOG,
);

interface StaleEntry {
  name: CronName;
  ageMs: number | null; // null = never fired
  staleAfterMs: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();
  const stale: StaleEntry[] = [];

  await Promise.all(
    WATCHED.map(async (name) => {
      const meta = CRON_META[name];
      const rec = await getCronStatus(name);
      if (!rec) {
        // Never reported in — treat as stale so a cron that was supposed to
        // be wired but isn't (the relayer-balance / ccip-reconcile class of
        // bug) surfaces immediately rather than staying invisible.
        stale.push({ name, ageMs: null, staleAfterMs: meta.staleAfterMs });
        return;
      }
      const ageMs = startedAt - rec.lastFiredAt;
      if (ageMs > meta.staleAfterMs) {
        stale.push({ name, ageMs, staleAfterMs: meta.staleAfterMs });
      }
    }),
  );

  if (stale.length > 0) {
    const lines = stale
      .map((s) => {
        const age =
          s.ageMs === null
            ? "NEVER fired"
            : `${Math.round(s.ageMs / 60000)}m stale (limit ${Math.round(s.staleAfterMs / 60000)}m)`;
        return `• ${s.name}: ${age}`;
      })
      .join("\n");
    await sendOpsAlert(
      `cron-watchdog: ${stale.length} cron(s) STALE — their trigger (Render heartbeat / Vercel cron) may be down. ` +
        `Deposits, sanctions refresh, treasury refill or relayer-reserve alerts could be silently stopped.\n${lines}`,
      "critical",
    );
  }

  await recordCronStatus(CRON_NAMES.CRON_WATCHDOG, {
    lastStatus: "success",
    lastResult: { watched: WATCHED.length, staleCount: stale.length, stale: stale.map((s) => s.name) },
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    ok: true,
    watched: WATCHED.length,
    staleCount: stale.length,
    stale: stale.map((s) => ({ name: s.name, ageMs: s.ageMs })),
  });
}
