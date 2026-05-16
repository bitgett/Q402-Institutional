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

  // Auth-bearing links resolve to the canonical APP_ORIGIN, not the request's
  // Host header. The request can legitimately arrive on a preview deploy /
  // edge / forwarded host and we still want the email to point at the
  // production app. Misrouted or spoofed Host values cannot survive into a
  // user's inbox.
  const magicLinkUrl = `${getAppOrigin()}/api/auth/email/callback?token=${token}`;

  const { subject, html, text } = renderMagicLinkHtml({
    email,
    magicLinkUrl,
    ttlMinutes: TOKEN_TTL_SEC / 60,
  });

  const sendResult = await sendEmail({ to: email, subject, html, text });
  if (!sendResult.ok) {
    // Email transport failed AND RESEND is configured. The link itself is
    // still stored in KV (so a manual operator action could deliver it), but
    // we surface the failure so the user can retry instead of waiting on a
    // ghost message.
    console.error(`[email/start] send failed for ${email}: ${sendResult.error}`);
    if (process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { error: "Could not deliver verification email. Please try again.", code: "EMAIL_SEND_FAILED" },
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
