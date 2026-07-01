import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getEscrow, toPublicEscrow } from "@/app/lib/escrow";

/**
 * GET /api/escrow/[id] - public status lookup.
 *
 * Returns the party-facing projection (no creatorOwner). Both buyer and seller
 * need parties + chain + token + amount + releaseDeadline + status + tx hashes
 * to track the escrow, all safe to expose. Used by the /escrow/[id] page and the
 * q402_escrow_status MCP tool. The authoritative fund state is the on-chain
 * vault; this returns the mirror.
 */

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "escrow-status", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  const record = await getEscrow(id);
  if (!record) {
    return NextResponse.json({ error: "Escrow not found", notFound: true }, { status: 404 });
  }

  return NextResponse.json({ escrow: toPublicEscrow(record) });
}
