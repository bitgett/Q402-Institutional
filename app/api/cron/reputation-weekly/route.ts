/**
 * GET /api/cron/reputation-weekly
 *
 * Weekly ERC-8004 reputation heartbeat. Fires a single `giveFeedback`
 * per top-N Q402-graduated agent, summarising their last-7-day activity.
 *
 * Cadence: invoked from cron (Vercel `vercel.json` schedules or the
 * Render heartbeat). ISO-week dedup means even a daily/hourly trigger
 * is safe — the second run in the same week is a no-op.
 *
 * Selection: among wallets with `erc8004AgentId` set, rank by count of
 * "active days" (days where daily-spend > 0) over the past 7 days, then
 * by total spend USD as tiebreaker. Take top TOP_N (default 100). This
 * keeps the gas budget bounded (~$23/week at TOP_N=100, BSC ~3 gwei,
 * ~130k gas/call) regardless of how many agents are graduated.
 *
 * Failure mode: per-agent giveFeedback reverts are caught + logged + the
 * agent is recorded as `failed` in the week's ledger. The cron does NOT
 * retry within the same run — next week's cron picks them up naturally.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { requireCronAuth } from "@/app/lib/cron-auth";
import {
  currentIsoWeek,
  fireWeeklyFeedback,
  parseAgentIdTag,
} from "@/app/lib/erc8004-reputation";
import type { AgenticWalletRecord } from "@/app/lib/agentic-wallet";
import { CRON_NAMES, recordCronStatus } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — 100 sequential BSC writes take ~2-3 min

/**
 * Top-N agents to fire feedback for per week. Clamped to a sane band
 * so a typo'd env (`abc`, `0`, `-1`, `99999`) can't either disable the
 * cron entirely or empty the relayer's gas tank.
 */
const TOP_N_MAX = 500;
const TOP_N_DEFAULT = 100;
function resolveTopN(raw: string | undefined): number {
  if (raw === undefined) return TOP_N_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return TOP_N_DEFAULT;
  return Math.min(Math.floor(n), TOP_N_MAX);
}
const TOP_N = resolveTopN(process.env.REPUTATION_TOP_N);
const SCAN_COUNT = 200;
/**
 * Hard ceiling on SCAN iterations. At ~200 keys/iter this is ~40k keys
 * scanned per run — well above current agentic-wallet record count but
 * far below the timeout danger zone.
 */
const MAX_SCAN_ITERS = 200;

/** Per-week ledger key — aggregate view ("how did this run go?"). */
function weekLedgerKey(isoWeek: string): string {
  return `aw:rep-week:${isoWeek}`;
}

/**
 * Per-agent SET NX claim key. Prevents double-fire when a tx confirms
 * on-chain but the function dies before persisting the ledger entry:
 * the next cron tick sees the claim and skips the agent. Claim TTL is
 * 8 days so it auto-expires after this ISO week completes (idempotency
 * window > the week itself by ~1 day).
 *
 * Per-agent granularity (not the aggregate ledger) is intentional —
 * the aggregate is updated in batches after each successful fire, so
 * a crash mid-batch could leak through without per-agent NX gating.
 */
function weekClaimKey(isoWeek: string, agentTag: string): string {
  return `aw:rep-week:${isoWeek}:claim:${agentTag.toLowerCase()}`;
}
const CLAIM_TTL_SEC = 8 * 24 * 60 * 60;

interface AgentClaim {
  agentTag: string;
  isoWeek: string;
  state: "pending" | "confirmed" | "failed";
  claimedAt: number;
  txHash?: string;
  reason?: string;
}

interface WeekLedger {
  isoWeek: string;
  startedAt: number;
  endedAt?: number;
  fired: Array<{ agentId: string; walletAddr: string; activeDays: number; txHash: string }>;
  failed: Array<{ agentId: string; walletAddr: string; reason: string }>;
  skipped: number;
}

interface CandidateAgent {
  /** Raw tag as persisted in the wallet record (e.g. `"bsc:124025"`).
   *  Kept as-is for ledger continuity + as the dedup key. */
  agentTag: string;
  /** Parsed numeric agent id, ready to feed into giveFeedback(uint256). */
  agentId: bigint;
  walletAddr: string;
  ownerAddr: string;
  activeDays: number;
  spendUsd: number;
}

/**
 * Identify whether a key is a multi-wallet record key (aw:{owner}:{walletId})
 * vs other aw:* families. Returns the owner + walletId or null.
 */
