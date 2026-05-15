/**
 * session.ts — server-side email session store (Vercel KV-backed).
 *
 * Used by the email magic-link auth flow so a user can log in with just an
 * email address — wallet signature is still required to *send* a payment
 * (EIP-712 TransferAuthorization is non-negotiable), but reading the
 * dashboard, viewing API keys, and triggering trial activation prompts all
 * work from an email-only session.
 *
 * Cookie design:
 *   - Name: q402_sid
 *   - Value: opaque 32-byte hex session id (lookup key into KV)
 *   - Path: /
 *   - HttpOnly, Secure (in production), SameSite=Lax
 *   - Max-Age: 30 days (matches paid + trial subscription window)
 *
 * KV record: session:{sid} → { email, address?, createdAt, expiresAt }
 *   - `address` is set when the user later pairs a wallet via /api/auth/email/start
 *     (existing flow) or signs in via wallet on the same browser
 *   - Session never stores secrets; key rotation simply destroys the session
 *
 * Renewal: sessions are NOT sliding. The cookie + KV record both expire
 * exactly SESSION_TTL_SEC (30d) after createSession(); getSession() is a
 * pure read and does not refresh either. A user who has not signed in for
 * 30d will be silently logged out on the next request, regardless of how
 * recently they accessed the site. If you ever want sliding behaviour,
 * write back the cookie + KV TTL inside getSession() — and accept that
 * every authenticated request now does a KV write.
 */

import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export interface SessionRecord {
  email: string;
  address?: string;
  createdAt: string;
  expiresAt: string;
}

export const SESSION_COOKIE = "q402_sid";
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const sessionKvKey = (sid: string) => `session:${sid}`;

/**
 * Create a new session record + return the session id. Caller is responsible
 * for writing the cookie via attachSessionCookie() in the same response.
 */
export async function createSession(email: string, address?: string): Promise<string> {
  const sid = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1000);
  const record: SessionRecord = {
    email: email.toLowerCase(),
    ...(address ? { address: address.toLowerCase() } : {}),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await kv.set(sessionKvKey(sid), record, { ex: SESSION_TTL_SEC });
  return sid;
}

/**
 * Read the session from the request's cookie. Returns null when:
 *   - no cookie present
 *   - cookie value is malformed (not 64-char hex)
 *   - KV has no record for the sid (expired or rotated)
 */
export async function getSession(req: NextRequest): Promise<SessionRecord | null> {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const record = await kv.get<SessionRecord>(sessionKvKey(sid));
  return record ?? null;
}

/**
 * Pair an existing email session with a wallet address. Used when an
 * email-only user later connects a wallet — the same session continues but
 * gains transactional capability.
 */
export async function pairSessionWithWallet(sid: string, address: string): Promise<void> {
  const record = await kv.get<SessionRecord>(sessionKvKey(sid));
  if (!record) return;
  await kv.set(
    sessionKvKey(sid),
    { ...record, address: address.toLowerCase() },
    { ex: SESSION_TTL_SEC },
  );
}

/**
 * Invalidate the current session. Called by /api/auth/logout. Best-effort —
 * if the KV delete fails, the cookie clear in attachClearCookie() is still
 * enough to lock the user out of new requests (no sid → no session).
 */
export async function destroySession(req: NextRequest): Promise<void> {
  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sid) return;
  try {
    await kv.del(sessionKvKey(sid));
  } catch {
    /* best-effort */
  }
}

/**
 * Set the session cookie on an outgoing response. Centralizes the cookie
 * attribute set so we don't drift between routes (Secure flag, SameSite,
 * etc.). Pass `null` to clear.
 */
export function attachSessionCookie(resp: NextResponse, sid: string): void {
  resp.cookies.set(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export function attachClearSessionCookie(resp: NextResponse): void {
  resp.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
