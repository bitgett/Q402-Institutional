/**
 * cron-status — running snapshot of each cron's last execution so the
 * operator can answer "did it actually fire?" without scrolling Vercel
 * logs or Render dashboards.
 *
 * Two cron callers matter here:
 *   - `/api/cron/recurring-payouts` — driven by the Render viz-backend
 *     `recurring-trigger` (hourly). If Render dies, hourly-cadence rules
 *     stall until the Vercel daily backstop catches up.
 *   - `/api/cron/deposit-scan` — driven by Render `deposit-trigger`
 *     (every 5 min). If Render dies, native deposits sit unverified
 *     until the user taps "Verify" or Render recovers.
 *
 * Both cron handlers wrap their final response with `recordCronStatus`
 * so the KV row is updated on EVERY tick, including failures. The
 * admin endpoint `/api/admin/cron-status` reads these rows and returns
 * `{ name, lastFiredAt, ageMs, lastStatus, lastResult, lastError }` so
 * an external watchdog (or a future dashboard widget) can alert when
 * `ageMs` exceeds the cron's expected interval × a tolerance.
 *
 * Storage: `cron:status:{name}` → JSON blob. One key per cron, capped
 * payload (we only keep the most recent execution — historical trend
 * tracking is out of scope; relaytx history covers per-rule audit).
 */

import { kv } from "@vercel/kv";

export interface CronStatusRecord {
  name: string;
  lastFiredAt: number;
  lastStatus: "success" | "error";
  lastResult?: unknown;
  lastError?: string;
  durationMs?: number;
}

const statusKey = (name: string) => `cron:status:${name}`;

/**
 * Persist the latest tick's outcome. Errors here are swallowed — the
 * cron's own work has either succeeded or failed independently of the
 * status write, and we never want a KV blip to cascade into "cron
 * silently stopped firing" by throwing in the response path.
 */
export async function recordCronStatus(
  name: string,
  patch: Omit<CronStatusRecord, "name" | "lastFiredAt"> & { lastFiredAt?: number },
): Promise<void> {
  try {
    const record: CronStatusRecord = {
      name,
      lastFiredAt: patch.lastFiredAt ?? Date.now(),
      lastStatus: patch.lastStatus,
      lastResult: patch.lastResult,
      lastError: patch.lastError,
      durationMs: patch.durationMs,
    };
    await kv.set(statusKey(name), record);
  } catch (e) {
    // Best-effort logging — the cron itself still completed.
    console.error(`[cron-status] recordCronStatus(${name}) failed:`, e);
  }
}

/** Fetch the most recent execution snapshot for `name`, or null when
 *  the cron has never reported in (e.g. fresh deploy, status writer
 *  not wired up yet). */
export async function getCronStatus(name: string): Promise<CronStatusRecord | null> {
  try {
    return (await kv.get<CronStatusRecord>(statusKey(name))) ?? null;
  } catch (e) {
    console.error(`[cron-status] getCronStatus(${name}) failed:`, e);
    return null;
  }
}

/** Cron names we track. Adding a new cron = add the constant here AND
 *  call `recordCronStatus(name, ...)` from that cron's route handler. */
export const CRON_NAMES = {
  RECURRING_PAYOUTS: "recurring-payouts",
  DEPOSIT_SCAN: "deposit-scan",
} as const;
export type CronName = typeof CRON_NAMES[keyof typeof CRON_NAMES];
