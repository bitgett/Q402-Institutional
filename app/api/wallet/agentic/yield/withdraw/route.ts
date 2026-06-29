/**
 * POST /api/wallet/agentic/yield/withdraw
 *
 * Withdraw an Agent Wallet's lending position (Aave / Lista / Morpho) back to the
 * wallet, gasless. Routes by the position's own venue; `protocol` disambiguates a
 * multi-venue position and is bound into the signed intent. Auth: intent-bound
 * owner-sig (action "agentic.yield_withdraw") OR live apiKey. Body:
 * { walletId, chain, token, amount ("max" = full), protocol?, ... }.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleYieldAction } from "@/app/lib/yield/execute";

export const runtime = "nodejs";

export function POST(req: NextRequest): Promise<NextResponse> {
  return handleYieldAction(req, "withdraw");
}
