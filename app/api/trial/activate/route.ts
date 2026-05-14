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
 *   - email optional; when present and not yet associated, the magic-link
 *     flow runs separately at /api/auth/email/start
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getSubscription,
  setSubscription,
  generateApiKey,
  generateSandboxKey,
  getQuotaCredits,
  addCredits,
} from "@/app/lib/db";
import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  TRIAL_CREDITS,
  TRIAL_DURATION_DAYS,
  TRIAL_PLAN_NAME,
} from "@/app/lib/feature-flags";
import { kv } from "@vercel/kv";

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

    // Reuse the wallet's existing keys if the user previously interacted
    // with /api/keys/generate. Otherwise mint fresh ones — both live and
    // sandbox, same as the paid path, so the developer can start in
    // sandbox without a second activation flow.
    let apiKey = existing?.apiKey ?? null;
    if (!apiKey) apiKey = await generateApiKey(addr, TRIAL_PLAN_NAME);
    let sandboxApiKey = existing?.sandboxApiKey ?? null;
    if (!sandboxApiKey) sandboxApiKey = await generateSandboxKey(addr, TRIAL_PLAN_NAME);

    await setSubscription(addr, {
      ...(existing ?? {}),
      paidAt: now.toISOString(),
      apiKey,
      sandboxApiKey,
      plan: TRIAL_PLAN_NAME,
      txHash: "trial", // sentinel — no on-chain TX backs a trial activation
      amountUSD: 0,
      quotaBonus: totalTxs,
      trialExpiresAt: trialExpiresAt.toISOString(),
      ...(body.email && /.+@.+\..+/.test(body.email) ? { email: body.email.toLowerCase() } : {}),
    });

    // Permanent used marker — released only by the next paid activation
    // (which still works because activate doesn't check this key).
    await kv.set(trialUsedKey(addr), addr, { ex: TRIAL_USED_TTL });

    // Best-effort operator alert. Same fail-soft pattern as /api/payment/activate.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      const lines = [
        "🎟️ *New Free Trial*",
        "",
        `*Address:* \`${addr}\``,
        `*Credits:* ${TRIAL_CREDITS.toLocaleString()} TX over ${TRIAL_DURATION_DAYS} days`,
        `*Email:* ${body.email ?? "(not provided)"}`,
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
      apiKey,
      sandboxApiKey,
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
