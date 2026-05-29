/**
 * GET /api/cron/deposit-scan
 *
 * Background sweep that walks paid subscribers and credits any pending
 * native-coin deposits the user hasn't explicitly verified yet. Closes
 * the most-frequent support pattern: "I sent BNB / ETH / AVAX to the
 * Gas Tank, but it didn't show up." The user's "Verify" button stays
 * available as the immediate self-serve path; the cron is the safety
 * net behind it.
 *
 * Schedule: external HTTP heartbeat (Render viz-backend hits this every
 * 5 minutes). Vercel Hobby's daily-only cron cap doesn't apply because
 * we don't register the schedule in vercel.json — the Render-side
 * `deposit-trigger` keeps the cadence, mirroring how recurring-payouts
 * is driven.
 *
 * Auth: shared `CRON_SECRET` via Authorization header (`requireCronAuth`,
 * timing-safe). Same fail-closed posture as gas-alert / usage-alert /
 * recurring-payouts.
 *
 * Index choice — `sub:*` (paid subscribers ONLY):
 *   - Trial-tier users have sponsored gas; they never deposit native
 *     coin to the Gas Tank, so scanning them is pure waste.
 *   - `gasdep:*` (previously used) only contains owners with ≥1
 *     already-credited deposit — so the cohort the cron is supposed to
 *     help (new depositors who haven't tapped Verify) is structurally
 *     excluded. Fatal design flaw if used.
 *   - `apikey:*` would include sandbox + trial keys, requiring extra
 *     per-record filtering and bloating the scan range. Lower-overhead
 *     to start with the narrower paid pool.
 *
 * Cursor handling: KV `cron:deposit-scan:cursor`. Each tick pulls up
 * to `MAX_USERS_PER_RUN` paid owners from the cursor, scans 9 chains
 * in parallel, persists the next cursor. On wrap (cursor === "0") the
 * next tick restarts the keyspace. With MAX_USERS_PER_RUN=1 and a 5-
 * minute heartbeat, the full sweep at 151 paid users ≈ 12.5h — every
 * paid owner gets re-scanned roughly twice a day with zero per-tick
 * timeout risk. Tunable per growth via `DEPOSIT_SCAN_BATCH` env.
 *
 * Vercel Hobby budget — at 5 min × ~30s per call (Monad's wide window
 * dominates) the cron consumes ~72 GB-h/month, well under the 100
 * GB-h Hobby ceiling. Raising MAX_USERS_PER_RUN multiplies wall time
 * (chains run parallel per-owner, owners run sequential) — re-budget
 * before bumping.
 *
 * Partial-failure surfacing: `scanNativeDeposits` returns
 * `{deposits, chunkFailures, chunkTotal}`. The response distinguishes
 * "0 deposits, all chunks OK" from "0 deposits, half the chunks
 * dropped" so the operator (or future alerting) can tell silence from
 * blindness.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { addGasDeposit } from "@/app/lib/db";
import { requireCronAuth } from "@/app/lib/cron-auth";
import {
  DEPOSIT_CHAINS,
  scanNativeDeposits,
  notifyTelegramDeposit,
} from "@/app/lib/deposit-scanner";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 60;

const CURSOR_KEY = "cron:deposit-scan:cursor";
const SCAN_COUNT = 200;
/**
 * Owners processed per heartbeat. Default 1 — keeps wall time deterministic
 * (max single-owner = Monad's ~30s parallel scan) and the per-month
 * Vercel Hobby GB-h budget comfortably under the 100 ceiling at 5-min
 * cadence. Tune via DEPOSIT_SCAN_BATCH env when the paid pool outgrows
 * the cycle time, but re-budget before bumping (owners are sequential).
 */
const MAX_USERS_PER_RUN = parseInt(
  process.env.DEPOSIT_SCAN_BATCH ?? "1",
  10,
);
/**
 * Defensive — even a misbehaving KV server-side cursor shouldn't be
 * able to burn the function timeout on raw SCAN iterations.
 */
const MAX_SCAN_ITERS = 10_000;

/** `sub:{0x40-hex}` — match address-suffixed subscription record keys. */
const SUB_KEY_RE = /^sub:(0x[0-9a-fA-F]{40})$/;

