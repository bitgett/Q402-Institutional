/**
 * POST /api/trial/activate
 *
 * Free 30-day / 2,000 TX trial entry point (BNB-focus sprint launch).
 *
 * Differences from /api/payment/activate:
 *   - No on-chain TX scan (it's free)
 *   - No payment intent (there's no quote)
 *   - amountUSD: 0, plan: "trial", trialExpiresAt: now + 30d (authoritative
 *     expiry, NOT paidAt + 30d, so the dashboard can show the date directly)
 *   - One-shot per wallet — `trial_used:{addr}` is set permanently on success
 *
 * Shared with paid path:
 *   - Same wallet challenge auth (requireFreshAuth) so spam costs at least
 *     a wallet signature
 *   - Same atomic `decrementCredit` quota counter (reuses the live relay
 *     route's ordering tests for free) — trial credits == 2,000 INCRBY
 *   - Same generateApiKey/generateSandboxKey flow — the user gets both keys
 *     so they can start in sandbox immediately
 *
 * Body: { address, challenge, signature, email? }
 *   - challenge from GET /api/auth/challenge?address={addr}
 *   - `email` in the body is treated as a CLAIM — the trial is activated
 *     immediately, but the email field on the subscription record is only
 *     persisted when the session cookie also resolves to that same verified
 *     email (i.e. the magic-link flow has already completed). Otherwise the
 *     email is silently dropped from the subscription record so an attacker
 *     can't pre-poison `subscription.email` (which gates reminder emails)
 *     by sending an unverified `body.email` together with their own wallet
 *     signature. The verified email also gates trial_used_by_email Sybil
 *     accounting — only verified emails consume the per-email trial slot.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getSubscription,
  setSubscription,
  generateApiKey,
  generateSandboxKey,
  getQuotaCredits,
  addCredits,
  addTrialSubscriptionToIndex,
} from "@/app/lib/db";
import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  TRIAL_CREDITS,
  TRIAL_DURATION_DAYS,
  TRIAL_PLAN_NAME,
} from "@/app/lib/feature-flags";
import { getSession, pairSessionWithWallet, SESSION_COOKIE } from "@/app/lib/session";
import { kv } from "@vercel/kv";
import { writeWalletEmailBridge } from "@/app/lib/wallet-email-bridge";

const TRIAL_USED_TTL = 10 * 365 * 24 * 60 * 60; // 10y — same horizon as used_txhash
const trialUsedKey = (addr: string) => `trial_used:${addr.toLowerCase()}`;
const trialClaimKey = (addr: string) => `trial_claim:${addr.toLowerCase()}`;

export async function POST(req: NextRequest) {
  // Rate limit: 5 trial attempts / 60 s per IP. The actual one-per-wallet
  // ceiling is the trial_used sentinel below; the IP cap protects KV from
  // a script spinning through wallets faster than the verifier can reject.
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "trial-activate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: {
    address?: string;
    challenge?: string;
    signature?: string;
    email?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const authResult = await requireFreshAuth(body.address, body.challenge, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  // Adopt the email session up front. Read here (not later) so the
  // trial_used_by_email block can be enforced at the same gate as the
  // wallet sentinel — a single Google account can't claim multiple trials
  // by rotating wallets.
  //
  // SECURITY: `body.email` is a hint, not a credential. We accept it ONLY
  // when it matches the session cookie's verified email (case-insensitive).
  // Any other value is dropped — never written to subscription.email and
  // never used as a Sybil sentinel key. This stops a wallet-signed request
  // with a forged email from quietly attaching that email to the wallet's
  // subscription (which the reminder cron would then mail).
  let adoptedEmail: string | null = null;
  if (req.cookies.get(SESSION_COOKIE)) {
    const session = await getSession(req);
    if (session?.email) {
      adoptedEmail = session.email.toLowerCase();
    }
  }
  const claimedEmail =
    body.email && /.+@.+\..+/.test(body.email)
      ? body.email.toLowerCase()
      : null;
  // finalEmail is whichever email we trust to write to subscription.email.
  // Only the session email is verified; a claimed body.email is honored only
  // when it equals the session email (UI fills it from the session for
  // display, so a match is the expected happy path).
  const finalEmail =
    adoptedEmail && (!claimedEmail || claimedEmail === adoptedEmail)
      ? adoptedEmail
      : null;

  // One-shot per wallet — permanent sentinel survives expiry, so an
  // already-used wallet can't claim a second free trial after the first one
  // ended. The intended upgrade path is /api/payment/activate.
  const alreadyUsed = await kv.get(trialUsedKey(addr));
  if (alreadyUsed) {
    return NextResponse.json(
      {
        error: "This wallet has already used the free trial. Upgrade at /pricing.",
        code: "TRIAL_ALREADY_USED",
      },
      { status: 409 },
    );
  }

  // Sybil cap by email — paired with the wallet sentinel above, this stops
  // one Google identity from harvesting multiple trials via fresh wallets.
  // Only fires when the user actually signed in with email/Google first;
  // pure wallet-flow users skip this check (no email to key against).
  if (adoptedEmail) {
    const alreadyUsedByEmail = await kv.get(`trial_used_by_email:${adoptedEmail}`);
    if (alreadyUsedByEmail) {
      return NextResponse.json(
        {
          error: "This email has already claimed a free trial. Upgrade at /pricing.",
          code: "TRIAL_ALREADY_USED_EMAIL",
        },
        { status: 409 },
      );
    }
  }

  // If the wallet already has a paid subscription, free trial is moot.
  const existing = await getSubscription(addr);
  if (existing && existing.plan !== TRIAL_PLAN_NAME && (existing.amountUSD ?? 0) > 0) {
    return NextResponse.json(
      {
        error: "This wallet already has a paid subscription — trial activation is for new wallets only.",
        code: "ALREADY_PAID",
      },
      { status: 409 },
    );
  }

  // Distributed lock — block concurrent activation from two tabs at the
  // same wallet. 30s is well over the inner critical section.
  const claimed = await kv.set(trialClaimKey(addr), "1", { nx: true, ex: 30 });
  if (!claimed) {
    return NextResponse.json(
      {
        error: "Trial activation already in progress. Try again in a moment.",
        code: "TRIAL_IN_PROGRESS",
      },
      { status: 409 },
    );
  }

  try {
    const now = new Date();
    const trialExpiresAt = new Date(
      now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000,
    );

    // Idempotency: same wallet retrying after a partial failure should not
    // double-grant credits. Guard with credit_grant:trial:{addr} SET NX —
    // same pattern as the paid activate route's credit_grant key.
    const grantKey = `credit_grant:trial:${addr}`;
    const canGrant = await kv.set(grantKey, TRIAL_CREDITS, {
      nx: true,
      ex: TRIAL_USED_TTL,
    });
    if (canGrant) {
      try {
        await addCredits(addr, TRIAL_CREDITS);
      } catch (e) {
        kv.del(grantKey).catch(() => {});
        throw e;
      }
    }

    const totalTxs = await getQuotaCredits(addr);

    // Trial keys live in their own slot (trialApiKey / trialSandboxApiKey) so
    // a later paid activation can mint fresh paid keys into apiKey without
    // touching anything trial-scoped. Reuse if the user already activated
    // (idempotent retry); otherwise mint with plan=trial so the relay
    // route's per-plan gates see the right scope. The paid apiKey slot is
    // left alone — we only set it to "" on brand-new accounts where there's
    // no prior provision stub to preserve.
    let trialApiKey = existing?.trialApiKey ?? null;
    if (!trialApiKey) trialApiKey = await generateApiKey(addr, TRIAL_PLAN_NAME);
    let trialSandboxApiKey = existing?.trialSandboxApiKey ?? null;
    if (!trialSandboxApiKey) trialSandboxApiKey = await generateSandboxKey(addr, TRIAL_PLAN_NAME);

    await setSubscription(addr, {
      ...(existing ?? {
        apiKey: "",
        sandboxApiKey: undefined,
      }),
      paidAt: now.toISOString(),
      trialApiKey,
      trialSandboxApiKey,
      plan: TRIAL_PLAN_NAME,
      txHash: "trial", // sentinel — no on-chain TX backs a trial activation
      amountUSD: 0,
      quotaBonus: totalTxs,
      trialExpiresAt: trialExpiresAt.toISOString(),
      ...(finalEmail ? { email: finalEmail } : {}),
    });

    // Permanent used marker — released only by the next paid activation
    // (which still works because activate doesn't check this key).
    await kv.set(trialUsedKey(addr), addr, { ex: TRIAL_USED_TTL });

    // If we adopted an email session, also block this email from claiming
    // another trial via a different wallet — caps the Sybil ceiling per
    // verified email. Same 10y TTL as the wallet sentinel.
    if (adoptedEmail) {
      await kv.set(`trial_used_by_email:${adoptedEmail}`, addr, { ex: TRIAL_USED_TTL });
      // Pair the session to the wallet so /api/auth/me reflects the binding
      // on the next dashboard load (the email-only view will swap out for
      // the full wallet view without requiring a session refresh).
      const sid = req.cookies.get(SESSION_COOKIE)?.value;
      if (sid) {
        await pairSessionWithWallet(sid, addr).catch(() => {});
      }
      // Read-side bridge + 1:1 enforcement indexes — same pair the
      // /api/auth/wallet-bind route writes. Awaited, with per-key retry +
      // ops alert on persistent failure. See wallet-email-bridge.ts.
      await writeWalletEmailBridge(addr, adoptedEmail, TRIAL_USED_TTL, "trial-activate");
    }

    // Register this wallet for the trial-expiry cron (best-effort; missing
    // index entry just means no reminder email — trial still works fine).
    // Only register when an email is actually available, since the cron's
    // only output is email; an emailless trial doesn't need indexing.
    if (finalEmail) {
      addTrialSubscriptionToIndex(addr).catch(e =>
        console.error("[trial/activate] trial-index add failed (non-fatal):", e),
      );
    }

    // Best-effort operator alert. Same fail-soft pattern as /api/payment/activate.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      const lines = [
        "🎟️ *New Free Trial*",
        "",
        `*Address:* \`${addr}\``,
        `*Credits:* ${TRIAL_CREDITS.toLocaleString()} TX over ${TRIAL_DURATION_DAYS} days`,
        `*Email:* ${finalEmail ?? (claimedEmail ? `${claimedEmail} (unverified — dropped)` : "(not provided)")}`,
        `*Expires:* ${trialExpiresAt.toISOString().slice(0, 10)}`,
      ].join("\n");
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: lines, parse_mode: "Markdown" }),
        });
      } catch {
        /* non-critical — trial is already committed */
      }
    }

    return NextResponse.json({
      status: "activated",
      plan: TRIAL_PLAN_NAME,
      credits: TRIAL_CREDITS,
      totalTxs,
      trialExpiresAt: trialExpiresAt.toISOString(),
      // Surface under both legacy + new names: callers that have not yet
      // adopted the trialApiKey field (older dashboard build, scripts) keep
      // working; new callers should prefer the trial* fields.
      apiKey: trialApiKey,
      sandboxApiKey: trialSandboxApiKey,
      trialApiKey,
      trialSandboxApiKey,
    });
  } catch (e) {
    console.error(`[trial/activate] write failure addr=${addr}:`, e);
    return NextResponse.json(
      { error: "Trial activation failed. Please try again.", code: "TRIAL_RETRY" },
      { status: 500 },
    );
  } finally {
    kv.del(trialClaimKey(addr)).catch(() => {});
  }
}
