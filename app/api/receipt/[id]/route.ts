import { NextRequest, NextResponse } from "next/server";
import { getReceipt, publicView } from "@/app/lib/receipt";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/receipt/[id]
 *
 * Returns the public-shaped Receipt JSON. Used by:
 *   - the /receipt/[id] page to do client-side polling for the live webhook
 *     delivery timeline transition (pending → delivered/failed).
 *   - external integrations that want the structured data instead of HTML.
 *
 * The response strips fields the customer hasn't opted into showing
 * (currently apiKeyTier, gated by Receipt.showTier). The signed canonical
 * subset is always present, so the Verify button on the page can recompute
 * the digest client-side.
 *
 * Rate limited per-IP because the page polls and we don't want a public
 * receipt URL to be a DoS amplifier on the KV cluster.
 */
export async function GET(
  req:    NextRequest,
  ctx:    { params: Promise<{ id: string }> },
) {
  // 120/min per IP — calibrated for shared NAT scenarios where several
  // people in the same office might be staring at the same receipt page
  // (each page polls every 2.5s during pending). The receipt itself is
  // tiny so this isn't a meaningful KV-load concern.
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "receipt-get", 120, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  if (!id || !/^rct_[0-9a-f]{24}$/.test(id)) {
    return NextResponse.json({ error: "Invalid receipt id" }, { status: 400 });
  }

  const receipt = await getReceipt(id);
  if (!receipt) {
    return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  }

  // Cache headers — the immutable settlement fields don't change after
  // creation, but the webhook trace can flip pending → delivered, so we
  // can't hard-cache. 5-second SWR is enough to absorb polling bursts
  // without blocking real status updates.
  //
  // X-Robots-Tag: receipt JSON is "shareable but unguessable" — we don't
  // want crawlers indexing the structured data either, even if they hit
  // the API endpoint directly via referer leak.
  return NextResponse.json(publicView(receipt), {
    headers: {
      "Cache-Control":   "public, max-age=5, stale-while-revalidate=30",
      "X-Robots-Tag":    "noindex, nofollow",
    },
  });
}
