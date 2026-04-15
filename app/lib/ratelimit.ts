/**
 * ratelimit.ts — Vercel KV sliding-window rate limiter
 *
 * Usage:
 *   const ok = await rateLimit(ip, "relay", 20, 60);   // 20 req/min
 *   if (!ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
 *
 * Degrades gracefully: if KV is unavailable (local dev / misconfigured),
 * all requests are allowed through so dev experience is unaffected.
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
  /** failOpen=true: allow when KV is down (safe for read-only or low-risk paths).
   *  failOpen=false: block when KV is down (required for expensive/critical paths). */
  failOpen = true
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

/** Extract best-effort client IP from a Next.js request */
export function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}
