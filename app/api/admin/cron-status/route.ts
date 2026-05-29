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

import { getCronStatus, CRON_NAMES, type CronStatusRecord } from "@/app/lib/cron-status";

export const runtime = "nodejs";

interface CronMeta {
  name: string;
  expectedIntervalMs: number;
  staleAfterMs: number;
}

const TRACKED: CronMeta[] = [
  {
    name: CRON_NAMES.RECURRING_PAYOUTS,
    expectedIntervalMs: 60 * 60 * 1000, // 1h Render heartbeat
    staleAfterMs: 75 * 60 * 1000, // 1.25× tolerance
  },
  {
    name: CRON_NAMES.DEPOSIT_SCAN,
    expectedIntervalMs: 5 * 60 * 1000, // 5min Render heartbeat
    staleAfterMs: 15 * 60 * 1000, // 3× tolerance — block-RPC slowness
  },
];

function checkAdminAuth(req: NextRequest): NextResponse | null {
  const adminSecret = process.env.ADMIN_SECRET;
  const presented = req.headers.get("x-q402-admin-key") ?? "";
  if (!adminSecret) {
    // No env = endpoint disabled. Fail-closed.
    return NextResponse.json({ error: "admin_disabled" }, { status: 503 });
  }
  if (presented.length !== adminSecret.length) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(adminSecret))) {
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
    TRACKED.map(async (meta) => {
      const rec: CronStatusRecord | null = await getCronStatus(meta.name);
      if (!rec) {
        return {
          name: meta.name,
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
        name: meta.name,
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
