import { NextRequest, NextResponse } from "next/server";
import { getGasBalance, getGasDeposits } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/gas-tank/user-balance?address=0x...&nonce=xxx&sig=0x...
 *
 * Returns the caller's gas-tank balances and deposit history.
 *
 * Q402-SEC-003: requires nonce-based EIP-191 proof-of-ownership so an
 * anonymous caller cannot enumerate any wallet's Q402 posture (balances,
 * deposit txHashes, per-chain activity). The underlying data is partially
 * derivable from on-chain GASTANK_ADDRESS logs, but requiring auth here
 * matches /api/transactions and /api/webhook, removes the trivial address
 * → Q402 customer mapping, and stops low-cost account scraping.
 * Nonce obtained from GET /api/auth/nonce?address={addr}.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "user-balance", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce   = req.nextUrl.searchParams.get("nonce");
  const sig     = req.nextUrl.searchParams.get("sig");

  const authResult = await requireAuth(address, nonce, sig);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const [balances, deposits] = await Promise.all([
    getGasBalance(addr),
    getGasDeposits(addr),
  ]);

  return NextResponse.json({ balances, deposits });
}
