/**
 * POST /api/auth/wallet-bind
 *
 * Attaches a wallet address to the caller's email session record. Called
 * from the dashboard immediately after the WalletContext reports a fresh
 * connection so that:
 *
 *   - Subsequent /api/auth/me calls return { authenticated, email, address }
 *   - pairSessionWithWallet keeps the email pseudo-account aware of the
 *     wallet the user actually transacts from
 *   - When the user later activates a trial via wallet, /api/trial/activate
 *     can see this pairing and skip re-prompting
 *
 * The wallet binding requires no on-chain signature — connecting a wallet
 * (window.ethereum.request) already proves browser-level control, and the
 * server only stores it as a hint on the cookie-bound session. No
 * subscription credits move; this is a navigation/UX helper.
 *
 * Conflict policy:
 *   - If the session already has a different `address` paired, RETURN
 *     200 with `{ ok: false, code: "ALREADY_PAIRED" }` and DO NOT
 *     overwrite. Re-pairing would let a stale cookie quietly hop to a
 *     new wallet identity; we prefer the explicit sign-out / sign-in
 *     path for that.
 *   - If no session at all, 401.
 *
 * Body: { address }
 *   - 0x-prefixed lowercase EVM address. Server normalizes case.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession, pairSessionWithWallet, SESSION_COOKIE } from "@/app/lib/session";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "wallet-bind", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = (body.address ?? "").trim();
  if (!ETH_ADDR.test(raw)) {
    return NextResponse.json({ error: "Valid 0x EVM address required" }, { status: 400 });
  }
  const address = raw.toLowerCase();

  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Conflict: the cookie already points at a different wallet. Don't
  // overwrite silently — surface a code the client can react to (e.g.
  // dashboard shows "this email is paired with 0xAAA; sign out to
  // pair a different wallet").
  if (session.address && session.address !== address) {
    return NextResponse.json({
      ok: false,
      code: "ALREADY_PAIRED",
      pairedAddress: session.address,
    });
  }

  // No prior binding (or same wallet re-connecting) — pair via the
  // existing session helper.
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sid) {
    return NextResponse.json({ error: "Session cookie missing" }, { status: 401 });
  }
  await pairSessionWithWallet(sid, address);

  return NextResponse.json({ ok: true, email: session.email, address });
}
