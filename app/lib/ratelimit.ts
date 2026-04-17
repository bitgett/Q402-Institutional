/**
 * ratelimit.ts — Vercel KV fixed-window rate limiter
 *
 * Usage:
 *   const ok = await rateLimit(ip, "relay", 20, 60);   // 20 req/min
 *   if (!ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
 *
 * Windows are fixed buckets (bucket = floor(now / window)) — a caller can
 * technically burst across a bucket boundary, but Redis sorted-set sliding
 * windows are not worth the cost at this project's scale.
 *
 * Default is fail-CLOSED: if KV is unavailable, the limiter returns false
 * (request blocked). Safer default for launch. Callers that need graceful
 * degradation on KV outage can opt in with failOpen=true.
 */

import { kv } from "@vercel/kv";
import { NextRequest } from "next/server";

/**
 * Returns true if the request is within quota, false if rate-limited.
 *
 * @param identifier  Unique key — typically IP or address
 * @param endpoint    Short label for the endpoint (namespaces the counter)
 * @param limit       Max requests allowed in the window
 * @param windowSec   Window size in seconds
 */
export async function rateLimit(
  identifier: string,
  endpoint: string,
  limit: number,
  windowSec: number,
  /** failOpen=false (default): block when KV is down — safer default.
   *  failOpen=true: allow when KV is down — opt in only for low-risk read paths. */
  failOpen = false
): Promise<boolean> {
  try {
    // Bucket key changes every `windowSec` seconds — fixed window
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key    = `rl:${endpoint}:${identifier}:${bucket}`;

    const count = await kv.incr(key);
    if (count === 1) {
      // Set TTL slightly longer than window so Redis cleans up
      await kv.expire(key, windowSec * 2);
    }
    return count <= limit;
  } catch {
    // KV unavailable — behaviour depends on caller's risk tolerance
    return failOpen;
  }
}

/**
 * Refund one unit from a rate-limit counter incremented by rateLimit().
 * Best-effort — floors at 0 to avoid negative counters.
 * Use to roll back a daily cap charge when the operation it guarded failed.
 */
export async function refundRateLimit(
  identifier: string,
  endpoint:   string,
  windowSec:  number,
): Promise<void> {
  try {
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key    = `rl:${endpoint}:${identifier}:${bucket}`;
    const after  = await kv.decr(key);
    if (after < 0) await kv.set(key, 0);
  } catch { /* best-effort — don't throw */ }
}

/**
 * Extract best-effort client IP from a Next.js request.
 *
 * Order:
 *   1. x-real-ip         — set by Vercel edge, unspoofable through the edge.
 *   2. x-forwarded-for   — first value; clients can prepend values, so only
 *                          used as a fallback for non-Vercel deployments.
 *
 * We deliberately prefer x-real-ip over XFF on Vercel. The edge sets x-real-ip
 * from the observed TCP peer; a caller prepending its own XFF cannot poison
 * it. XFF alone was spoofable by sending `x-forwarded-for: 1.2.3.4, …` —
 * the per-IP rate limit would then bucket against the forged value.
 */
export function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown"
  );
}
