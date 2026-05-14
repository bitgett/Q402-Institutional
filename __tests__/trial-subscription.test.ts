/**
 * trial-subscription.test.ts
 *
 * Sprint-scoped coverage for the free-trial activation system (A2 of the
 * BNB-focus sprint). Three surfaces are validated:
 *
 *   1. feature-flags constants — TRIAL_CREDITS / TRIAL_DURATION_DAYS /
 *      TRIAL_PLAN_NAME must agree with what the trial route writes to KV
 *      and what the dashboard banner reads.
 *
 *   2. /api/trial/activate source — the route must:
 *      a. use requireFreshAuth (one-time challenge, not session nonce)
 *      b. SET NX on trial_used + trial_claim (idempotency + concurrency)
 *      c. reject paid wallets with code: "ALREADY_PAID"
 *      d. write plan: "trial" + trialExpiresAt with the constant horizon
 *
 *   3. /api/auth/email/start + /callback source — the magic-link flow must:
 *      a. generate a 32-byte hex token with 15-minute TTL
 *      b. SET NX on a consumed marker before reading the token payload
 *      c. write the verified email onto the subscription record
 *
 * Source-level checks are intentional. Behaviour-level tests require a live
 * @vercel/kv mock + a real ECDSA signer, which is overkill for catching the
 * common regression mode (someone edits the route and silently weakens the
 * idempotency or auth path).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TRIAL_CREDITS,
  TRIAL_DURATION_DAYS,
  TRIAL_PLAN_NAME,
} from "../app/lib/feature-flags";

const ROOT = resolve(__dirname, "..");
const trialRouteSource = readFileSync(
  resolve(ROOT, "app", "api", "trial", "activate", "route.ts"),
  "utf8",
);
const emailStartSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "email", "start", "route.ts"),
  "utf8",
);
const emailCallbackSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "email", "callback", "route.ts"),
  "utf8",
);
const dbSource = readFileSync(resolve(ROOT, "app", "lib", "db.ts"), "utf8");
const provisionSource = readFileSync(
  resolve(ROOT, "app", "api", "keys", "provision", "route.ts"),
  "utf8",
);
const paymentCheckSource = readFileSync(
  resolve(ROOT, "app", "api", "payment", "check", "route.ts"),
  "utf8",
);
const relaySource = readFileSync(
  resolve(ROOT, "app", "api", "relay", "route.ts"),
  "utf8",
);

describe("trial — feature-flags constants", () => {
  it("TRIAL_CREDITS is 2,000 (matches sprint plan + Hero CTA copy)", () => {
    expect(TRIAL_CREDITS).toBe(2_000);
  });

  it("TRIAL_DURATION_DAYS is 30 (matches paid subscription window)", () => {
    expect(TRIAL_DURATION_DAYS).toBe(30);
  });

  it('TRIAL_PLAN_NAME is "trial" (used as the plan key in KV)', () => {
    expect(TRIAL_PLAN_NAME).toBe("trial");
  });
});

describe("trial — /api/trial/activate hardening", () => {
  it("uses requireFreshAuth (one-time challenge, not session nonce)", () => {
    expect(trialRouteSource).toMatch(/requireFreshAuth\(\s*body\.address,\s*body\.challenge,\s*body\.signature\s*\)/);
  });

  it("rate-limits at the IP layer (sandbox + trial spam protection)", () => {
    expect(trialRouteSource).toMatch(/rateLimit\(\s*ip,\s*["']trial-activate["']/);
  });

  it("SET NXs trial_used:{addr} as the permanent one-shot sentinel", () => {
    expect(trialRouteSource).toMatch(/trial_used:/);
    expect(trialRouteSource).toMatch(/kv\.set\(\s*trialUsedKey\(addr\)/);
  });

  it("SET NXs trial_claim:{addr} as the in-flight concurrency lock", () => {
    expect(trialRouteSource).toMatch(/trialClaimKey/);
    expect(trialRouteSource).toMatch(/nx:\s*true/);
  });

  it("rejects already-paid wallets with code: ALREADY_PAID", () => {
    expect(trialRouteSource).toMatch(/code:\s*["']ALREADY_PAID["']/);
  });

  it("rejects already-used wallets with code: TRIAL_ALREADY_USED", () => {
    expect(trialRouteSource).toMatch(/code:\s*["']TRIAL_ALREADY_USED["']/);
  });

  it("writes plan: TRIAL_PLAN_NAME and trialExpiresAt on success", () => {
    expect(trialRouteSource).toMatch(/plan:\s*TRIAL_PLAN_NAME/);
    expect(trialRouteSource).toMatch(/trialExpiresAt:\s*trialExpiresAt\.toISOString\(\)/);
  });

  it("addCredits is guarded by credit_grant:trial NX key (idempotent retry)", () => {
    expect(trialRouteSource).toMatch(/credit_grant:trial:/);
    expect(trialRouteSource).toMatch(/addCredits\(\s*addr,\s*TRIAL_CREDITS\s*\)/);
  });
});

describe("trial — db.ts trial fields + isSubscriptionActive branch", () => {
  it("Subscription interface declares trialExpiresAt + email optional fields", () => {
    expect(dbSource).toMatch(/trialExpiresAt\?:\s*string/);
    expect(dbSource).toMatch(/email\?:\s*string/);
  });

  it('isSubscriptionActive routes plan === "trial" through trialExpiresAt', () => {
    expect(dbSource).toMatch(
      /isSubscriptionActive[\s\S]*?plan\s*===\s*["']trial["'][\s\S]*?trialExpiresAt/,
    );
  });

  it("getSubscriptionExpiry returns trialExpiresAt for trial plans", () => {
    expect(dbSource).toMatch(
      /getSubscriptionExpiry[\s\S]*?plan\s*===\s*["']trial["'][\s\S]*?trialExpiresAt/,
    );
  });
});

describe("trial — /api/keys/provision treats active trial as hasPaid", () => {
  it("computes isTrialActive from plan + trialExpiresAt + now", () => {
    expect(provisionSource).toMatch(/isTrialActive\s*=\s*\n?\s*existing\.plan\s*===\s*["']trial["']/);
    expect(provisionSource).toMatch(/new Date\(existing\.trialExpiresAt\)\s*>\s*new Date\(\)/);
  });

  it("returns hasPaid: true for active trial wallets (so live key is exposed)", () => {
    expect(provisionSource).toMatch(/isTrialActive\s*&&\s*!!existing\.apiKey/);
  });
});

describe("trial — /api/payment/check surfaces trial status", () => {
  it('returns status: "trial" with trial expiry when trial is active', () => {
    expect(paymentCheckSource).toMatch(/status:\s*trialExpired\s*\?\s*["']trial_expired["']\s*:\s*["']trial["']/);
  });
});

describe("trial — relay route covers gas for active trials", () => {
  it("computes isActiveTrial from subscription.plan + trialExpiresAt + now", () => {
    expect(relaySource).toMatch(
      /isActiveTrial\s*=\s*\n?\s*subscription\?\.plan\s*===\s*["']trial["']/,
    );
    expect(relaySource).toMatch(/new Date\(subscription\.trialExpiresAt\)\s*>\s*new Date\(\)/);
  });

  it("skips the per-user gas tank balance check for active trials", () => {
    // The gating expression must include !isActiveTrial — otherwise trial
    // users still get the "Insufficient gas tank" rejection they have no
    // way to satisfy (they never deposited because Q402 covers their gas).
    expect(relaySource).toMatch(/if\s*\(\s*!isSandbox\s*&&\s*!isActiveTrial\s*\)/);
  });

  it("zeros gasCostNative in the trial user's per-user TX record (dashboard cleanliness)", () => {
    expect(relaySource).toMatch(
      /gasCostNative:\s*isActiveTrial\s*\?\s*0\s*:\s*gasCostNative/,
    );
  });

  it("increments the trial_gas_burned:{chain} platform counter when gas is consumed", () => {
    // Ops needs visibility into how much native gas Q402 is eating on
    // behalf of trial users — without this HINCRBYFLOAT, the cost is
    // invisible.
    expect(relaySource).toMatch(/trial_gas_burned/);
    expect(relaySource).toMatch(/hincrbyfloat\(\s*["']trial_gas_burned["']/);
  });
});

describe("trial — /api/auth/email/start magic-link generation", () => {
  it("uses 32-byte hex token with 15-minute TTL", () => {
    expect(emailStartSource).toMatch(/TOKEN_BYTES\s*=\s*32/);
    expect(emailStartSource).toMatch(/TOKEN_TTL_SEC\s*=\s*15\s*\*\s*60/);
    expect(emailStartSource).toMatch(/randomBytes\(\s*TOKEN_BYTES\s*\)\.toString\(["']hex["']\)/);
  });

  it("requires fresh wallet challenge (not session nonce) to bind email", () => {
    expect(emailStartSource).toMatch(/requireFreshAuth\(/);
  });

  it("validates email shape before issuing token", () => {
    expect(emailStartSource).toMatch(/\.\+@\.\+\\\.\.\+/);
    expect(emailStartSource).toMatch(/code:\s*["']INVALID_EMAIL["']/);
  });

  it("derives magic-link host from x-forwarded-proto / host headers (no user-supplied baseUrl)", () => {
    expect(emailStartSource).toMatch(/x-forwarded-proto/);
    expect(emailStartSource).toMatch(/req\.headers\.get\(\s*["']host["']\s*\)/);
  });

  it("returns devLink only when RESEND_API_KEY is missing AND NODE_ENV !== production", () => {
    expect(emailStartSource).toMatch(
      /process\.env\.NODE_ENV\s*!==\s*["']production["'][\s\S]*?!process\.env\.RESEND_API_KEY/,
    );
  });
});

describe("trial — /api/auth/email/callback consumes magic-link single-use", () => {
  it("validates token shape (64-char lowercase hex) before any KV read", () => {
    expect(emailCallbackSource).toMatch(/\/\^\[0-9a-f\]\{64\}\$\//);
  });

  it("SET NX on consumed marker BEFORE reading the token payload (single-use)", () => {
    const consumedIdx = emailCallbackSource.indexOf("consumedKey(token)");
    const getPayloadIdx = emailCallbackSource.indexOf("tokenKvKey(token)");
    expect(consumedIdx).toBeGreaterThan(0);
    expect(getPayloadIdx).toBeGreaterThan(0);
    expect(consumedIdx).toBeLessThan(getPayloadIdx);
  });

  it("writes the verified email onto the subscription record (or creates stub)", () => {
    expect(emailCallbackSource).toMatch(/setSubscription\(\s*addr,\s*\{[\s\S]*?email/);
  });

  it("redirects to /dashboard?email=verified on success (302)", () => {
    expect(emailCallbackSource).toMatch(/\/dashboard\?email=verified/);
    expect(emailCallbackSource).toMatch(/NextResponse\.redirect\([^)]+,\s*302\s*\)/);
  });
});
