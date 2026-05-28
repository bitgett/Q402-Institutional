/**
 * GET /api/stats/public
 *
 * Reads the precomputed daily rollup at `stats:public:summary` (written
 * by /api/cron/stats-rollup once a day from receipt:* — the durable,
 * 1-year-TTL source of truth). Falls back to a synthesized empty
 * summary if the key is missing so the public panel never 500s.
 *
 * Why precomputed
 *   The previous implementation SCAN-ed `relaytx:*` on every request,
 *   then for each key fetched the full LIST. After the 2026-05-27
 *   relaytx eviction incident, that source was gutted (12 keys
 *   survived) so the panel showed 29 unique payers when receipt:*
 *   actually had 779 worth of history. Switching to a precomputed
 *   summary (a) restores the correct numbers immediately, (b) makes
 *   the panel an O(1) GET so KV bandwidth stops being load-bearing
 *   on every render, and (c) anchors the public view to a TTL-
 *   protected key so future evictions on volatile namespaces don't
 *   silently regress the metrics again.
 *
 * Hard constraints
 *   - DO NOT touch subscription records (`sub:*`) — provisioned-only
 *     wallets, email pseudos, sandbox testers, admin grants all show
 *     up there and should not inflate counts.
 *   - DO NOT echo per-account data — only aggregate counters leave
 *     this route.
 *   - DO exclude sandbox txs (handled inside the rollup).
 */
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import type { StatsSummary } from "@/app/api/cron/stats-rollup/route";

const CACHE_HEADER = "public, s-maxage=60, stale-while-revalidate=120";

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

const SUMMARY_KEY = "stats:public:summary";

interface PublicStats {
  totalSettlements: number;
  uniquePayers: number;
  uniqueRecipients: number;
  totalVolumeUsd: number;
  perChain: Record<string, { settlements: number; volumeUsd: number }>;
  asOf: string;
}

const EMPTY_STATS: PublicStats = {
  totalSettlements: 0,
  uniquePayers: 0,
  uniqueRecipients: 0,
  totalVolumeUsd: 0,
  perChain: {},
  asOf: new Date(0).toISOString(),
};

export async function GET() {
  try {
    const summary = await kv.get<StatsSummary>(SUMMARY_KEY);
    if (!summary) {
      // First-boot path or post-incident — rollup hasn't run yet.
      // Return an empty shape so the panel renders the schema
      // instead of an error toast.
      return NextResponse.json(EMPTY_STATS, { headers: RESPONSE_HEADERS });
    }
    const out: PublicStats = {
      totalSettlements: summary.totalSettlements,
      uniquePayers:     summary.uniquePayers,
      uniqueRecipients: summary.uniqueRecipients,
      totalVolumeUsd:   summary.totalVolumeUsd,
      perChain:         summary.perChain,
      asOf:             summary.computedAt,
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
