import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getPaymentRequest, toPublicRequest } from "@/app/lib/payment-request";

/**
 * GET /api/request/[id] - public status lookup.
 *
 * Returns only the payer-facing projection (no creator apiKey, no internal
 * fields). A payer needs recipient + chain + token + amount + status to
 * fulfill the request, all of which are safe to expose. Used by the public
 * /pay/[id] page and the q402_request_status MCP tool.
 */

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "request-status", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  const record = await getPaymentRequest(id);
  if (!record) {
    return NextResponse.json({ error: "Request not found", notFound: true }, { status: 404 });
  }

  return NextResponse.json({ request: toPublicRequest(record) });
}
