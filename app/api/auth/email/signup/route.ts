/**
 * POST /api/auth/email/signup
 *
 * Email-only signup entry point — counterpart to the wallet-paired flow at
 * /api/auth/email/start. No wallet signature is required; the user just
 * proves they own the email address by clicking the magic link.
 *
 * Once clicked, /api/auth/email/callback creates a session cookie that
 * grants dashboard access. To *send* a payment the user still needs to
 * connect a wallet later (EIP-712 TransferAuthorization can't be issued
 * without an EVM private key) — the dashboard surfaces a "Connect wallet
 * to activate trial" prompt for email-only sessions.
 *
 * Body: { email }
 *
 * Returns: { ok: true, ttlMinutes, devLink? }
 *   - devLink is included only when RESEND_API_KEY is unset AND
 *     NODE_ENV !== "production", mirroring the wallet-paired route.
 */
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { renderMagicLinkHtml, sendEmail } from "@/app/lib/email";
import { getAppOrigin } from "@/app/lib/app-origin";

const TOKEN_TTL_SEC = 15 * 60;
const TOKEN_BYTES = 32;
const tokenKvKey = (token: string) => `email_magic:${token}`;

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  // Tighter cap than /start since this route is wallet-free — there's no
  // signature cost to throttle email-bombing a victim. Per-IP + per-email
  // limits below catch the common abuse shapes.
  if (!(await rateLimit(ip, "email-signup", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!/.+@.+\..+/.test(email) || email.length > 254) {
    return NextResponse.json(
      { error: "Email is missing or malformed", code: "INVALID_EMAIL" },
      { status: 400 },
    );
  }

  // Per-email rate limit — separate namespace from the IP cap above so a
  // shared NAT (corp / VPN) doesn't lock out legitimate users while still
  // blocking targeted email-bombing against one address.
  if (!(await rateLimit(email, "email-signup-per-email", 3, 600))) {
    return NextResponse.json(
      { error: "Too many signup attempts for this email — try again later.", code: "TOO_MANY_EMAIL_ATTEMPTS" },
      { status: 429 },
    );
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  // mode: "signup" tells the callback to create a session cookie even when
  // no wallet is bound. The wallet-paired flow stores mode: "pair" so the
  // existing dashboard write path keeps working unchanged.
  await kv.set(
    tokenKvKey(token),
    { email, mode: "signup" },
    { ex: TOKEN_TTL_SEC },
  );

  // Auth-bearing links pin to the canonical APP_ORIGIN — see
  // app/lib/app-origin.ts for the rationale.
  const magicLinkUrl = `${getAppOrigin()}/api/auth/email/callback?token=${token}`;

  const { subject, html, text } = renderMagicLinkHtml({
    email,
    magicLinkUrl,
    ttlMinutes: TOKEN_TTL_SEC / 60,
  });

  const sendResult = await sendEmail({ to: email, subject, html, text });
  if (!sendResult.ok && process.env.RESEND_API_KEY) {
    console.error(`[email/signup] send failed for ${email}: ${sendResult.error}`);
    return NextResponse.json(
      { error: "Could not deliver verification email. Please try again.", code: "EMAIL_SEND_FAILED" },
      { status: 502 },
    );
  }

  const devLink =
    process.env.NODE_ENV !== "production" && !process.env.RESEND_API_KEY
      ? magicLinkUrl
      : undefined;

  return NextResponse.json({
    ok: true,
    ttlMinutes: TOKEN_TTL_SEC / 60,
    ...(devLink ? { devLink } : {}),
  });
}
