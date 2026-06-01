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
} from "@/app/lib/erc8004-reputation";
import type { AgenticWalletRecord } from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — 100 sequential BSC writes take ~2-3 min

const TOP_N = Number(process.env.REPUTATION_TOP_N ?? 100);
const SCAN_COUNT = 200;
/**
 * Hard ceiling on SCAN iterations. At ~200 keys/iter this is ~40k keys
 * scanned per run — well above current agentic-wallet record count but
 * far below the timeout danger zone.
 */
const MAX_SCAN_ITERS = 200;

/** Per-week ledger key — single source of truth for "did we fire?". */
function weekLedgerKey(isoWeek: string): string {
  return `aw:rep-week:${isoWeek}`;
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
  agentId: string;
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

  // ── Idempotency — early exit if this week is already done ──────────────
  const existing = await kv.get<WeekLedger>(ledgerKey);
  if (existing && existing.endedAt) {
    return NextResponse.json({
      ok: true,
      isoWeek,
      reused: true,
      fired: existing.fired.length,
      failed: existing.failed.length,
      ranAt: existing.endedAt,
    });
  }

  // ── Initialise (or resume) ledger ──────────────────────────────────────
  const ledger: WeekLedger = existing ?? {
    isoWeek,
    startedAt: Date.now(),
    fired: [],
    failed: [],
    skipped: 0,
  };

  // ── Scan all wallet records, collect graduated agents ─────────────────
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
      console.error("[reputation-weekly] kv.scan failed:", e);
      return NextResponse.json({ error: "kv_scan_failed" }, { status: 502 });
    }
    scanIters++;

    for (const key of page) {
      const cls = classifyRecordKey(key);
      if (!cls) continue;
      const record = await kv.get<AgenticWalletRecord>(key);
      if (!record) continue;
      if (record.deletedAt) continue;
      if (!record.erc8004AgentId) continue;

      const { activeDays, spendUsd } = await loadWeekActivity(cls.owner, cls.isLegacy ? record.address : cls.walletId);
      if (activeDays === 0) {
        ledger.skipped += 1;
        continue;
      }
      candidates.push({
        agentId: record.erc8004AgentId,
        walletAddr: record.address,
        ownerAddr: cls.owner,
        activeDays,
        spendUsd,
      });
    }
  } while (cursor !== "0" && cursor !== 0 && scanIters < MAX_SCAN_ITERS);

  // ── Rank + slice top N ─────────────────────────────────────────────────
  candidates.sort((a, b) => {
    if (a.activeDays !== b.activeDays) return b.activeDays - a.activeDays;
    return b.spendUsd - a.spendUsd;
  });
  const top = candidates.slice(0, TOP_N);

  // ── Filter out agents already fired this week (mid-run resume) ────────
  const alreadyFired = new Set(ledger.fired.map((f) => f.agentId));
  const alreadyFailed = new Set(ledger.failed.map((f) => f.agentId));
  const toFire = top.filter((c) => !alreadyFired.has(c.agentId) && !alreadyFailed.has(c.agentId));

  // ── Fire sequentially ─────────────────────────────────────────────────
  // Sequential (not parallel) so the relayer nonce stays sane + a single
  // RPC failure doesn't cascade across the batch. ~2s per write × 100
  // ≈ 200s, within the 300s maxDuration.
  const relayEndpoint = "https://q402.quackai.ai/api/relay/info";

  for (const c of toFire) {
    try {
      const txHash = await fireWeeklyFeedback({
        agentId: BigInt(c.agentId),
        settlements7d: c.activeDays,
        isoWeek,
        endpoint: relayEndpoint,
        feedbackURI: "",
      });
      ledger.fired.push({
        agentId: c.agentId,
        walletAddr: c.walletAddr,
        activeDays: c.activeDays,
        txHash,
      });
      // Persist after every successful write so a mid-run crash doesn't
      // lose progress.
      await kv.set(ledgerKey, ledger);
    } catch (e) {
      const reason = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      console.error(`[reputation-weekly] giveFeedback failed for agent ${c.agentId}:`, e);
      ledger.failed.push({
        agentId: c.agentId,
        walletAddr: c.walletAddr,
        reason,
      });
      await kv.set(ledgerKey, ledger);
    }
  }

  ledger.endedAt = Date.now();
  await kv.set(ledgerKey, ledger);

  return NextResponse.json({
    ok: true,
    isoWeek,
    candidates: candidates.length,
    fired: ledger.fired.length,
    failed: ledger.failed.length,
    skipped: ledger.skipped,
  });
}
