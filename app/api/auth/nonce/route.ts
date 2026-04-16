import { NextRequest, NextResponse } from "next/server";
import { createOrGetNonce } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/auth/nonce?address=0x...
 *
 * Issues (or returns the existing) session nonce for the given address.
 * The nonce is stored server-side for 1 hour.  Clients sign:
 *   "Q402 Auth\nAddress: {addr}\nNonce: {nonce}"
 * and pass { address, nonce, signature } with low-risk protected requests.
 * High-risk actions (key rotation, payment activation) use GET /api/auth/challenge instead.
 *
 * Rate-limited to 20 req / 60 s per IP to prevent enumeration abuse.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  // Fail-closed: if KV is down, nonce cannot be served safely
  if (!(await rateLimit(ip, "auth-nonce", 20, 60, false))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "Valid address required" }, { status: 400 });
  }

  try {
    const { nonce, ttlSec } = await createOrGetNonce(address.toLowerCase());
    return NextResponse.json({ nonce, expiresIn: ttlSec });
  } catch {
    return NextResponse.json(
      { error: "Auth service temporarily unavailable" },
      { status: 503 },
    );
  }
}
