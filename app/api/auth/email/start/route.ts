/**
 * POST /api/auth/email/start
 *
 * Begins the email magic-link binding flow. The endpoint:
 *   1. Validates the email shape + the requesting wallet (challenge+sig)
 *   2. Generates a 32-byte opaque token, stores it in KV with 15-minute TTL
 *      keyed by token → { address, email }
 *   3. Sends a magic link via lib/email.sendEmail; in dev (no RESEND_API_KEY)
 *      the email lib logs the link to stderr instead, which is the documented
 *      preview-environment fallback.
 *
 * The token is single-use: /api/auth/email/callback SET NXs a consumed marker
 * before reading the token payload, so a leaked link can't be replayed.
 *
 * Body: { address, challenge, signature, email }
 *   - challenge/signature: same pattern as /api/auth/challenge (one-time)
 *   - email: lowercased + simple shape check (.+@.+\..+)
 *
 * Returns: { ok: true, ttlMinutes, devLink? }
 *   - devLink is included only when RESEND is unconfigured AND
 *     NODE_ENV !== "production". It lets local devs click straight through
 *     without scraping logs; production deploys never receive this field.
 */
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";
import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { renderMagicLinkHtml, sendEmail } from "@/app/lib/email";
import { getAppOrigin } from "@/app/lib/app-origin";

const TOKEN_TTL_SEC = 15 * 60;
const TOKEN_BYTES = 32;
const tokenKvKey = (token: string) => `email_magic:${token}`;

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "email-start", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: {
    address?: string;
    challenge?: string;
    signature?: string;
    email?: string;
  };
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

  const authResult = await requireFreshAuth(body.address, body.challenge, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await kv.set(tokenKvKey(token), { address: addr, email }, { ex: TOKEN_TTL_SEC });

  // Magic-link URL is built from getAppOrigin(req). Production sets
  // APP_ORIGIN in env so the link is operator-pinned regardless of Host.
  // Preview deploys without APP_ORIGIN fall back to the inbound request's
  // origin (i.e. the preview URL), so a magic link generated on a sprint-
  // branch preview lands back on that same preview's callback route — not
  // on production, which may not have the email/* routes yet.
  const magicLinkUrl = `${getAppOrigin(req)}/api/auth/email/callback?token=${token}`;

  const { subject, html, text } = renderMagicLinkHtml({
    email,
    magicLinkUrl,
    ttlMinutes: TOKEN_TTL_SEC / 60,
  });

  const sendResult = await sendEmail({ to: email, subject, html, text });
  if (!sendResult.ok) {
    // Fail-closed in production. The link is still in KV, but we surface
    // the failure so the user retries instead of waiting on a ghost mail.
    // Previous revision only 502'd when RESEND_API_KEY was set — production
    // deploys that forgot to configure RESEND therefore returned ok:true
    // and the user saw "Check your inbox" while no email ever went out.
    //   production + send failure (regardless of cause)  → 502
    //   dev/preview + RESEND unset                       → ok + devLink
    //   dev/preview + RESEND set but send failed         → 502
    console.error(`[email/start] send failed for ${email}: ${sendResult.error}`);
    const isProd = process.env.NODE_ENV === "production";
    if (isProd || process.env.RESEND_API_KEY) {
      return NextResponse.json(
        {
          error: process.env.RESEND_API_KEY
            ? "Could not deliver verification email. Please try again."
            : "Email delivery is not configured on this deploy. Contact support.",
          code: "EMAIL_SEND_FAILED",
        },
        { status: 502 },
      );
    }
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
