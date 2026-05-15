/**
 * POST /api/auth/wallet-bind
 *
 * Permanently binds a wallet to the caller's email session — this is the
 * "first wallet claim" gate in the Phase 1 identity model (see
 * docs/sprint-bnb-focus.md §10). Once a session has session.address set,
 * it never changes silently: a different wallet posting here returns 409
 * WALLET_ALREADY_BOUND. Re-binding the SAME wallet is idempotent (200 OK).
 *
 * Why fresh signed challenge (not the old nonce-cached path):
 *   Wallet binding is now an irreversible-from-the-UI action (Phase 2 will
 *   add a support-only recovery flow). Treating it as a high-risk operation
 *   means we require a single-use, server-issued challenge — same gate as
 *   /api/payment/activate and /api/keys/rotate. This stops a hijacked
 *   sessionStorage signature from being replayed to bind a wallet the user
 *   never intended to claim.
 *
 * Body: { address, challenge, signature }
 *   challenge from GET /api/auth/challenge?address={addr}
 *   signature = personal_sign("Q402 Institutional\n...\nChallenge: {c}")
 *
 * Responses:
 *   200 { ok: true,  bound: true, address, idempotent?: true }
 *   401 { error: "Not signed in" }                    — no session cookie
 *   400 { error }                                     — bad payload / auth failed
 *   409 { ok: false, code: "WALLET_ALREADY_BOUND",
 *         boundAddress }                              — different wallet already claimed
 *   429 { error: "Too many requests" }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession, pairSessionWithWallet, SESSION_COOKIE } from "@/app/lib/session";
import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "wallet-bind", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; challenge?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // SECURITY: verify ownership via fresh single-use challenge BEFORE looking
  // at the session. requireFreshAuth normalises addr to lowercase on success.
  const authResult = await requireFreshAuth(body.address, body.challenge, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const verifiedAddr = authResult;

  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sid) {
    return NextResponse.json({ error: "Session cookie missing" }, { status: 401 });
  }

  // Idempotent re-bind — same wallet reconnecting after a refresh shouldn't
  // need to re-prove. Returns 200 so the client doesn't show an error toast.
  if (session.address && session.address === verifiedAddr) {
    return NextResponse.json({
      ok: true,
      bound: true,
      address: verifiedAddr,
      idempotent: true,
    });
  }

  // Bind-once enforcement: a session that's already claimed by wallet X
  // CANNOT silently flip to wallet Y. The recovery path (Phase 2) lives at
  // a separate endpoint with OTP gating; here we just refuse and surface
  // the bound address so the UI can render the hard-block screen.
  if (session.address && session.address !== verifiedAddr) {
    return NextResponse.json(
      {
        ok: false,
        code: "WALLET_ALREADY_BOUND",
        boundAddress: session.address,
      },
      { status: 409 },
    );
  }

  // First bind — promote the session from "unbound" to "bound". Persists
  // verifiedAddr as session.address (the canonical bound wallet).
  await pairSessionWithWallet(sid, verifiedAddr);

  // Best-effort operator alert. Same fail-soft pattern as payment-activate.
  // Phase 2's migration job triggers off this event downstream.
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    const lines = [
      "🔗 *Wallet bound to email account*",
      "",
      `*Email:* ${session.email}`,
      `*Wallet:* \`${verifiedAddr}\``,
    ].join("\n");
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: lines, parse_mode: "Markdown" }),
      });
    } catch {
      /* non-critical — bind is already committed */
    }
  }

  return NextResponse.json({
    ok: true,
    bound: true,
    address: verifiedAddr,
  });
}
