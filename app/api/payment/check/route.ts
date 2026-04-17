import { NextRequest, NextResponse } from "next/server";
import { getSubscription } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/payment/check?address=0x...
 *
 * Returns subscription status for the given address.
 * Used by /payment to skip the payment flow if already subscribed.
 *
 * Deliberately returns minimal information — no apiKey, amountUSD, or txHash.
 * Those fields are private billing data and have no use on the payment page.
 */
export async function GET(req: NextRequest) {
  // ── Rate limit: 30 req / 60 s per IP ─────────────────────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "payment-check", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "valid Ethereum address required" }, { status: 400 });
  }

  const existing = await getSubscription(address.toLowerCase());
  if (!existing) {
    return NextResponse.json({ status: "not_found" });
  }

  // Provisioned (free) accounts have paidAt="" and amountUSD=0 — treat as unpaid
  if (!existing.paidAt || (existing.amountUSD ?? 0) === 0) {
    return NextResponse.json({ status: "not_found" });
  }

  const expiresAt = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  const isExpired = new Date() >= expiresAt;

  // Return only what the payment page actually needs — no apiKey / amountUSD / txHash
  return NextResponse.json({
    status:    isExpired ? "expired" : "already_paid",
    plan:      existing.plan,
    expiresAt: expiresAt.toISOString(),
    isExpired,
  });
}
