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
 * Cursor handling: KV `cron:deposit-scan:cursor`. Each tick pulls up
 * to `MAX_USERS_PER_RUN` paid owners from the cursor, scans 10 chains
 * in parallel, and advances the cursor ONLY AFTER the slice is fully
 * scanned. On wrap (cursor === "0") the next tick restarts the keyspace.
 * With MAX_USERS_PER_RUN=1 and a 5-minute heartbeat, the full sweep at
 * 151 paid users ≈ 12.5h — every paid owner gets re-scanned roughly
 * twice a day with zero per-tick timeout risk. Tunable per growth via
 * `DEPOSIT_SCAN_BATCH` env.
 *
 * Durable progress (timeout safety): the owner cursor is NOT advanced
 * optimistically. A function timeout mid-scan leaves the cursor pinned
 * on the in-flight owner, so the next tick re-attempts THAT SAME owner
 * rather than skipping them. Re-scanning is safe + idempotent — the
 * storage layer (`addGasDeposit`) dedups by txHash, so a replayed owner
 * never double-credits. This trades a (cheap, idempotent) re-scan for a
 * guarantee that a timeout can never skip an unscanned depositor.
 *
 * Per-chain chunking: each chain's per-owner scan is capped at
 * `PER_CHAIN_BLOCK_CAP` blocks (the most-recent slice). Wide-window
 * chains (Monad 6000, Arbitrum 5000, Scroll 1200 blocks) used to walk
 * their FULL window for every owner in one tick — Monad alone is 300
 * sequential RPC batches, the dominant 504 source. With the cap each
 * owner's whole 10-chain scan is bounded to ~50 batches on its slowest
 * chain, well under the 60s budget, and the overlapping recent window on
 * the owner's next cycle keeps the deposit-relevant range covered.
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

const CURSOR_KEY = "cron:deposit-scan:cursor";
const SCAN_COUNT = 200;

/**
 * Hard cap on blocks walked per chain per owner per heartbeat. The
 * walker batches 20 blocks/request behind a 6s per-batch RPC timeout, so
 * N blocks ≈ ceil(N/20) sequential batches. At 1000 that's ≤50
 * batches/chain — fine when RPCs are healthy, but a dragging endpoint
 * (Injective was averaging ~3.9s/batch) makes 50 sequential batches
 * ≈ 195s, far past the 60s ceiling. So the block cap alone does NOT
 * bound wall time — the real timeout guard is `SCAN_DEADLINE_MS`, an
 * absolute deadline passed into every scan that halts the walk well
 * before 60s. This cap still limits the most-recent window walked per
 * tick; the overlapping window on the owner's next cycle keeps coverage.
 *
 * Before this cap a single owner walked the FULL window of every chain
 * in one tick — Monad's 6000-block window alone is 300 sequential
 * batches, which intermittently 504'd the function. The cap scans the
 * most-recent `PER_CHAIN_BLOCK_CAP` blocks per chain instead; the cron
 * re-visits each owner every cycle with an overlapping recent window, so
 * the deposit-relevant window stays covered without a one-shot full
 * sweep. Tunable via DEPOSIT_SCAN_BLOCK_CAP env.
 */
const _blockCapRaw = parseInt(process.env.DEPOSIT_SCAN_BLOCK_CAP ?? "1000", 10);
const PER_CHAIN_BLOCK_CAP =
  Number.isFinite(_blockCapRaw) && _blockCapRaw > 0 ? _blockCapRaw : 1000;
/**
 * Owners processed per heartbeat. Default 1 — keeps wall time deterministic
 * (max single-owner = Monad's ~30s parallel scan) and the per-month
 * Vercel Hobby GB-h budget comfortably under the 100 ceiling at 5-min
 * cadence. Tune via DEPOSIT_SCAN_BATCH env when the paid pool outgrows
 * the cycle time, but re-budget before bumping (owners are sequential).
 *
 * NaN-resistant: a malformed env value (`DEPOSIT_SCAN_BATCH=abc`,
 * leading whitespace, etc.) would otherwise yield NaN and silently
 * cripple the `addresses.length >= MAX_USERS_PER_RUN` break condition,
 * letting the SCAN loop run to the cursor-wrap or MAX_SCAN_ITERS
 * defensive cap instead of the intended per-tick budget.
 */
