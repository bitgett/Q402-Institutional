import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord, getSubscription } from "@/app/lib/db";

export async function POST(req: NextRequest) {
  const { apiKey } = await req.json();
  if (!apiKey) {
    return NextResponse.json({ valid: false, error: "apiKey required" }, { status: 400 });
  }

  const record = await getApiKeyRecord(apiKey);
  if (!record || !record.active) {
    return NextResponse.json({ valid: false });
  }

  // Check key is still the current key for this subscription
  const subscription = await getSubscription(record.address);
  if (subscription) {
    if (subscription.apiKey !== apiKey) {
      return NextResponse.json({ valid: false, error: "API key has been rotated" });
    }
    const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    if (new Date() >= expiresAt) {
      return NextResponse.json({ valid: false, error: "Subscription expired" });
    }
  }

  return NextResponse.json({
    valid: true,
    address: record.address,
    plan: record.plan,
    createdAt: record.createdAt,
  });
}
