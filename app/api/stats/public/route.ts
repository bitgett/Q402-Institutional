/**
 * GET /api/stats/public
 *
 * Aggregate, anonymous usage stats for the public dashboard. Reads
 * five materialized counter keys written by /api/relay's after()
 * hook — no SCAN, no per-render fan-out. Counters are seeded from
 * receipt:* (the durable 1-year TTL source of truth) via a one-time
 * backfill, then every successful live relay increments them
 * atomically.
 *
 * History
 *   v1: SCAN relaytx:* on every request. Cheap when the namespace
 *       had a few hundred keys; once it grew past a few thousand it
 *       saturated KV bandwidth on every panel render and was a
 *       direct contributor to the 2026-05-27 LRU eviction that
 *       wiped relaytx:*.
 *   v2: Daily rollup into stats:public:summary. Restored the panel
 *       but the 24h staleness regressed the "real-time" feel.
 *   v3 (this): Materialized counters. Real-time, O(1) reads,
 *       LRU-safe (hot tier).
 *
 * Hard constraints — every line of this file is written to one of these:
 *   - DO NOT touch subscription records. Provisioned-only wallets,
 *     email pseudos, sandbox testers, and admin grants all show up in
 *     `sub:*` but should NOT inflate user counts here. The counter
 *     hook in /api/relay already filters sandbox calls upstream.
 *   - DO NOT echo back tx hashes, API keys, raw wallet lists, emails,
 *     or any per-account metadata. Only aggregate counters + per-chain
 *     rollups leave this route.
 */
import { NextResponse } from "next/server";
import { getStatsCounters } from "@/app/lib/db";

const CACHE_HEADER = "public, s-maxage=10, stale-while-revalidate=60";

// CORS — public dashboards may consume this from any origin. The
// response carries only aggregate counts (no per-account fields), so
// `*` is acceptable here.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age":       "86400",
};

const RESPONSE_HEADERS: Record<string, string> = {
  "Cache-Control":   CACHE_HEADER,
  "X-Robots-Tag":    "noindex, nofollow",
  ...CORS_HEADERS,
};

interface PublicStats {
  totalSettlements: number;
  uniquePayers:     number;
  uniqueRecipients: number;
  totalVolumeUsd:   number;
  perChain:         Record<string, { settlements: number; volumeUsd: number }>;
  asOf:             string;
}

export async function GET() {
  try {
    const c = await getStatsCounters();
    const out: PublicStats = {
      totalSettlements: c.totalSettlements,
      uniquePayers:     c.uniquePayers,
      uniqueRecipients: c.uniqueRecipients,
      totalVolumeUsd:   c.totalVolumeUsd,
      perChain:         c.perChain,
      asOf:             new Date().toISOString(),
    };
    return NextResponse.json(out, { headers: RESPONSE_HEADERS });
  } catch (err) {
    console.error("[stats/public] read failed:", err);
    return NextResponse.json(
      { error: "stats_unavailable" },
      { status: 500, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
