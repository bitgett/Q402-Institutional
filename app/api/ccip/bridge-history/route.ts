/**
 * GET /api/ccip/bridge-history?address=0x...
 *
 * Returns the caller's recent CCIP bridges (most-recent first, capped
 * at 50 records). Owner sig auth — same pattern as gas-tank balance.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireAuth } from "@/app/lib/auth";

export const runtime = "nodejs";

function bridgeHistKey(owner: string): string {
  return `ccip_bridge:${owner.toLowerCase()}`;
}

const MAX_RECORDS = 50;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "ccip-bridge-history", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce = req.nextUrl.searchParams.get("nonce");
  const signature = req.nextUrl.searchParams.get("signature");

  const authResult = await requireAuth(address, nonce, signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  try {
    const all = await kv.lrange(bridgeHistKey(owner), -MAX_RECORDS, -1);
    // KV stores oldest→newest; reverse to newest→oldest for the dashboard.
    const records = Array.isArray(all) ? [...all].reverse() : [];
    return NextResponse.json({ count: records.length, records });
  } catch {
    return NextResponse.json({ count: 0, records: [] });
  }
}
