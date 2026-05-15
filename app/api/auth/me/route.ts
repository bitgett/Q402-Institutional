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
 *   { authenticated: false }
 *   { authenticated: true, email, address?, boundAddress, bindState, expiresAt }
 *
 * `boundAddress` is the canonical wallet permanently claimed for this
 * session via /api/auth/wallet-bind. `bindState` is "bound" when set,
 * "unbound" otherwise. The dashboard's 4-state machine reads these to
 * decide whether to render the Claim prompt, the Multichain view, or the
 * Wrong-wallet hard block.
 *
 * `address` is preserved as a legacy alias of boundAddress so older
 * clients keep working — new code should read boundAddress + bindState.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/app/lib/session";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }
  const boundAddress = session.address ?? null;
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    address: boundAddress,            // legacy alias
    boundAddress,
    bindState: boundAddress ? "bound" : "unbound",
    expiresAt: session.expiresAt,
  });
}
