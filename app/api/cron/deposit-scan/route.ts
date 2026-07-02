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
 * Index choice — `sub:*` (any subscription record holder):
 *   - This is every address that has ever held a subscription record,
 *     including currently-cancelled or lapsed ones. We don't filter on
 *     an `active` field here because cancelled subscribers can still
 *     have funds in flight to the Gas Tank (e.g. they cancelled, then
 *     a delayed deposit lands a day later). Crediting that deposit is
 *     correct behavior; scanning them is correct too.
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
 * Per-CHAIN sweep (NOT per-owner): the gas tank is a single address, so one
 * block-walk per chain reveals EVERY owner's native deposit to it in the
 * recent window. Each tick enumerates the paid-owner set, scans all 12 chains
 * in parallel (recent `PER_CHAIN_BLOCK_CAP` window, bounded by
 * `SCAN_DEADLINE_MS`), and credits the senders that are in the owner set.
 * Because every chain is swept every ~10-min heartbeat, the recent window is
 * covered every ~10 min for ALL owners — no owner cursor, no ~14.75h revisit
 * gap (the old 1-owner-per-tick cursor took that long to revisit an owner,
 * far longer than the window, so most un-verified deposits were missed), and
 * no wedge risk. `addGasDeposit` dedups by txHash, so overlapping windows
 * across ticks never double-credit.
 *
 * Timeout safety: `SCAN_DEADLINE_MS` (45s) halts each chain's walk before the
 * 60s function ceiling. A deadline-cut or RPC-failed chain just covers fewer
 * blocks this tick; the next tick (~5 min later) re-covers the overlapping
 * recent window, so no deposit is lost.
 *
 * Partial-failure surfacing: `scanNativeDeposits` returns
 * `{deposits, chunkFailures, chunkTotal}`. The response distinguishes
 * "0 deposits, all chunks OK" from "0 deposits, half the chunks
 * dropped" so the operator (or future alerting) can tell silence from
 * blindness.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { addGasDeposit, addLinkDeposit } from "@/app/lib/db";
import { requireCronAuth } from "@/app/lib/cron-auth";
import {
  DEPOSIT_CHAINS,
  LINK_DEPOSIT_CHAINS,
  scanNativeDeposits,
  scanLinkDeposits,
  notifyTelegramDeposit,
} from "@/app/lib/deposit-scanner";
import { GASTANK_ADDRESS } from "@/app/lib/wallets";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 60;

const SCAN_COUNT = 200;

/**
 * Hard cap on blocks walked per chain per heartbeat. The walker batches 20
 * blocks/request behind a 6s per-batch RPC timeout, so N blocks ≈ ceil(N/20)
 * sequential batches. At 1000 that's ≤50 batches/chain — fine when RPCs are
 * healthy, but a dragging endpoint (Injective ~3.9s/batch) makes 50 sequential
 * batches ≈ 195s, far past the 60s ceiling. So the cap alone does NOT bound
 * wall time — the real timeout guard is `SCAN_DEADLINE_MS`, an absolute
 * deadline passed into every scan that halts the walk well before 60s.
 *
 * The cap limits the MOST-RECENT window walked per chain per tick. Since every
 * chain is swept every ~10-min tick, the recent window stays covered for ALL
 * owners without a one-shot full-window sweep; a chunk-failed / deadline-cut
 * chain is re-covered on the next tick via the overlapping window. Tunable via
 * DEPOSIT_SCAN_BLOCK_CAP env.
 */
const _blockCapRaw = parseInt(process.env.DEPOSIT_SCAN_BLOCK_CAP ?? "1000", 10);
const PER_CHAIN_BLOCK_CAP =
  Number.isFinite(_blockCapRaw) && _blockCapRaw > 0 ? _blockCapRaw : 1000;
/**
 * Defensive — even a misbehaving KV server-side cursor shouldn't be
 * able to burn the function timeout on raw SCAN iterations.
 */
const MAX_SCAN_ITERS = 10_000;

/**
 * Soft wall-clock budget for the per-chain block walk, well below
 * maxDuration=60 with headroom for the tip fetch (≤5s/chain) + finalize.
 * Passed as an absolute deadline into every `scanNativeDeposits` call so
 * the walker stops launching batches once it elapses and returns its
 * partial range. The function therefore NEVER hard-times-out: the slice
 * finalizes gracefully (recordCronStatus fires, cursor advances) and the
 * overlapping recent window carries any unscanned tail to the owner's
 * next cycle. This is the structural guard that survives ANY single slow
 * RPC — the Injective endpoint (~3.9s/batch) was dragging the function
 * into repeated 60s kills (82% error rate) before this existed.
 */
