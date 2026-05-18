/**
 * GET /api/keys/email-sandbox
 *
 * Returns the trial account state bound to the caller's email session:
 * live + sandbox API keys, remaining sponsored TX credits, trial expiry.
 * Used by the dashboard's email-only view to surface everything the user
 * needs in one read after Google / magic-link signup.
 *
 * Auth: session cookie only. The email is read from the KV-backed
 * session; no client-supplied email is trusted.
 */
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { getSession } from "@/app/lib/session";
import {
  getSubscription,
  getQuotaCredits,
} from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { TRIAL_CREDITS } from "@/app/lib/feature-flags";

const emailToAddrKey = (email: string) => `email_to_addr:${email.toLowerCase()}`;

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "email-sandbox", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const pseudoAddr = await kv.get<string>(emailToAddrKey(session.email));
  if (!pseudoAddr) {
    // Signup flow always writes this index — missing key means a partial
    // failure or KV eviction. Surface 404 rather than fabricate state.
    return NextResponse.json({ error: "Account not provisioned. Please sign in again." }, { status: 404 });
  }

  const [subscription, credits] = await Promise.all([
    getSubscription(pseudoAddr),
    getQuotaCredits(pseudoAddr),
  ]);

  if (!subscription) {
    return NextResponse.json({ error: "Account not provisioned. Please sign in again." }, { status: 404 });
  }

  // Surface trial keys explicitly. Legacy callers reading `apiKey` keep
  // working because we fall back to the paid-side apiKey when trialApiKey
  // is missing — covers pre-migration email accounts that minted before
  // the trialApiKey slot existed.
  const trialApiKey = subscription.trialApiKey || subscription.apiKey || null;
  const trialSandboxApiKey =
    subscription.trialSandboxApiKey || subscription.sandboxApiKey || null;

  return NextResponse.json({
    email: session.email,
    plan: subscription.plan,
    apiKey: trialApiKey,
    sandboxApiKey: trialSandboxApiKey,
    trialApiKey,
    trialSandboxApiKey,
    credits,
    totalCredits: TRIAL_CREDITS,
    trialExpiresAt: subscription.trialExpiresAt ?? null,
    hasWallet: !!session.address,
  });
}
