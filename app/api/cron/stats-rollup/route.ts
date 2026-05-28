/**
 * GET /api/cron/stats-rollup
 *
 * Daily rollup that materialises the public stats summary into a
 * single KV key (`stats:public:summary`). /api/stats/public then reads
 * that one key instead of SCAN-ing thousands of source rows on every
 * request.
 *
 * Why this exists
 *   The original /api/stats/public SCAN-ed `relaytx:*` on every call.
 *   After the 2026-05-27 incident relaytx:* lost ~99% of its rows
 *   (suspected Upstash LRU eviction — receipt:* survived because it
 *   carries an explicit 1-year TTL, relaytx had no TTL set and was
 *   the biggest list-shaped namespace, so it got picked first). The
 *   surviving 12 monthly keys made the public panel report 29 unique
 *   payers when the real history (preserved in receipt:*) shows
 *   779. This rollup recomputes from receipt:* — which carries the
 *   full ground truth — and stores a precomputed summary so:
 *     1. /api/stats/public stays one O(1) GET, not an O(N) scan
 *     2. KV bandwidth stops being load-bearing on every panel render
 *     3. receipt:* (durable, TTL-protected) is the source of truth
 *
 * Schedule
 *   `0 1 * * *` (daily 01:00 UTC = 10:00 KST) — wired in vercel.json.
 *
 * Authentication
 *   Shared CRON_SECRET via Authorization header (requireCronAuth).
 *
 * Scan budget
 *   receipt:rct_* is currently ~21k keys. SCAN at COUNT=500 needs
 *   ~42 round-trips; each batch reads each receipt as a small JSON
 *   string. Comfortably under the 60s Hobby cron timeout.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireCronAuth } from "@/app/lib/cron-auth";
import type { Receipt } from "@/app/lib/receipt-shared";

export const runtime = "nodejs";
export const maxDuration = 60;

const SCAN_COUNT = 500;
const MAX_ITERS = 100_000;

const SUMMARY_KEY = "stats:public:summary";

interface ChainAgg {
  settlements: number;
  volumeUsd: number;
}

export interface StatsSummary {
  totalSettlements: number;
  uniquePayers: number;
  uniqueRecipients: number;
  totalVolumeUsd: number;
  perChain: Record<string, ChainAgg>;
  computedAt: string;
  /** How many `receipt:*` keys the rollup scanned. Lets ops compare
   *  against external counters to spot future evictions early. */
  scannedKeys: number;
}

function rowAmountUsd(rcpt: Receipt): number {
  const value = typeof rcpt.tokenAmount === "string"
    ? Number(rcpt.tokenAmount)
    : rcpt.tokenAmount;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function scanReceiptKeys(): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | number = 0;
  let iters = 0;
  do {
    const res: [string | number, string[]] = await kv.scan(cursor, {
      match: "receipt:rct_*",
      count: SCAN_COUNT,
    });
    cursor = res[0];
    out.push(...res[1]);
    iters++;
    if (String(cursor) === "0" || iters > MAX_ITERS) break;
  } while (true);
  return out;
}

async function computeSummary(): Promise<StatsSummary> {
  const keys = await scanReceiptKeys();

  let totalSettlements = 0;
  let totalVolumeUsd = 0;
  const payers = new Set<string>();
  const recipients = new Set<string>();
  const perChain: Record<string, ChainAgg> = {};

  // Read receipts in batches so a single round trip doesn't try to fetch
  // 21k payloads. Promise.all per batch keeps the wall time short while
  // bounding peak memory.
  const BATCH = 100;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const rows = await Promise.all(slice.map(async (k) => {
      try {
        return await kv.get<Receipt>(k);
      } catch {
        return null;
      }
    }));
    for (const rcpt of rows) {
      if (!rcpt || typeof rcpt !== "object") continue;
      // Exclude sandbox — public stats are on-chain settlements only,
      // mirroring the /api/network/recent + old /api/stats/public filter.
      if (rcpt.sandbox) continue;
      const chain = typeof rcpt.chain === "string" && rcpt.chain.length > 0 ? rcpt.chain : "unknown";
      const payer = typeof rcpt.payer === "string" ? rcpt.payer.toLowerCase() : "";
      const recipient = typeof rcpt.recipient === "string" ? rcpt.recipient.toLowerCase() : "";
      const usd = rowAmountUsd(rcpt);

      totalSettlements += 1;
      totalVolumeUsd += usd;
      if (payer) payers.add(payer);
      if (recipient) recipients.add(recipient);

      const bucket = perChain[chain] ?? { settlements: 0, volumeUsd: 0 };
      bucket.settlements += 1;
      bucket.volumeUsd += usd;
      perChain[chain] = bucket;
    }
  }

  totalVolumeUsd = Math.round(totalVolumeUsd * 100) / 100;
  for (const k of Object.keys(perChain)) {
    perChain[k].volumeUsd = Math.round(perChain[k].volumeUsd * 100) / 100;
  }

  return {
    totalSettlements,
    uniquePayers: payers.size,
    uniqueRecipients: recipients.size,
    totalVolumeUsd,
    perChain,
    computedAt: new Date().toISOString(),
    scannedKeys: keys.length,
  };
}

export async function GET(req: NextRequest) {
  const authResp = requireCronAuth(req);
  if (authResp) return authResp;

  try {
    const summary = await computeSummary();
    // No TTL — rollup is fully replaced every 24h, and a stale summary is
    // strictly better than no summary. The key is small (<1KB) so leaving
    // it forever costs nothing.
    await kv.set(SUMMARY_KEY, summary);
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    console.error("[stats-rollup] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
