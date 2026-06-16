import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { getApiKeyRecord } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getPaymentRequest,
  cancelPaymentRequest,
  acquireRequestPayLock,
  releaseRequestPayLock,
  toPublicRequest,
} from "@/app/lib/payment-request";

/**
 * POST /api/request/[id]/cancel - the creator cancels an open request.
 *
 * Auth proves the caller IS the creator: either an apiKey whose owner
 * matches creatorOwner, or a session-sig from creatorOwner. Only an `open`
 * request can be cancelled (paid/expired/cancelled are terminal).
 */

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "request-cancel", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  const record = await getPaymentRequest(id);
  if (!record) {
    return NextResponse.json({ error: "Request not found", notFound: true }, { status: 404 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Empty/invalid body is fine for the apiKey-in-header-less flow below;
    // we still need at least an apiKey or the session-sig triplet.
  }

  // ── Prove caller is the creator ────────────────────────────────────────
  let callerOwner: string | null = null;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
  if (apiKey) {
    const rec = await getApiKeyRecord(apiKey);
    if (!rec || !rec.active) {
      return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
    }
    callerOwner = rec.address;
  } else {
    const authed = await requireAuth(
      typeof body.address === "string" ? body.address : null,
      typeof body.nonce === "string" ? body.nonce : null,
      typeof body.signature === "string" ? body.signature : null,
    );
    if (typeof authed !== "string") {
      return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
    }
    callerOwner = authed;
  }

  if (callerOwner.toLowerCase() !== record.creatorOwner.toLowerCase()) {
    return NextResponse.json({ error: "Only the request creator can cancel it" }, { status: 403 });
  }

  if (record.status !== "open") {
    return NextResponse.json(
      { error: `Cannot cancel a ${record.status} request`, status: record.status },
      { status: 409 },
    );
  }

  // Serialize against settlement: if the pay lock is held, a payment is in
  // flight. Cancelling now could show "cancelled" while the payment still
  // lands (and pay's markRequestPaid would then overwrite to "paid"). Take the
  // same lock so cancel and pay can't interleave.
  if (!(await acquireRequestPayLock(id))) {
    return NextResponse.json(
      { error: "A settlement is in progress for this request; try cancelling again shortly." },
      { status: 409 },
    );
  }
  let cancelled;
  try {
    // Re-checks status === "open" internally, so a request that settled between
    // the check above and acquiring the lock is left as-is (not force-cancelled).
    cancelled = await cancelPaymentRequest(id);
  } finally {
    await releaseRequestPayLock(id);
  }
  return NextResponse.json({ request: cancelled ? toPublicRequest(cancelled) : null });
}
