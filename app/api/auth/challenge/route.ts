import { NextRequest, NextResponse } from "next/server";
import { createFreshChallenge } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/auth/challenge?address=0x...
 *
 * Issues a one-time challenge for high-risk operations (key rotation, payment activation).
 * Unlike the session nonce, challenges are:
 *  - Single-use: consumed and deleted on first successful verification
 *  - Short-lived: 5-minute TTL
 *  - Signed with a different message prefix ("Q402 Action\nAddress: ...\nChallenge: ...")
 *
 * Rate-limited to 10 req / 60 s per IP.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "auth-challenge", 10, 60, false))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Valid address required" }, { status: 400 });
  }

  try {
    const { challenge, ttlSec } = await createFreshChallenge(address.toLowerCase());
    return NextResponse.json({ challenge, expiresIn: ttlSec });
  } catch {
    return NextResponse.json(
      { error: "Auth service temporarily unavailable" },
      { status: 503 },
    );
  }
}
