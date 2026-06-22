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
 *     (every 10 min). If Render dies, native deposits sit unverified
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
  REPUTATION_WEEKLY: "reputation-weekly",
  RELAYER_BALANCE: "relayer-balance",
  CCIP_PENDING_FUND_RECONCILE: "ccip-pending-fund-reconcile",
  TREASURY_REBALANCE: "treasury-rebalance",
  OFAC_REFRESH: "ofac-refresh",
  CRON_WATCHDOG: "cron-watchdog",
} as const;
export type CronName = typeof CRON_NAMES[keyof typeof CRON_NAMES];

/**
 * Per-cron cadence metadata. Single source of truth for both the cron
 * driver (Render heartbeat interval) and the staleness watchdog (admin
 * endpoint), so adjusting one without the other can't slip a silent
 * "alive but reported stale" / "dead but reported fresh" mismatch.
 *
 * Tolerances:
 *   - recurring: 1.25× the heartbeat interval (75min for 1h cadence).
 *     Render restart + first-tick latency comfortably under this.
 *   - deposit: 3× the heartbeat (30min for 10min cadence). Block-RPC
 *     slowness on the widest chain (Monad ~30s wall) plus a missed
 *     tick during deploy stays under the threshold.
 */
export interface CronMeta {
  expectedIntervalMs: number;
  staleAfterMs: number;
}

export const CRON_META: Record<CronName, CronMeta> = {
  [CRON_NAMES.RECURRING_PAYOUTS]: {
    expectedIntervalMs: 60 * 60 * 1000,
    staleAfterMs: 75 * 60 * 1000,
  },
  [CRON_NAMES.DEPOSIT_SCAN]: {
    expectedIntervalMs: 10 * 60 * 1000,
    staleAfterMs: 30 * 60 * 1000,
  },
  // Weekly cadence — fires every Sunday 00:00 UTC. Stale window is 8d
  // so a single missed Sunday (e.g. Vercel cron blip) trips the alert
  // and a normal deploy doesn't.
  [CRON_NAMES.REPUTATION_WEEKLY]: {
    expectedIntervalMs: 7 * 24 * 60 * 60 * 1000,
    staleAfterMs: 8 * 24 * 60 * 60 * 1000,
  },
  // Relayer EOA balance probe — Vercel cron every 15 min. Stale window
  // 40 min (~2.7x cadence) so normal cron jitter doesn't false-page; a
  // genuinely stuck probe still surfaces quickly. A stuck probe means we
  // lose visibility into whether the hot wallet is about to dip.
  [CRON_NAMES.RELAYER_BALANCE]: {
    expectedIntervalMs: 15 * 60 * 1000,
    staleAfterMs: 40 * 60 * 1000,
  },
  // 6-hour Render heartbeat — sweeps GASTANK to Sender pools + relayer.
  // Was 15-min, but each sweep tops up to 2× threshold so a healthy
  // pool survives many bridges between refills; at early-launch
  // volume (single-digit bridges/day) the minutes-grained cadence
  // was over-frequent and produced ops-alert pressure on every
  // transient failure. Relayer-side gas is watched independently by
  // the relayer-balance cron (5 min), so this cron no longer needs
  // minutes-grained responsiveness. Stale window: 8h (~33% headroom
  // over cadence) so a single missed tick surfaces within a
  // sensible window without paging on tail latency.
  [CRON_NAMES.TREASURY_REBALANCE]: {
    expectedIntervalMs: 6 * 60 * 60 * 1000,
    staleAfterMs: 8 * 60 * 60 * 1000,
  },
  // Vercel cron every 15 min. Stale 40 min window (~2.7x cadence) so
  // normal jitter doesn't false-page; a stuck reconcile still surfaces —
  // it means relayer ETH could be sitting on Agent Wallets without the
  // matching Gas Tank debit, which is exactly the gap this cron closes.
  [CRON_NAMES.CCIP_PENDING_FUND_RECONCILE]: {
    expectedIntervalMs: 15 * 60 * 1000,
    staleAfterMs: 40 * 60 * 1000,
  },
  // OFAC sanctioned-address refresh — daily. The list only changes when
  // Treasury updates the SDN; a daily pull is ample. Stale window 50h
  // (~2× cadence) so one missed day trips the watchdog. The
  // ComplianceGate hook ALSO alerts on >48h staleness independently —
  // this entry is for the unified cron-status dashboard.
  [CRON_NAMES.OFAC_REFRESH]: {
    expectedIntervalMs: 24 * 60 * 60 * 1000,
    staleAfterMs: 50 * 60 * 60 * 1000,
  },
  // Vercel-native staleness watchdog — runs every 30 min on Vercel infra
  // (independent of the Render heartbeat that drives most other crons), so
  // a Render outage that silently stops deposit-scan / ofac / treasury is
  // DETECTED and paged here. Excluded from self-watch, so this window is
  // documentation-only; 75-min (~2.5x cadence) kept for consistency.
  [CRON_NAMES.CRON_WATCHDOG]: {
    expectedIntervalMs: 30 * 60 * 1000,
    staleAfterMs: 75 * 60 * 1000,
  },
};
