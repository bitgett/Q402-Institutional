/**
 * GET /api/admin/cron-status
 *
 * Operator-only snapshot of every tracked cron's last execution. Reads
 * the `cron:status:{name}` rows written by recurring-payouts /
 * deposit-scan and surfaces them with a derived `ageMs` so an external
 * watchdog (or the viz-backend) can alert when a cron has gone silent
 * for longer than its expected interval.
 *
 * Auth: shared `X-Q402-Admin-Key` header timing-safe-compared against
 * `ADMIN_SECRET` env. Same posture as `requireCronAuth` (fail-closed,
 * no token = 401, mismatched-length token = 401, no leaks via timing).
 * NOT owner-sig — this is system-wide state, not per-owner.
 *
 * Cadence expectations (used to compute `staleAfterMs`):
 *   - recurring-payouts: 1h heartbeat from Render `recurring-trigger`
 *     (plus Vercel daily backstop). Tolerance 75 min before "stale".
 *   - deposit-scan: 5min heartbeat from Render `deposit-trigger`.
 *     Tolerance 15 min before "stale".
 *
 * Response shape:
 *   { asOf, cron: [
 *     { name, lastFiredAt, ageMs, lastStatus, lastResult, lastError,
 *       expectedIntervalMs, staleAfterMs, isStale, durationMs }
 *   ]}
 *
 * Never reveals secrets — `lastResult` / `lastError` only carry whatever
 * the cron handler put in there (counts, status strings, error messages).
 * The cron handlers themselves are responsible for not stuffing PII in.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import {
  getCronStatus,
  CRON_NAMES,
  CRON_META,
  type CronName,
  type CronStatusRecord,
} from "@/app/lib/cron-status";

export const runtime = "nodejs";

/** Tracked cron list — derived from CRON_NAMES so adding a new cron
 *  in the lib auto-extends this endpoint. CRON_META supplies the
 *  expectedIntervalMs + staleAfterMs from the single source of truth. */
const TRACKED: CronName[] = [
  CRON_NAMES.RECURRING_PAYOUTS,
  CRON_NAMES.DEPOSIT_SCAN,
];

function checkAdminAuth(req: NextRequest): NextResponse | null {
  const adminSecret = process.env.ADMIN_SECRET;
  const presented = req.headers.get("x-q402-admin-key") ?? "";
  if (!adminSecret) {
    // No env = endpoint disabled. Fail-closed.
    return NextResponse.json({ error: "admin_disabled" }, { status: 503 });
  }
  // Compare on byte length — timingSafeEqual throws on length mismatch,
  // and `.length` on a String is char count, which silently diverges
  // from byteLength for non-ASCII admin secrets (BMP chars are 2-3
  // bytes in UTF-8). ADMIN_SECRET would typically be ASCII, but failing
  // closed on the byte view costs nothing and removes a latent mismatch.
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes  = Buffer.from(adminSecret, "utf8");
  if (presentedBytes.length !== expectedBytes.length) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (!timingSafeEqual(presentedBytes, expectedBytes)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = checkAdminAuth(req);
  if (denial) return denial;

  const now = Date.now();
  const rows = await Promise.all(
    TRACKED.map(async (name) => {
      const meta = CRON_META[name];
      const rec: CronStatusRecord | null = await getCronStatus(name);
      if (!rec) {
        return {
          name,
          lastFiredAt: null,
          ageMs: null,
          lastStatus: null,
          lastResult: null,
          lastError: null,
          durationMs: null,
          expectedIntervalMs: meta.expectedIntervalMs,
          staleAfterMs: meta.staleAfterMs,
          isStale: true,
          neverFired: true,
        };
      }
      const ageMs = now - rec.lastFiredAt;
      return {
        name,
        lastFiredAt: rec.lastFiredAt,
        ageMs,
        lastStatus: rec.lastStatus,
        lastResult: rec.lastResult ?? null,
        lastError: rec.lastError ?? null,
        durationMs: rec.durationMs ?? null,
        expectedIntervalMs: meta.expectedIntervalMs,
        staleAfterMs: meta.staleAfterMs,
        isStale: ageMs > meta.staleAfterMs,
        neverFired: false,
      };
    }),
  );

  return NextResponse.json({
    asOf: new Date(now).toISOString(),
    cron: rows,
  });
}