const _maxUsersRaw = parseInt(process.env.DEPOSIT_SCAN_BATCH ?? "1", 10);
const MAX_USERS_PER_RUN =
  Number.isFinite(_maxUsersRaw) && _maxUsersRaw > 0 ? _maxUsersRaw : 1;
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

  // NOTE: the owner cursor is intentionally NOT persisted here. It is
  // advanced only AFTER the per-owner native scan slice below completes
  // (see "advance owner cursor" block). A function timeout mid-scan must
  // leave the cursor pinned on the in-flight owner so the next tick
  // re-attempts them — never skips an unscanned depositor.

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

  // Process owners sequentially. Per-owner wall time is now bounded by
  // PER_CHAIN_BLOCK_CAP (chains run in parallel, so the slowest single
  // chain ≤ ceil(cap/20) batches), not by the widest chain's full
  // window — that window is walked across multiple ticks via the
  // per-(owner,chain) block cursor. Per-chain RPC failures stay isolated
  // to that chain via Promise.allSettled.
  let newDeposits = 0;
  const perOwner: OwnerResult[] = [];
  // Did the per-owner loop run to completion for this slice? Gates the
  // owner-cursor advance: only a fully-scanned slice moves the cursor, so
  // a mid-slice throw (or a function timeout, which never reaches the
  // advance at all) holds the cursor and the slice is re-attempted next
  // tick instead of being skipped.
  let sliceCompleted = true;

  // Per-owner native scan, wrapped in a try/catch per owner so a single
  // misbehaving address (e.g. a KV WRONGTYPE on its gasdep:* list, or a
  // Telegram fetch hiccup that bubbles up) doesn't poison the rest of
  // the slice or strand recordCronStatus at the bottom.
  let perOwnerError: string | null = null;
  try {
    for (const address of addresses) {
      const failedChains: string[] = [];
      const partialChains: OwnerResult["partialChains"] = [];
      let ownerCredits = 0;

      // Bound per-chain work to PER_CHAIN_BLOCK_CAP blocks so one owner's
      // wide-window chains (Monad 6000, Arbitrum 5000, Scroll 1200) can't
      // blow the 60s budget. We scan the MOST-RECENT cap blocks per chain
      // — deposits land newest-first, and the cron re-visits each owner
      // each cycle with an overlapping recent window, so the relevant
      // deposit window stays covered without a one-shot full-window sweep.
      const results = await Promise.allSettled(
        DEPOSIT_CHAINS.map((chain) =>
          scanNativeDeposits(chain, address, {
            maxBlocks: PER_CHAIN_BLOCK_CAP,
            deadline: startedAt + SCAN_DEADLINE_MS,
          }).then((scan) => ({ chain, scan })),
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
          try {
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
              }).catch(() => { /* notify is best-effort */ });
            }
          } catch (e) {
            console.error("[deposit-scan] addGasDeposit failed", {
              address,
              chain:  chain.key,
              txHash: tx.txHash,
              err:    e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      perOwner.push({ address, newDeposits: ownerCredits, failedChains, partialChains });
    }
  } catch (e) {
    perOwnerError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    console.error("[deposit-scan] per-owner loop threw:", e);
    // An exception mid-slice means we did NOT finish scanning this slice.
    // Hold the owner cursor so the next tick replays it (idempotent via
    // addGasDeposit dedup) rather than skipping the unscanned remainder.
    sliceCompleted = false;
  }

  // ── Advance the owner cursor — ONLY after the slice was scanned ────────
  // Durability fix: a function timeout earlier in this handler never
  // reaches this line, so the cursor stays pinned on the in-flight slice
  // and the NEXT tick re-attempts those same owners — an unscanned
  // depositor is never skipped. We advance only when the per-owner loop
  // ran to completion for the whole slice. A single chain's RPC failure
  // for an owner does NOT hold the cursor: the original design tolerates
  // that via the overlapping recent window on the owner's next cycle, so
  // a chronically-flaky chain can't wedge the whole sweep on one owner.
  if (sliceCompleted) {
    try {
      await kv.set(CURSOR_KEY, String(cursor));
    } catch (e) {
      console.error("[deposit-scan] owner cursor set failed:", e);
    }
  }

  const durationMs = Date.now() - startedAt;
  const sweepHadError = linkSweepError !== null || perOwnerError !== null;
  await recordCronStatus(CRON_NAMES.DEPOSIT_SCAN, {
    lastStatus: sweepHadError ? "error" : "success",
    ...(sweepHadError
      ? {
          lastError: [
            linkSweepError ? `link_sweep: ${linkSweepError}` : null,
            perOwnerError  ? `per_owner: ${perOwnerError}`    : null,
          ].filter(Boolean).join(" · "),
        }
      : {}),
    lastResult: {
      addressesScanned: addresses.length,
      newDeposits,
      linkDepositsCredited,
      linkFailedChains: linkFailedChains.length,
      linkSweepError,
      perOwnerError,
      wrapped,
      // Whether the owner cursor advanced this tick. false = the slice
      // didn't finish scanning (mid-slice throw / would-be timeout), so
      // the same owner(s) are re-attempted next tick — NOT a skip.
      ownerCursorAdvanced: sliceCompleted,
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
    linkDepositsCredited,
    linkFailedChains,
    cursor: String(cursor),
    ownerCursorAdvanced: sliceCompleted,
    wrapped,
    perOwner: perOwner.slice(0, 50),
    durationMs,
    asOf: new Date().toISOString(),
  });
}
