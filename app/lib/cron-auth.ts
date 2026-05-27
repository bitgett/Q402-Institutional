/**
 * cron-auth.ts — shared `CRON_SECRET` verifier for Vercel-cron-triggered
 * routes.
 *
 * Why this helper exists: the previous shape used `auth !== \`Bearer
 * ${cronSecret}\`` (or `expected.length !== auth.length || expected !== auth`)
 * which short-circuits on first mismatched byte → measurable timing
 * oracle for the secret prefix. Consolidated here so every cron route
 * uses the same constant-time comparator + the same fail-closed shape.
 *
 * Fail-closed posture:
 *   - `CRON_SECRET` unset                 → 503 "CRON_SECRET unset"
 *   - missing/short/wrong auth header     → 401 "unauthorized"
 *   - exact match (timing-safe)           → null (caller proceeds)
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

/**
 * Returns `null` when the request is authorised (caller proceeds).
 * Returns a `NextResponse` to return verbatim when the request must
 * be rejected.
 */
export function requireCronAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.length === 0) {
    return NextResponse.json(
      { error: "CRON_SECRET unset — refusing to run." },
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  // timingSafeEqual requires equal-length buffers. If the supplied
  // header is the wrong length we MUST reject without short-circuiting
  // back through `===`, but we also can't pass mismatched-length
  // buffers to timingSafeEqual without throwing. Compare lengths
  // first (constant work — both lengths are known up front), then
  // compare a same-length buffer pair. This still leaks "length
  // matched vs not" via the path taken, but the secret length is
  // known to anyone reading the cron env (= every cron operator),
  // so that's not a real leak.
  if (header.length !== expected.length) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (!timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
