/**
 * GET /api/oft/history?address=0x...&nonce=...&signature=...
 *
 * Owner-signature authenticated USDT0 bridge history. Companion to
 * /api/ccip/bridge-history. Reads the per-owner KV list, newest first.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireAuth } from "@/app/lib/auth";
import { oftBridgeHistKey } from "@/app/lib/oft-bridge-runner";

export const runtime = "nodejs";
const MAX_RECORDS = 50;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "oft-bridge-history", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce = req.nextUrl.searchParams.get("nonce");
  const signature = req.nextUrl.searchParams.get("signature");

  const authResult = await requireAuth(address, nonce, signature);
  if (typeof authResult !== "string") {
    return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
  }
  const owner = authResult;

  try {
    const all = await kv.lrange(oftBridgeHistKey(owner), -MAX_RECORDS, -1);
    const records = Array.isArray(all) ? [...all].reverse() : [];
    return NextResponse.json({ count: records.length, records });
  } catch {
    return NextResponse.json({ count: 0, records: [] });
  }
}
