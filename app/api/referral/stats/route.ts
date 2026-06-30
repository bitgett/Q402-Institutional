import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getReferralStats } from "@/app/lib/referral";
import { listAgenticWallets } from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

/**
 * GET /api/referral/stats?address=&nonce=&sig=
 *
 * Owner-sig authed (the SAME scheme the agentic-wallet reads use). Returns the
 * caller's referral code, the total number of new users they've referred, and
 * the referee list for display. Minting the code's reverse map happens on first
 * view (idempotent). Read-only — no funds, no writes beyond the idempotent code map.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "referral-stats", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const result = await requireAuth(
    req.nextUrl.searchParams.get("address"),
    req.nextUrl.searchParams.get("nonce"),
    req.nextUrl.searchParams.get("sig"),
  );
  if (typeof result !== "string") {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  // A referral link requires the referrer to be a REAL user — i.e. to have
  // created at least one Agent Wallet. No wallet → no code (empty), so a link
  // can only ever originate from a committed user, never from a bare connected
  // wallet. (The card is also gated on having a wallet; this is the server-side
  // guarantee behind it.)
  const wallets = await listAgenticWallets(result);
  if (wallets.length === 0) {
    return NextResponse.json({ code: "", count: 0, referees: [], rank: null, totalInviters: 0, leaderboard: [], needsWallet: true });
  }

  const stats = await getReferralStats(result);
  return NextResponse.json(stats);
}
