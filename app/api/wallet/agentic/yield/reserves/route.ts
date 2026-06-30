/**
 * GET /api/wallet/agentic/yield/reserves
 *
 * Public market data: the stablecoin lending markets Q402 Yield offers
 * on a chain, with live supply APY. No wallet / no auth — this is the
 * same public info Aave's own UI shows. Rate-limited per IP.
 *
 *   ?chain=bnb   → markets on that chain
 *   (no chain)   → markets across all supported chains
 *
 * Phase 0 (read-only). Moves no funds.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { listAllMarketsStrict, yieldSupportedChains, type YieldMarket } from "@/app/lib/yield";

export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!(await rateLimit(getClientIP(req), "yield-reserves", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const chain = new URL(req.url).searchParams.get("chain");
  const chains = chain ? [chain] : yieldSupportedChains();

  // Strict per-chain reads: an APY of 0 from a healthy market reports
  // normally, but an RPC read FAILURE marks the chain unavailable — so a
  // failed read never masquerades as a real 0% APY listing.
  const byChain = await Promise.all(
    chains.map(async (c) => {
      try {
        return { chain: c, markets: await listAllMarketsStrict(c) };
      } catch (e) {
        console.error(`[yield/reserves] read failed on ${c}:`, e);
        return { chain: c, markets: null as YieldMarket[] | null };
      }
    }),
  );

  const markets: YieldMarket[] = byChain
    .filter((b) => b.markets !== null)
    .flatMap((b) => b.markets as YieldMarket[]);
  const unavailableChains = byChain.filter((b) => b.markets === null).map((b) => b.chain);

  const body = {
    supportedChains: yieldSupportedChains(),
    markets,
    // Present only when at least one chain's read failed. When set, the
    // markets list omits the failed chains — their APY is unknown, NOT 0.
    ...(unavailableChains.length > 0 ? { unavailable: true, unavailableChains } : {}),
    asOf: new Date().toISOString(),
  };

  // If EVERY requested chain failed there are zero markets to show, which
  // would read as "no markets" — surface a 503 instead.
  const allFailed = unavailableChains.length === chains.length && chains.length > 0;
  const res = NextResponse.json(body, { status: allFailed ? 503 : 200 });
  // Edge-cache the PUBLIC, user-invariant market list so repeated dashboard /
  // landing / MCP loads hit the CDN instead of re-running the multi-chain RPC +
  // APY fan-out (the top Vercel Observability-event source). Cache ONLY a FULLY
  // clean read (zero unavailable chains): a 503 (all failed) or a PARTIAL read
  // (some chain's RPC blipped) must not be cached, or a recovered chain's markets
  // would stay missing for the whole TTL. APY is display-only; deposits read live
  // on-chain, so 60s staleness is harmless. The list is identical for every user,
  // so a shared cache is safe.
  if (unavailableChains.length === 0) {
    res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  }
  return res;
}