const SCAN_DEADLINE_MS = 45_000;

/** `sub:{0x40-hex}` — match address-suffixed subscription record keys. */
const SUB_KEY_RE = /^sub:(0x[0-9a-fA-F]{40})$/;

interface ChainResult {
  chain: string;
  failed: boolean;
  credited: number;
  chunkFailures: number;
  chunkTotal: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();

  // ── Owner set ─────────────────────────────────────────────────────────
  // Enumerate EVERY paid owner into a set. We scan each CHAIN once per tick
  // (not each owner): a single block-walk per chain reveals every owner's
  // gas-tank deposit in the window, and we credit the senders that are in this
  // set. This drops the old per-owner cursor entirely — every owner is covered
  // on EVERY tick, so a deposit can't age out of the recent window before its
  // owner is re-reached. (The old 1-owner-per-tick cursor took ~14.75h to
  // revisit an owner, far longer than the ~10–60 min recent window, so most
  // un-verified deposits were missed by the cron.)
  const ownerSet = new Set<string>();
  let scanCursor: string | number = 0;
  let scanIters = 0;
  do {
    let res: [string | number, string[]];
    try {
      res = await kv.scan(scanCursor, { match: "sub:*", count: SCAN_COUNT });
    } catch (e) {
      console.error("[deposit-scan] kv.scan failed:", e);
      await recordCronStatus(CRON_NAMES.DEPOSIT_SCAN, {
        lastStatus: "error",
        lastError: `kv_scan_failed: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ error: "kv_scan_failed" }, { status: 502 });
    }
    scanCursor = res[0];
    for (const key of res[1]) {
      const m = SUB_KEY_RE.exec(key);
      if (m) ownerSet.add(m[1].toLowerCase());
    }
    scanIters++;
  } while (String(scanCursor) !== "0" && scanIters <= MAX_SCAN_ITERS);

  const ownerCount = ownerSet.size;

  // ── LINK deposit sweep (CCIP bridge Gas Tank) ──────────────────────────
  // One getLogs per CCIP chain reveals every LINK transfer to the
  // facilitator — credit each sender to their LINK Gas Tank slot
  // regardless of whether they appear in this tick's `addresses` slice.
  // This is decoupled from the per-owner native scan because (a) LINK
  // deposits are low-volume so the per-tick cost is bounded, and (b)
  // crediting only when the owner happens to land in the cursor window
  // would create a long-tail "I sent LINK but the dashboard still says
  // 0" support pattern.
  //
  // Wrapped in a try/catch around the WHOLE block: if any single
  // matching deposit's addLinkDeposit() raises (WRONGTYPE on legacy
  // keys, KV transient, etc.), the per-owner native scan below MUST
  // still run + recordCronStatus MUST still fire. Otherwise the cron
  // silently flatlines (lastFiredAt stuck) and ops only notices via
  // a missed deposit ticket.
  let linkDepositsCredited = 0;
  const linkFailedChains: string[] = [];
  let linkSweepError: string | null = null;
  try {
    const linkResults = await Promise.allSettled(
      LINK_DEPOSIT_CHAINS.map((chain) =>
        scanLinkDeposits(chain, GASTANK_ADDRESS).then((scan) => ({ chain, scan })),
      ),
    );
    for (let i = 0; i < linkResults.length; i++) {
      const r = linkResults[i];
      if (r.status !== "fulfilled") {
        linkFailedChains.push(LINK_DEPOSIT_CHAINS[i].key);
        continue;
      }
      const { chain, scan } = r.value;
      if (scan.rpcCallFailed) {
        linkFailedChains.push(chain.key);
        continue;
      }
      for (const m of scan.matches) {
        // Skip zero-value transfers — defensive against tokens whose
        // transferFrom emits a Transfer with zero amount as a side
        // effect (none of the CCIP LINK tokens do today, but free).
        if (m.amount <= 0) continue;
        try {
          const added = await addLinkDeposit(m.fromAddress.toLowerCase(), {
            chain: chain.key,
            amount: m.amount,
            txHash: m.txHash,
            depositedAt: new Date().toISOString(),
          });
          if (added) linkDepositsCredited++;
        } catch (e) {
          // Per-match isolation: a bad KV write on one match doesn't
          // poison the rest of the LINK sweep or the surrounding native
          // scan loop.
          console.error("[deposit-scan] addLinkDeposit failed", {
            owner:   m.fromAddress,
            chain:   chain.key,
            txHash:  m.txHash,
            err:     e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  } catch (e) {
    linkSweepError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    console.error("[deposit-scan] LINK sweep threw:", e);
  }

  // ── Native deposit sweep — once PER CHAIN, covering ALL owners ──────────
  // One block-walk per chain (recent PER_CHAIN_BLOCK_CAP window) surfaces
  // every gas-tank deposit in that window from ANY sender; we then credit the
  // senders that are paid owners. Chains run in parallel, bounded by
  // SCAN_DEADLINE_MS so one slow RPC (e.g. Injective ~3.9s/batch) can't drag
  // the function past the 60s ceiling. Per-chain RPC failures stay isolated
  // via Promise.allSettled. Because every chain is scanned every tick, the
  // recent window is covered every ~10 min for ALL owners — no cursor, no
  // 14.75h revisit gap, no wedge. addGasDeposit dedups by txHash, so the
  // overlapping windows across ticks never double-credit.
  let newDeposits = 0;
  const perChain: ChainResult[] = [];
  let sweepError: string | null = null;
  try {
    const results = await Promise.allSettled(
      DEPOSIT_CHAINS.map((chain) =>
        scanNativeDeposits(chain, null, {
          maxBlocks: PER_CHAIN_BLOCK_CAP,
          deadline: startedAt + SCAN_DEADLINE_MS,
        }).then((scan) => ({ chain, scan })),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled") {
        perChain.push({ chain: DEPOSIT_CHAINS[i].key, failed: true, credited: 0, chunkFailures: 0, chunkTotal: 0 });
        continue;
      }
      const { chain, scan } = r.value;
      let credited = 0;
      for (const tx of scan.deposits) {
        // Credit ONLY known paid owners — a native transfer to the gas tank
        // from an address outside the sub:* set isn't a subscriber top-up.
        if (!ownerSet.has(tx.fromAddress)) continue;
        try {
          const added = await addGasDeposit(tx.fromAddress, {
            chain: chain.key,
            token: chain.token,
            amount: tx.amount,
            txHash: tx.txHash,
            depositedAt: new Date().toISOString(),
          });
          if (added) {
            credited++;
            newDeposits++;
            await notifyTelegramDeposit({
              address: tx.fromAddress,
              chain,
              amount: tx.amount,
              txHash: tx.txHash,
              source: "cron",
            }).catch(() => { /* notify is best-effort */ });
          }
        } catch (e) {
          console.error("[deposit-scan] addGasDeposit failed", {
            address: tx.fromAddress,
            chain:  chain.key,
            txHash: tx.txHash,
            err:    e instanceof Error ? e.message : String(e),
          });
        }
      }
      perChain.push({ chain: chain.key, failed: false, credited, chunkFailures: scan.chunkFailures, chunkTotal: scan.chunkTotal });
    }
  } catch (e) {
    sweepError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    console.error("[deposit-scan] native sweep threw:", e);
  }

  const durationMs = Date.now() - startedAt;
  const partialChainCount = perChain.filter((c) => c.chunkFailures > 0).length;
  const failedChainCount = perChain.filter((c) => c.failed).length;
  const sweepHadError = linkSweepError !== null || sweepError !== null;
  await recordCronStatus(CRON_NAMES.DEPOSIT_SCAN, {
    lastStatus: sweepHadError ? "error" : "success",
    ...(sweepHadError
      ? {
          lastError: [
            linkSweepError ? `link_sweep: ${linkSweepError}` : null,
            sweepError ? `native_sweep: ${sweepError}` : null,
          ].filter(Boolean).join(" · "),
        }
      : {}),
    lastResult: {
      ownersTracked: ownerCount,
      newDeposits,
      linkDepositsCredited,
      linkFailedChains: linkFailedChains.length,
      linkSweepError,
      sweepError,
      // A chain with chunkFailures>0 / failed didn't fully cover its window
      // this tick; the overlapping recent window on the next tick (~5 min)
      // re-covers it, so no deposit is lost.
      partialChainCount,
      failedChainCount,
    },
    durationMs,
  });
  return NextResponse.json({
    ownersTracked: ownerCount,
    scanIterations: scanIters,
    newDeposits,
    linkDepositsCredited,
    linkFailedChains,
    perChain,
    partialChainCount,
    failedChainCount,
    durationMs,
    asOf: new Date().toISOString(),
  });
}
