import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord, getSubscription } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "keys-verify", 20, 60))) {
    return NextResponse.json({ valid: false, error: "Too many requests" }, { status: 429 });
  }

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, error: "Invalid JSON" }, { status: 400 });
  }
  const { apiKey } = body;
  if (typeof apiKey !== "string" || !apiKey) {
    return NextResponse.json({ valid: false, error: "apiKey required" }, { status: 400 });
  }

  const record = await getApiKeyRecord(apiKey);
  if (!record || !record.active) {
    return NextResponse.json({ valid: false });
  }

  // Check key is still the current live or sandbox key for this subscription
  const subscription = await getSubscription(record.address);
  if (subscription) {
    const isCurrentKey =
      subscription.apiKey === apiKey ||
      subscription.sandboxApiKey === apiKey;
    if (!isCurrentKey) {
      return NextResponse.json({ valid: false, error: "API key has been rotated" });
    }
    // Expiry only applies to paid live keys.
    // Sandbox keys and provisioned-only accounts (paidAt="") are never expired.
    const isSandboxKey  = record.isSandbox === true;
    const isPaidAccount = (subscription.amountUSD ?? 0) > 0 && !!subscription.paidAt;
    if (!isSandboxKey && isPaidAccount) {
      const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() >= expiresAt) {
        return NextResponse.json({ valid: false, error: "Subscription expired" });
      }
    }
  }

  return NextResponse.json({
    valid: true,
    address: record.address,
    plan: record.plan,
    createdAt: record.createdAt,
  });
}
