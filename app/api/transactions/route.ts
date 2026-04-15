import { NextRequest, NextResponse } from "next/server";
import { getRelayedTxs } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/transactions?address=0x...&nonce=xxx&sig=0x...
 *
 * Returns relayed TX history for the given address.
 * Requires nonce-based EIP-191 proof-of-ownership.
 * nonce obtained from GET /api/auth/nonce?address={addr}
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "transactions", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address   = req.nextUrl.searchParams.get("address");
  const nonce     = req.nextUrl.searchParams.get("nonce");
  const signature = req.nextUrl.searchParams.get("sig");

  const authResult = await requireAuth(address, nonce, signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const txs = await getRelayedTxs(addr);

  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthCount = txs.filter(tx => new Date(tx.relayedAt) >= monthStart).length;

  return NextResponse.json({ txs, thisMonthCount, totalCount: txs.length });
}