interface OwnerResult {
  address: string;
  newDeposits: number;
  failedChains: string[];
  partialChains: { chain: string; chunkFailures: number; chunkTotal: number }[];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();

  // Resume from the saved cursor. Redis SCAN uses "0" to mean "start".
  const savedCursor = await kv.get<string>(CURSOR_KEY);
  let cursor: string | number = savedCursor ?? 0;
  if (cursor === "0") cursor = 0;

  const addresses: string[] = [];
  let scannedKeys = 0;
  let scanIters = 0;
  let wrapped = false;

  do {
    let page: string[];
    try {
      const res: [string | number, string[]] = await kv.scan(cursor, {
        match: "sub:*",
        count: SCAN_COUNT,
      });
      cursor = res[0];
      page = res[1];
    } catch (e) {
      console.error("[deposit-scan] kv.scan failed:", e);
      await recordCronStatus(CRON_NAMES.DEPOSIT_SCAN, {
        lastStatus: "error",
        lastError: `kv_scan_failed: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ error: "kv_scan_failed" }, { status: 502 });
    }
    scanIters++;
    scannedKeys += page.length;

    for (const key of page) {
      const m = SUB_KEY_RE.exec(key);
      if (!m) continue;
      addresses.push(m[1].toLowerCase());
      if (addresses.length >= MAX_USERS_PER_RUN) break;
    }

    if (addresses.length >= MAX_USERS_PER_RUN) break;
    if (String(cursor) === "0") { wrapped = true; break; }
    if (scanIters > MAX_SCAN_ITERS) break;
  } while (true);

  // Persist cursor BEFORE scanning work. If per-chain RPC walks hit the
  // function timeout, the cursor still moves so the next tick doesn't
  // replay the same owners forever — the timed-out owners just get their
  // turn one cycle later.
  await kv.set(CURSOR_KEY, String(cursor));

  // Process owners sequentially (per-owner wall time is bounded by the
  // slowest chain, ~30s on Monad). Per-chain RPC failures stay isolated
  // to that chain via Promise.allSettled.
  let newDeposits = 0;
  const perOwner: OwnerResult[] = [];

  for (const address of addresses) {
    const failedChains: string[] = [];
    const partialChains: OwnerResult["partialChains"] = [];
    let ownerCredits = 0;
    const results = await Promise.allSettled(
      DEPOSIT_CHAINS.map((chain) =>
        scanNativeDeposits(chain, address).then((scan) => ({ chain, scan })),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled") {
        failedChains.push(DEPOSIT_CHAINS[i].key);
        continue;
      }
      const { chain, scan } = r.value;
      if (scan.chunkFailures > 0) {
        partialChains.push({
          chain: chain.key,
          chunkFailures: scan.chunkFailures,
          chunkTotal: scan.chunkTotal,
        });
      }
      for (const tx of scan.deposits) {
        const added = await addGasDeposit(address, {
          chain: chain.key,
          token: chain.token,
          amount: tx.amount,
          txHash: tx.txHash,
          depositedAt: new Date().toISOString(),
        });
        if (added) {
          ownerCredits++;
          newDeposits++;
          await notifyTelegramDeposit({
            address,
            chain,
            amount: tx.amount,
            txHash: tx.txHash,
            source: "cron",
          });
        }
      }
    }
    perOwner.push({ address, newDeposits: ownerCredits, failedChains, partialChains });
  }

  const durationMs = Date.now() - startedAt;
  await recordCronStatus(CRON_NAMES.DEPOSIT_SCAN, {
    lastStatus: "success",
    lastResult: {
      addressesScanned: addresses.length,
      newDeposits,
      wrapped,
      partialChainCount: perOwner.reduce((s, o) => s + o.partialChains.length, 0),
      failedChainCount: perOwner.reduce((s, o) => s + o.failedChains.length, 0),
    },
    durationMs,
  });
  return NextResponse.json({
    addressesScanned: addresses.length,
    scannedKeys,
    scanIterations: scanIters,
    newDeposits,
    cursor: String(cursor),
    wrapped,
    perOwner: perOwner.slice(0, 50),
    durationMs,
    asOf: new Date().toISOString(),
  });
}
