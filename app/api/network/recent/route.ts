/**
 * GET /api/network/recent
 *
 * Public route — returns the most recent N confirmed live relayed TXs
 * (sender, recipient, chain, amount, timestamp) in reverse-chronological
 * order. Sandbox TXs excluded.
 *
 * Polled by downstream consumers to surface new settlement events in
 * near-real-time without holding open an SSE connection here — Vercel's
 * serverless model can't carry a long-lived stream.
 *
 * Privacy posture: every field is already public on BscScan / Etherscan
 * (the relayer's outbound TXs reveal sender + recipient + amount by
 * construction). We exclude sandbox TXs (apiKey prefix q402_test_ /
 * q402_sandbox_) so the surface stays bound to on-chain settlements.
 *
 * Cached for 15 s at the edge — fast enough to feel realtime,
 * infrequent enough to keep KV scan cost manageable.
 */
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_HEADER = "public, s-maxage=15, stale-while-revalidate=30";

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

interface RelayedTxRow {
  apiKey?: string;
  chain?: string;
  fromUser?: string;
  toUser?: string;
  tokenAmount?: number | string;
  tokenSymbol?: string;
  relayedAt?: string;
  relayTxHash?: string;
}

interface RecentTxEntry {
  from: string;
  to: string;
  chain: string;
  amountUsd: number;
  token: string;
  ts: number;
  /** Settlement tx hash. Already public on the chain explorer (anyone can
   *  look up the relayer EOA's outbound TXs on BscScan and find these), so
   *  exposing it here just lets downstream pollers (viz, dashboards) link
   *  to the explorer instead of forcing viewers to hunt by sender + amount. */
  txHash: string;
}

interface RecentResponse {
  total: number;
  txs: RecentTxEntry[];
  asOf: string;
}

const SANDBOX_PREFIXES = ["q402_test_", "q402_sandbox_"];

function isSandboxRow(tx: RelayedTxRow): boolean {
  const k = tx.apiKey;
  if (typeof k !== "string") return false;
  return SANDBOX_PREFIXES.some((prefix) => k.startsWith(prefix));
}

function rowAmountUsd(tx: RelayedTxRow): number {
  const v = typeof tx.tokenAmount === "string" ? Number(tx.tokenAmount) : tx.tokenAmount;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

async function loadRelayedTxRowKey(key: string): Promise<RelayedTxRow[]> {
  try {
    const list = await kv.lrange<RelayedTxRow>(key, 0, -1);
    if (list.length > 0) return list;
  } catch {
    /* WRONGTYPE — legacy JSON array */
  }
  try {
    const arr = (await kv.get<RelayedTxRow[]>(key)) ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Cursor-based SCAN page size. Mirrors the agentic-wallet-gc cron's
 *  page size — small enough to keep individual round-trips well under
 *  Upstash's 10MB request cap, large enough that ~1k relaytx keys
 *  finish in a handful of round-trips. */
const SCAN_COUNT = 200;
/** Hard ceiling on SCAN iterations as a defensive guard against
 *  a server-side bug that returns a non-terminating cursor. At
 *  COUNT=200 this covers ~2M keys before tripping. */
const MAX_SCAN_ITERS = 10_000;

async function scanRelaytxKeys(): Promise<string[]> {
  // Cursor-based SCAN replaces the old `kv.keys("relaytx:*")`. The
  // KEYS variant materialises every matching key into one Redis
  // response — once the namespace grows past a few thousand entries
  // it would blow past Upstash's 10MB per-request cap and hard-reject
  // the call. SCAN pages the result so we stay under the cap regardless
  // of namespace size.
  const out: string[] = [];
  let cursor: string | number = 0;
  let iters = 0;
  do {
    const res: [string | number, string[]] = await kv.scan(cursor, {
      match: "relaytx:*",
      count: SCAN_COUNT,
    });
    cursor = res[0];
    out.push(...res[1]);
    iters++;
    if (String(cursor) === "0" || iters > MAX_SCAN_ITERS) break;
  } while (true);
  return out;
}

async function computeRecent(limit: number): Promise<RecentResponse> {
  const keys = await scanRelaytxKeys();
  const all: RecentTxEntry[] = [];

  for (const key of keys) {
    const rows = await loadRelayedTxRowKey(key);
    for (const tx of rows) {
      if (!tx || typeof tx !== "object") continue;
      if (isSandboxRow(tx)) continue;
      const from = typeof tx.fromUser === "string" ? tx.fromUser.toLowerCase() : "";
      const to   = typeof tx.toUser   === "string" ? tx.toUser.toLowerCase()   : "";
      if (!from.startsWith("0x") || !to.startsWith("0x")) continue;
      const chain = typeof tx.chain === "string" && tx.chain.length > 0 ? tx.chain : "unknown";
      const token = typeof tx.tokenSymbol === "string" ? tx.tokenSymbol : "USDT";
      const parsed = Date.parse(tx.relayedAt ?? "");
      const ts = Number.isFinite(parsed) ? parsed : 0;
      // Validate the tx hash before surfacing — a malformed value would
      // make the viz link out to a dead bscscan/etherscan page.
      const txHash =
        typeof tx.relayTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx.relayTxHash)
          ? tx.relayTxHash
          : "";
      all.push({ from, to, chain, amountUsd: rowAmountUsd(tx), token, ts, txHash });
    }
  }

  all.sort((a, b) => b.ts - a.ts);
  const sliced = all.slice(0, limit);

  return {
    total: all.length,
    txs: sliced,
    asOf: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rawLimit = url.searchParams.get("limit");
    const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : DEFAULT_LIMIT;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;
    const result = await computeRecent(limit);
    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (err) {
    console.error("[network/recent] aggregation failed:", err);
    return NextResponse.json(
      { error: "stats_unavailable" },
      { status: 500, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
