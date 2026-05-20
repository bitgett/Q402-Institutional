/**
 * GET /api/stats/public
 *
 * Aggregate, anonymous usage stats sourced ONLY from confirmed live
 * relayed-transaction history. The Q402 visualization demo
 * (bitgett/q402-visualization) renders these into a live metrics panel.
 *
 * Hard constraints — every line of this file is written to one of these:
 *
 *   - DO NOT touch subscription records. Provisioned-only wallets,
 *     email pseudos, sandbox testers, and admin grants all show up in
 *     `sub:*` but should NOT inflate user counts here. We intentionally
 *     do not import getSubscription or read `sub:*`; a source-grep test
 *     in __tests__/stats-public.test.ts pins that.
 *
 *   - DO NOT echo back tx hashes, API keys, raw wallet lists, emails,
 *     or any per-account metadata. Only aggregate counters + per-chain
 *     rollups leave this route.
 *
 *   - DO exclude sandbox txs. Sandbox apiKeys carry a `q402_test_` or
 *     `q402_sandbox_` prefix — every relay handler that records into
 *     history fills `apiKey`, so filtering on that prefix excludes
 *     anything that didn't broadcast on-chain.
 *
 * The KV scan covers `relaytx:*` keys only. The list is small in
 * practice (one key per active wallet per month); future scale can move
 * to materialized monthly counters if the scan latency becomes visible.
 */
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import type { RelayedTx } from "@/app/lib/db";

const CACHE_HEADER = "public, s-maxage=60, stale-while-revalidate=120";

// CORS — the visualization demo runs on a separate origin and may also
// be embedded in third-party dashboards. The response carries only
// aggregate counts (no per-account fields), so `*` is acceptable here.
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

interface ChainAgg {
  settlements: number;
  volumeUsd: number;
}

interface PublicStats {
  totalSettlements: number;
  uniquePayers: number;
  uniqueRecipients: number;
  totalVolumeUsd: number;
  perChain: Record<string, ChainAgg>;
  asOf: string;
}

const SANDBOX_PREFIXES = ["q402_test_", "q402_sandbox_"];

function isSandboxRow(tx: RelayedTx): boolean {
  if (typeof tx.apiKey !== "string") return false;
  return SANDBOX_PREFIXES.some((prefix) => tx.apiKey.startsWith(prefix));
}

function rowAmountUsd(tx: RelayedTx): number {
  // USDC / USDT / RLUSD all peg to USD-1, so the formatted token amount
  // doubles as the dollar value. Token amounts are written as either
  // a number (low-precision) or a string (preserves 18-dec precision).
  // Number() handles both; non-finite or sub-zero values are dropped.
  const value = typeof tx.tokenAmount === "string"
    ? Number(tx.tokenAmount)
    : tx.tokenAmount;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function loadRelayedTxKey(key: string): Promise<RelayedTx[]> {
  // Newer rows live in a Redis LIST (see recordRelayedTx in app/lib/db.ts).
  // Older rows are a JSON array stored at the same key. Try LIST first;
  // WRONGTYPE → fall back to the legacy shape so we don't drop history.
  try {
    const list = await kv.lrange<RelayedTx>(key, 0, -1);
    if (list.length > 0) return list;
  } catch {
    /* WRONGTYPE — legacy JSON array */
  }
  try {
    const arr = (await kv.get<RelayedTx[]>(key)) ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function computeStats(): Promise<PublicStats> {
  // kv.keys is fine for the relay-history scale (low thousands of keys
  // even after a year of activity); switch to cursor-based scan if the
  // shape ever explodes. Crucially, the match pattern restricts the
  // scan to `relaytx:*` only — `sub:*` is never touched here.
  const keys = await kv.keys("relaytx:*");

  let totalSettlements = 0;
  let totalVolumeUsd = 0;
  const payers = new Set<string>();
  const recipients = new Set<string>();
  const perChain: Record<string, ChainAgg> = {};

  for (const key of keys) {
    const rows = await loadRelayedTxKey(key);
    for (const tx of rows) {
      // Defensive: skip malformed rows rather than throwing — a single
      // corrupt history entry must not turn the whole panel into a 500.
      // MUST run before isSandboxRow() because that helper dereferences
      // tx.apiKey, which would itself throw on a null / non-object row.
      if (!tx || typeof tx !== "object") continue;
      if (isSandboxRow(tx)) continue;
      const chain = typeof tx.chain === "string" && tx.chain.length > 0 ? tx.chain : "unknown";
      const fromUser = typeof tx.fromUser === "string" ? tx.fromUser.toLowerCase() : "";
      const toUser   = typeof tx.toUser   === "string" ? tx.toUser.toLowerCase()   : "";
      const usd = rowAmountUsd(tx);

      totalSettlements += 1;
      totalVolumeUsd += usd;
      if (fromUser) payers.add(fromUser);
      if (toUser)   recipients.add(toUser);

      const bucket = perChain[chain] ?? { settlements: 0, volumeUsd: 0 };
      bucket.settlements += 1;
      bucket.volumeUsd   += usd;
      perChain[chain] = bucket;
    }
  }

  // Round volume to 2 decimals so the response stays compact and
  // doesn't leak floating-point dust like 1234.999999998.
  totalVolumeUsd = Math.round(totalVolumeUsd * 100) / 100;
  for (const k of Object.keys(perChain)) {
    perChain[k].volumeUsd = Math.round(perChain[k].volumeUsd * 100) / 100;
  }

  return {
    totalSettlements,
    uniquePayers:     payers.size,
    uniqueRecipients: recipients.size,
    totalVolumeUsd,
    perChain,
    asOf: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    const stats = await computeStats();
    return NextResponse.json(stats, { headers: RESPONSE_HEADERS });
  } catch (err) {
    // Fail soft — log server-side for diagnosis, return a generic
    // error code with no internal detail (KV key names, stack traces,
    // or the exception message could leak schema or env hints).
    console.error("[stats/public] aggregation failed:", err);
    return NextResponse.json(
      { error: "stats_unavailable" },
      { status: 500, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
