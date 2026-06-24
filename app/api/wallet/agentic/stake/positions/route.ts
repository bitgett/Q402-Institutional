/**
 * GET /api/wallet/agentic/stake/positions
 *
 * Read-only: the Agent Wallet's Q staking positions on the live QuackAiStake
 * contract (BNB). Session-sig auth (owner address + nonce + sig). Drives the
 * Stake modal's "your positions" list + the unstake Max amount.
 *
 * Query: address (owner EOA), nonce, sig, walletId? (default wallet).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import { readStakePositions } from "@/app/lib/staking/positions";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-stake-positions", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce = req.nextUrl.searchParams.get("nonce");
  const sig = req.nextUrl.searchParams.get("sig");
  const walletId = req.nextUrl.searchParams.get("walletId");

  const authResult = await requireAuth(address, nonce, sig);
  if (typeof authResult !== "string") {
    return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
  }
  const owner = authResult;

  const wallet = await resolveWallet(owner, walletId && walletId.length > 0 ? walletId.toLowerCase() : null);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  try {
    const result = await readStakePositions(wallet.address);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: "positions_read_failed", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
