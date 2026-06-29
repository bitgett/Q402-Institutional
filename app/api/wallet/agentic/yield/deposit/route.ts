/**
 * POST /api/wallet/agentic/yield/deposit
 *
 * Supply an Agent Wallet's stablecoin into a curated lending venue (Aave / Lista
 * on BNB, Morpho on Base), gasless. Auth: intent-bound owner-sig (action
 * "agentic.yield_deposit") OR live apiKey. Body: { walletId, chain, token, amount,
 * protocol? (chosen venue, bound into the signed intent), (ownerAddress/nonce/signature | apiKey) }.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleYieldAction } from "@/app/lib/yield/execute";

export const runtime = "nodejs";

export function POST(req: NextRequest): Promise<NextResponse> {
  return handleYieldAction(req, "supply");
}
