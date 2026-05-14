/**
 * GET /api/auth/me
 *
 * Returns the current email session identity (if any). Used by the
 * dashboard + Navbar to decide whether to show "Sign in" or the user's
 * email + sign-out button.
 *
 * No body. Reads the q402_sid cookie via lib/session.getSession.
 *
 * Returns:
 *   { authenticated: false }                              — no session
 *   { authenticated: true, email, address?, expiresAt }   — session active
 *
 * The wallet `address` field is populated when the user has paired a wallet
 * with the email account (via /api/trial/activate or a future bind route).
 * Email-only sessions return address: undefined, which the dashboard maps
 * to a "Connect wallet to activate trial" prompt.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/app/lib/session";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    address: session.address ?? null,
    expiresAt: session.expiresAt,
  });
}
