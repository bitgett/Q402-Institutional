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
  return NextResponse.json(body, { status: allFailed ? 503 : 200 });
}
