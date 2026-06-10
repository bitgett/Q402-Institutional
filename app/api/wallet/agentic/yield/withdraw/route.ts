/**
 * POST /api/wallet/agentic/yield/withdraw
 *
 * Withdraw an Agent Wallet's Aave V3 position back to the wallet, gasless.
 * Auth: intent-bound owner-sig (action "agentic.yield_withdraw") OR live
 * apiKey. Body: { walletId, chain, token, amount ("max" = full), ... }.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleYieldAction } from "@/app/lib/yield/execute";

export const runtime = "nodejs";

export function POST(req: NextRequest): Promise<NextResponse> {
  return handleYieldAction(req, "withdraw");
}
