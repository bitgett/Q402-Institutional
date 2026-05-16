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
 * Strictly 1:1 — enforced by THREE checks:
 *   - session.address (per-session bind-once)
 *   - wallet_email_link:{wallet}  (wallet-global: one wallet per email)
 *   - email_to_wallet:{email}     (email-global: one email per wallet)
 *
 * Responses:
 *   200 { ok: true, bound: true, address, idempotent?: true }
 *   401 { error: "Not signed in" }                    — no session cookie
 *   400 { error }                                     — bad payload / auth failed
 *   409 { ok: false, code: "WALLET_ALREADY_BOUND",
 *         boundAddress }                              — this session is already bound to a different wallet
 *   409 { ok: false, code: "WALLET_TAKEN" }           — this wallet is claimed by a different email
 *   409 { ok: false, code: "EMAIL_ALREADY_BOUND",
 *         boundAddress }                              — this email is already bound to a different wallet
 *   429 { error: "Too many requests" }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession, pairSessionWithWallet, SESSION_COOKIE } from "@/app/lib/session";
import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { kv } from "@vercel/kv";
import { writeWalletEmailBridge } from "@/app/lib/wallet-email-bridge";

// Reverse indexes — together enforce strict 1:1 binding between an email
// session and a wallet address. Without these the per-session bind-once
// gate could still let:
//   (a) two different emails bind the same wallet (overwriting each
//       other in the wallet→email pointer that /api/keys/provision
//       uses to bridge trial data), or
//   (b) one email re-bind to a different wallet across logout/login
//       (session.address starts null on a fresh session, so the
//       session-scoped check doesn't catch it).
//
//   wallet_email_link:{wallet} → email     (read-side bridge + wallet-side claim)
//   email_to_wallet:{email}    → wallet   (email-side claim, enforces 1:1)
//
// 10-year TTL mirrors the trial_used / trial_used_by_email sentinels.
const walletEmailLinkKey = (addr: string) => `wallet_email_link:${addr.toLowerCase()}`;
const emailToWalletKey   = (email: string) => `email_to_wallet:${email.toLowerCase()}`;
const WALLET_EMAIL_LINK_TTL = 10 * 365 * 24 * 60 * 60;

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

  // Read both global indexes up front. A truly 1:1 wallet ↔ email contract
  // can't rely on session.address alone — that only catches "same session
  // tries to switch wallet". Cross-session attacks/mistakes (a second email
  // claiming the same wallet; an email logging out and re-binding a
  // different wallet) need explicit global checks.
  const emailLc = session.email.toLowerCase();
  const [existingEmailForWallet, existingWalletForEmail] = await Promise.all([
    kv.get<string>(walletEmailLinkKey(verifiedAddr)),
    kv.get<string>(emailToWalletKey(emailLc)),
  ]);
  const existingEmailLc = existingEmailForWallet?.toLowerCase() ?? null;
  const existingWalletLc = existingWalletForEmail?.toLowerCase() ?? null;

  // Idempotent re-bind — same wallet reconnecting after a refresh shouldn't
  // need to re-prove. Returns 200 so the client doesn't show an error toast.
  // Accept either signal: the session already names this wallet, OR both
  // global indexes already point at this exact (email, wallet) pair.
  if (
    session.address === verifiedAddr ||
    (existingEmailLc === emailLc && existingWalletLc === verifiedAddr)
  ) {
    return NextResponse.json({
      ok: true,
      bound: true,
      address: verifiedAddr,
      idempotent: true,
    });
  }

  // Session-scoped bind-once — same session, different wallet. Surfaces the
  // bound address for the dashboard's WrongWalletHardBlock to render.
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

  // Wallet-global uniqueness — this wallet is already claimed by a
  // different email account. Without this check, two emails could both
  // bind 0xabc, and the wallet_email_link reverse pointer would silently
  // overwrite to whoever bound last. /api/keys/provision would then
  // bridge wallet-only logins to whichever email won the race — the
  // other email's trial state becomes invisible from the wallet view.
  if (existingEmailLc && existingEmailLc !== emailLc) {
    return NextResponse.json(
      {
        ok: false,
        code: "WALLET_TAKEN",
        // Don't leak the full bound email to a random caller — the wallet
        // owner can recover via that email but we don't echo it here.
        // The hint is enough: someone else has this wallet, not you.
      },
      { status: 409 },
    );
  }

  // Email-global uniqueness — this email already bound a different wallet
  // (in a prior session that's since logged out). Fresh sessions start
  // with session.address = null, so the per-session bind-once doesn't
  // catch this case. Surface the previously-bound wallet so the UI can
  // tell the user to reconnect that one instead.
  if (existingWalletLc && existingWalletLc !== verifiedAddr) {
    return NextResponse.json(
      {
        ok: false,
        code: "EMAIL_ALREADY_BOUND",
        boundAddress: existingWalletLc,
      },
      { status: 409 },
    );
  }

  // First bind — promote the session from "unbound" to "bound". Persists
  // verifiedAddr as session.address (the canonical bound wallet).
  await pairSessionWithWallet(sid, verifiedAddr);

  // Write BOTH global indexes — awaited, with per-key retry (3 attempts,
  // 50ms/250ms/750ms backoff). Persistent failure emits a deduped ops
  // alert but does NOT block the bind, since pairSessionWithWallet above
  // already committed and a 5xx now would mislead the caller. See
  // app/lib/wallet-email-bridge.ts for full rationale + behaviour notes.
  await writeWalletEmailBridge(
    verifiedAddr,
    emailLc,
    WALLET_EMAIL_LINK_TTL,
    "wallet-bind",
  );

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