function classifyRecordKey(key: string): { owner: string; walletId: string; isLegacy: boolean } | null {
  if (!key.startsWith("aw:")) return null;
  for (const prefix of [
    "aw:export-log:",
    "aw:daily-spend:",
    "aw:daily-spend-c:",
    "aw:batch:",
    "aw:send:",
    "aw:list:",
    "aw:default:",
    "aw:register-tx:",
    "aw:balance:",
    "aw:agent-md:",
    "aw:rep-week:",
  ]) {
    if (key.startsWith(prefix)) return null;
  }
  const rest = key.slice("aw:".length);
  const parts = rest.split(":");
  if (parts.length === 1) {
    return { owner: parts[0], walletId: "", isLegacy: true };
  }
  if (parts.length === 2 && /^0x[0-9a-fA-F]{40}$/.test(parts[1])) {
    return { owner: parts[0], walletId: parts[1], isLegacy: false };
  }
  return null;
}

/** UTC date string `YYYY-MM-DD` for `nDaysAgo` days back. */
function utcDateStr(nDaysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - nDaysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Sum the past 7 days of daily-spend-c records for this wallet. Returns
 * `activeDays` (0..7) and total spend in USD. Empty/missing keys count
 * as 0 — they auto-expire after the v2 schema TTL.
 */
async function loadWeekActivity(
  ownerAddr: string,
  walletId: string,
): Promise<{ activeDays: number; spendUsd: number }> {
  let activeDays = 0;
  let centsTotal = 0;
  const owner = ownerAddr.toLowerCase();
  const wid = walletId.toLowerCase();
  for (let i = 0; i < 7; i++) {
    const dateStr = utcDateStr(i);
    const key = `aw:daily-spend-c:${owner}:${wid}:${dateStr}`;
    try {
      const v = await kv.get<number>(key);
      const cents = typeof v === "number" ? v : Number(v ?? 0);
      if (Number.isFinite(cents) && cents > 0) {
        activeDays += 1;
        centsTotal += cents;
      }
    } catch {
      // KV blip — treat that day as inactive. Best-effort aggregation;
      // missing one day doesn't justify rerunning the whole cron.
    }
  }
  return { activeDays, spendUsd: centsTotal / 100 };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const isoWeek = currentIsoWeek();
  const ledgerKey = weekLedgerKey(isoWeek);
  const runStartedAt = Date.now();

  // Anything thrown below this line lands in the catch and gets
  // recorded as a `lastStatus: error` cron-status entry — operators
  // see WHY the run failed in /api/admin/cron-status instead of just
  // a stale timestamp.
  try {
    // ── Idempotency — early exit if this week is already done ──────────
    const existing = await kv.get<WeekLedger>(ledgerKey);
    if (existing && existing.endedAt) {
      const result = {
        ok: true,
        isoWeek,
        reused: true,
        fired: existing.fired.length,
        failed: existing.failed.length,
        ranAt: existing.endedAt,
      };
      await recordCronStatus(CRON_NAMES.REPUTATION_WEEKLY, {
        lastStatus: "success",
        lastResult: result,
        durationMs: Date.now() - runStartedAt,
      });
      return NextResponse.json(result);
    }

    // ── Initialise (or resume) ledger ─────────────────────────────────
    const ledger: WeekLedger = existing ?? {
      isoWeek,
      startedAt: Date.now(),
      fired: [],
      failed: [],
      skipped: 0,
    };

    // ── Scan all wallet records, collect graduated agents ────────────
    const candidates: CandidateAgent[] = [];
    let cursor: string | number = 0;
    let scanIters = 0;
    do {
      let page: string[];
      try {
        const res: [string | number, string[]] = await kv.scan(cursor, {
          match: "aw:*",
          count: SCAN_COUNT,
        });
        cursor = res[0];
        page = res[1];
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`kv_scan_failed: ${reason}`);
      }
      scanIters++;

      for (const key of page) {
        const cls = classifyRecordKey(key);
        if (!cls) continue;
        const record = await kv.get<AgenticWalletRecord>(key);
        if (!record) continue;
        if (record.deletedAt) continue;
        if (!record.erc8004AgentId) continue;
        // Stored tag is `{network}:{agentId}` (e.g. "bsc:124025").
        // Convert to numeric BEFORE pushing as a candidate — naive
        // `BigInt(tag)` throws and every agent silently lands in the
        // failed bucket. Skip + bump skipped if the tag is malformed.
        const agentIdNumeric = parseAgentIdTag(record.erc8004AgentId);
        if (agentIdNumeric === null) {
          ledger.skipped += 1;
          continue;
        }

        const { activeDays, spendUsd } = await loadWeekActivity(
          cls.owner,
          cls.isLegacy ? record.address : cls.walletId,
        );
        if (activeDays === 0) {
          ledger.skipped += 1;
          continue;
        }
        candidates.push({
          agentTag: record.erc8004AgentId,
          agentId: agentIdNumeric,
          walletAddr: record.address,
          ownerAddr: cls.owner,
          activeDays,
          spendUsd,
        });
      }
    } while (cursor !== "0" && cursor !== 0 && scanIters < MAX_SCAN_ITERS);

    // ── Rank + slice top N ───────────────────────────────────────────
    candidates.sort((a, b) => {
      if (a.activeDays !== b.activeDays) return b.activeDays - a.activeDays;
      return b.spendUsd - a.spendUsd;
    });
    const top = candidates.slice(0, TOP_N);

    // ── Fire sequentially ────────────────────────────────────────────
    // Sequential (not parallel) so the relayer nonce stays sane + a
    // single RPC failure doesn't cascade across the batch. ~2s per
    // write × 100 ≈ 200s, within the 300s maxDuration.
    //
    // Each agent is gated by a per-agent SET NX claim. The claim is
    // set to `pending` BEFORE the tx — so even if the function dies
    // between tx-confirmed and ledger-write, the next cron tick sees
    // the claim and skips the agent (no double-fire). After tx
    // confirmation the claim flips to `confirmed`; on tx failure it's
    // deleted so the next run can retry.
    const relayEndpoint = "https://q402.quackai.ai/api/relay/info";

    for (const c of top) {
      const claimKey = weekClaimKey(isoWeek, c.agentTag);
      const pending: AgentClaim = {
        agentTag: c.agentTag,
        isoWeek,
        state: "pending",
        claimedAt: Date.now(),
      };
      let claimed: unknown;
      try {
        claimed = await kv.set(claimKey, pending, { nx: true, ex: CLAIM_TTL_SEC });
      } catch (e) {
        // KV blip — skip this agent for this tick. The next run will
        // retry naturally; no on-chain side-effect from a KV failure.
        console.error(`[reputation-weekly] claim set failed for ${c.agentTag}:`, e);
        continue;
      }
      if (!claimed) {
        // Already pending / confirmed for this week. Treat as skipped
        // here (the existing claim's terminal state is the source of
        // truth — confirmed = success this week, pending = leave alone
        // until next run).
        continue;
      }

      try {
        const txHash = await fireWeeklyFeedback({
          agentId: c.agentId,
          settlements7d: c.activeDays,
          isoWeek,
          endpoint: relayEndpoint,
          feedbackURI: "",
        });
        // tx confirmed (fireWeeklyFeedback waits for receipt).
        const confirmed: AgentClaim = { ...pending, state: "confirmed", txHash };
        await kv.set(claimKey, confirmed, { ex: CLAIM_TTL_SEC });
        ledger.fired.push({
          agentId: c.agentTag,
          walletAddr: c.walletAddr,
          activeDays: c.activeDays,
          txHash,
        });
        await kv.set(ledgerKey, ledger);
      } catch (e) {
        const reason =
          e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
        console.error(
          `[reputation-weekly] giveFeedback failed for agent ${c.agentTag}:`,
          e,
        );
        // Release the claim so a later run (this week or next) can
        // retry — the on-chain tx either reverted or never landed, so
        // the agent never got their reputation tick.
        try {
          await kv.del(claimKey);
        } catch {
          /* best-effort */
        }
        ledger.failed.push({
          agentId: c.agentTag,
          walletAddr: c.walletAddr,
          reason,
        });
        await kv.set(ledgerKey, ledger);
      }
    }

    ledger.endedAt = Date.now();
    await kv.set(ledgerKey, ledger);

    const result = {
      ok: true,
      isoWeek,
      candidates: candidates.length,
      fired: ledger.fired.length,
      failed: ledger.failed.length,
      skipped: ledger.skipped,
    };
    await recordCronStatus(CRON_NAMES.REPUTATION_WEEKLY, {
      lastStatus: "success",
      lastResult: result,
      durationMs: Date.now() - runStartedAt,
    });

    return NextResponse.json(result);
  } catch (e) {
    // Single error path — every early return above either succeeded
    // (recorded above) or rethrew here. Record the failure so the
    // admin cron-status dashboard shows the operator WHAT broke.
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[reputation-weekly] run aborted:", e);
    await recordCronStatus(CRON_NAMES.REPUTATION_WEEKLY, {
      lastStatus: "error",
      lastError: reason.slice(0, 500),
      durationMs: Date.now() - runStartedAt,
    });
    return NextResponse.json(
      { error: "reputation_weekly_failed", message: reason.slice(0, 200) },
      { status: 502 },
    );
  }
}
