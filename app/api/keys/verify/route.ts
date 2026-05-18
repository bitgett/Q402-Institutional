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

  // Check key is still a current key for this subscription. After the Phase
  // 1 trial/paid key separation, a subscription may carry up to four key
  // slots (paid live + paid sandbox + trial live + trial sandbox). The
  // key's scope is determined by record.plan (set at generation time):
  // trial-scoped keys get trial-expiry semantics, paid-scoped keys get
  // paid-expiry semantics — independent of the subscription's CURRENT
  // plan (a paid user with a legacy trial key sees trial gates on it).
  const subscription = await getSubscription(record.address);
  if (subscription) {
    const isCurrentKey =
      subscription.apiKey === apiKey ||
      subscription.sandboxApiKey === apiKey ||
      subscription.trialApiKey === apiKey ||
      subscription.trialSandboxApiKey === apiKey;
    if (!isCurrentKey) {
      return NextResponse.json({ valid: false, error: "API key has been rotated" });
    }
    const isSandboxKey     = record.isSandbox === true;
    const isTrialScopedKey = record.plan === "trial";
    const isPaidAccount    = (subscription.amountUSD ?? 0) > 0 && !!subscription.paidAt;
    // Paid-scope expiry — only for non-trial keys on accounts that paid.
    if (!isSandboxKey && !isTrialScopedKey && isPaidAccount) {
      const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() >= expiresAt) {
        return NextResponse.json({ valid: false, error: "Subscription expired" });
      }
    }
    // Trial-scope expiry — uses the authoritative trialExpiresAt.
    if (!isSandboxKey && isTrialScopedKey) {
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
  // Keyed on the KEY's scope (record.plan === "trial") not the
  // subscription's current plan — so a paid user using their legacy
  // trial key still gets accurate trial-scope metadata back.
  const trialMeta =
    subscription && record.plan === "trial" && subscription.trialExpiresAt
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
