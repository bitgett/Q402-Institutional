/**
 * POST /api/auth/logout
 *
 * Destroys the current email session: deletes the KV record + clears the
 * q402_sid cookie. Idempotent — calling on an already-empty session is a
 * no-op and still returns 200.
 *
 * No body. Reads the q402_sid cookie via lib/session.destroySession.
 */
import { NextRequest, NextResponse } from "next/server";
import { destroySession, attachClearSessionCookie } from "@/app/lib/session";

export async function POST(req: NextRequest) {
  await destroySession(req);
  const resp = NextResponse.json({ ok: true });
  attachClearSessionCookie(resp);
  return resp;
}
