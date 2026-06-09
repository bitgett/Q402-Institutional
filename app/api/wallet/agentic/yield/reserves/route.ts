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
import { listAllMarkets, yieldSupportedChains } from "@/app/lib/yield";

export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!(await rateLimit(getClientIP(req), "yield-reserves", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const chain = new URL(req.url).searchParams.get("chain");
  const chains = chain ? [chain] : yieldSupportedChains();

  const byChain = await Promise.all(
    chains.map(async (c) => ({ chain: c, markets: await listAllMarkets(c).catch(() => []) })),
  );

  return NextResponse.json({
    supportedChains: yieldSupportedChains(),
    markets: byChain.flatMap((b) => b.markets),
    asOf: new Date().toISOString(),
  });
}
