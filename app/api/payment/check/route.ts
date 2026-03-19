import { NextRequest, NextResponse } from "next/server";
import { getSubscription } from "@/app/lib/db";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const existing = await getSubscription(address);
  if (existing) {
    const expiresAt = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    const isExpired = new Date() >= expiresAt;
    // Return subscription info WITHOUT apiKey
    const { apiKey: _omit, ...safeSubscription } = existing;
    return NextResponse.json({
      status: isExpired ? "expired" : "already_paid",
      subscription: safeSubscription,
      expiresAt: expiresAt.toISOString(),
      isExpired,
    });
  }

  return NextResponse.json({ status: "not_found" });
}
