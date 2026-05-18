/**
 * POST /api/auth/google
 *
 * Exchange a Google ID token for a Q402 trial account in one shot:
 *   - 2,000 sponsored TX credits (plan = "trial")
 *   - Live API key (`q402_live_*`) + sandbox key (`q402_test_*`)
 *   - 30-day trial window (`trialExpiresAt`)
 *   - BNB-only enforcement at the relay layer (server-side, see
 *     `app/api/relay/route.ts`'s trial-plan gate)
 *
 * One-shot per email forever — `trial_used_by_email:{email}` is set on
 * first signup with a 10-year TTL so a Google identity can't farm
 * multiple trials by rotating Sub IDs.
 *
 * The "live" key is usable from a developer backend even without the
 * developer holding a wallet: the END USER signs the EIP-712
 * TransferAuthorization at relay time. The developer key authenticates
 * to Q402; the user wallet authorizes the on-chain transfer.
 *
 * Body: { idToken }
 *
 * Returns: { ok, email, name, picture, apiKey, sandboxApiKey,
 *            credits, trialExpiresAt, isNew }
 *
 * Also sets the q402_sid HttpOnly cookie via attachSessionCookie().
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getSubscription,
  setSubscription,
  generateApiKey,
  generateSandboxKey,
  addCredits,
  getQuotaCredits,
  addTrialSubscriptionToIndex,
} from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { verifyGoogleIdToken } from "@/app/lib/google-auth";
import {
  createSession,
  attachSessionCookie,
} from "@/app/lib/session";
import {
  TRIAL_CREDITS,
  TRIAL_DURATION_DAYS,
  TRIAL_PLAN_NAME,
} from "@/app/lib/feature-flags";
import { kv } from "@vercel/kv";

const TRIAL_USED_TTL = 10 * 365 * 24 * 60 * 60;
const emailToAddrKey = (email: string) => `email_to_addr:${email.toLowerCase()}`;
const trialUsedByEmailKey = (email: string) => `trial_used_by_email:${email.toLowerCase()}`;

async function getOrCreatePseudoAddress(email: string, googleSub: string): Promise<string> {
  const existing = await kv.get<string>(emailToAddrKey(email));
  if (existing) return existing;
  const pseudo = `email:${googleSub}`;
  await kv.set(emailToAddrKey(email), pseudo);
  return pseudo;
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "auth-google", 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { idToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.idToken !== "string") {
    return NextResponse.json({ error: "idToken is required" }, { status: 400 });
  }

  const verify = await verifyGoogleIdToken(body.idToken);
  if (!verify.ok) {
    return NextResponse.json({ error: verify.error, code: "GOOGLE_VERIFY_FAILED" }, { status: 401 });
  }
  const { email, sub: googleSub, name, picture } = verify.identity;

  const pseudoAddr = await getOrCreatePseudoAddress(email, googleSub);
  const existing = await getSubscription(pseudoAddr);
  const trialAlreadyClaimed = await kv.get(trialUsedByEmailKey(email));

  // First-time signup AND no prior trial on this email → grant the trial.
  // Existing accounts just refresh the session cookie + return current state.
  // Trial keys live in trialApiKey/trialSandboxApiKey so a future paid
  // activation can mint into apiKey/sandboxApiKey without disturbing them.
  // Legacy pre-migration accounts that only have `apiKey` set are surfaced
  // through that field as a fallback.
  let trialApiKey = existing?.trialApiKey ?? existing?.apiKey ?? "";
  let trialSandboxApiKey =
    existing?.trialSandboxApiKey ?? existing?.sandboxApiKey ?? "";
  let credits = await getQuotaCredits(pseudoAddr);
  let trialExpiresAt: string = existing?.trialExpiresAt ?? "";
  let isNew = false;

  const eligibleForFirstGrant =
    !trialAlreadyClaimed &&
    (!existing || existing.plan !== TRIAL_PLAN_NAME || !trialApiKey);

  if (eligibleForFirstGrant) {
    isNew = true;
    // Mint keys if missing (idempotent against partial-failure retry).
    if (!trialApiKey) trialApiKey = await generateApiKey(pseudoAddr, TRIAL_PLAN_NAME);
    if (!trialSandboxApiKey) trialSandboxApiKey = await generateSandboxKey(pseudoAddr, TRIAL_PLAN_NAME);

    // Grant credits via SET NX so a retried POST can't double-grant.
    const grantKey = `credit_grant:trial:${pseudoAddr}`;
    const canGrant = await kv.set(grantKey, TRIAL_CREDITS, { nx: true, ex: TRIAL_USED_TTL });
    if (canGrant) {
      try {
        await addCredits(pseudoAddr, TRIAL_CREDITS);
      } catch (e) {
        kv.del(grantKey).catch(() => {});
        throw e;
      }
    }
    credits = await getQuotaCredits(pseudoAddr);

    const now = new Date();
    const expiry = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
    trialExpiresAt = expiry.toISOString();

    await setSubscription(pseudoAddr, {
      ...(existing ?? { apiKey: "" }),
      paidAt: now.toISOString(),
      trialApiKey,
      trialSandboxApiKey,
      plan: TRIAL_PLAN_NAME,
      txHash: "google-signup",
      amountUSD: 0,
      quotaBonus: credits,
      trialExpiresAt,
      email,
    });

    // Permanent email-keyed sentinel — same email can't claim a second trial
    // via Google / email magic-link / wallet (the wallet path also checks
    // this key when an email session is present).
    await kv.set(trialUsedByEmailKey(email), pseudoAddr, { ex: TRIAL_USED_TTL });

    // Register in the expiry-reminder index so the cron mails at 7d/3d/1d.
    addTrialSubscriptionToIndex(pseudoAddr).catch(() => {});
  } else if (existing && existing.email !== email) {
    // Returning user — keep their existing keys, just sync the email field
    // if it ever drifted.
    await setSubscription(pseudoAddr, { ...existing, email });
  }

  const sid = await createSession(email);
  const resp = NextResponse.json({
    ok: true,
    email,
    name,
    picture,
    // Legacy fields preserved for older clients reading apiKey/sandboxApiKey.
    apiKey: trialApiKey,
    sandboxApiKey: trialSandboxApiKey,
    trialApiKey,
    trialSandboxApiKey,
    credits,
    trialExpiresAt,
    isNew,
  });
  attachSessionCookie(resp, sid);
  return resp;
}
