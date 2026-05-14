import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord, getSubscription, getQuotaCredits } from "@/app/lib/db";
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
    const isTrial = subscription.plan === "trial";
    if (!isSandboxKey && isPaidAccount && !isTrial) {
      const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() >= expiresAt) {
        return NextResponse.json({ valid: false, error: "Subscription expired" });
      }
    }
    // Trial-only expiry — same shape but uses the authoritative trialExpiresAt.
    if (!isSandboxKey && isTrial) {
      if (!subscription.trialExpiresAt || new Date() >= new Date(subscription.trialExpiresAt)) {
        return NextResponse.json({ valid: false, error: "Trial expired" });
      }
    }
  }

  // Atomic remaining credits — populated when q402_balance MCP tool calls
  // through. Sandbox keys share the same counter logic as live keys; the
  // call is cheap (single KV GET) so we always compute it.
  const remainingCredits = await getQuotaCredits(record.address);

  // Trial metadata surfaces the days-left + expiry on /keys/verify so the
  // MCP balance tool can show it to the model without a second roundtrip.
  // Non-trial subscriptions return undefined → q402_balance falls back to the
  // existing `verify` blob, no MCP change required.
  const trialMeta =
    subscription && subscription.plan === "trial" && subscription.trialExpiresAt
      ? {
          isTrial: true,
          trialExpiresAt: subscription.trialExpiresAt,
          trialDaysLeft: Math.max(
            0,
            Math.ceil(
              (new Date(subscription.trialExpiresAt).getTime() - Date.now()) / 86_400_000,
            ),
          ),
        }
      : undefined;

  return NextResponse.json({
    valid: true,
    address: record.address,
    plan: record.plan,
    createdAt: record.createdAt,
    remainingCredits,
    ...(trialMeta ? trialMeta : {}),
  });
}
