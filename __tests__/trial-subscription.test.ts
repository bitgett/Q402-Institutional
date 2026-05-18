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
const cronUsageAlertSource = readFileSync(
  resolve(ROOT, "app", "api", "cron", "usage-alert", "route.ts"),
  "utf8",
);
const emailLibSource = readFileSync(resolve(ROOT, "app", "lib", "email.ts"), "utf8");

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

  it("trial credit grant is guarded by credit_grant:trial NX key (idempotent retry)", () => {
    expect(trialRouteSource).toMatch(/credit_grant:trial:/);
    // Phase 2 two-pool migration: trial activate must write into the trial
    // pool (`quota:trial:{addr}`) via `addScopedCredits`. Legacy
    // `addCredits` would route into the paid pool — silently incorrect.
    expect(trialRouteSource).toMatch(
      /addScopedCredits\(\s*addr,\s*["']trial["'],\s*TRIAL_CREDITS\s*\)/,
    );
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

describe("trial — /api/keys/provision exposes trial + paid keys separately", () => {
  it("computes isTrialActive from trial key signal + trialExpiresAt + now (no plan-only gate)", () => {
    // BUG FIX (two-pool migration): the previous `plan === "trial"` gate
    // turned isTrialActive=false the moment a user upgraded to a paid plan,
    // even though their trial key + 29 days of trial credits were still
    // valid. The dashboard's Trial view then rendered 0.
    //
    // v0.4.4 additionally accepts a legacy trial signal — pre-Phase-1 trial
    // accounts wrote the trial key into the `apiKey` slot with plan="trial"
    // (no `trialApiKey` field existed yet). Without that fallback, those
    // pre-migration accounts (still present in production) were stuck with
    // isTrialActive=false even though the credits exist. Accept either:
    //   (a) the modern `existing.trialApiKey` signal, OR
    //   (b) the legacy `plan === "trial" && apiKey` signal.
    expect(provisionSource).toMatch(/hasLegacyTrialKey/);
    expect(provisionSource).toMatch(
      /isTrialActive\s*=\s*\n?\s*\(!!existing\.trialApiKey\s*\|\|\s*hasLegacyTrialKey\)\s*&&[\s\S]{0,120}?!!existing\.trialExpiresAt/,
    );
    expect(provisionSource).toMatch(/new Date\(existing\.trialExpiresAt\)\s*>\s*new Date\(\)/);
    // The strict plan === "trial" sole gate must NOT be reinstated.
    expect(provisionSource).not.toMatch(/isTrialActive\s*=\s*\n?\s*existing\.plan\s*===\s*["']trial["']\s*&&/);
  });

  it("returns amountUSD on the response (so dashboard hydrates it correctly)", () => {
    // BUG FIX (two-pool migration): the prior provision response omitted
    // amountUSD, so the dashboard defaulted it to 0 on every reload and
    // showPaidScope evaluated false even for paying users.
    expect(provisionSource).toMatch(/amountUSD:\s*existing\.amountUSD\s*\?\?\s*0/);
  });

  it("returns scoped credit counts (trialCredits + paidCredits) from getScopedCredits", () => {
    // Two-pool migration: provision is the dashboard's primary credit
    // source. It must read fresh scoped counters on every call so the UI
    // never serves stale mirror values.
    expect(provisionSource).toMatch(/trialCredits[,:]/);
    expect(provisionSource).toMatch(/paidCredits[,:]/);
    expect(provisionSource).toMatch(/getScopedCredits\(addr,\s*["']trial["']\)/);
    expect(provisionSource).toMatch(/getScopedCredits\(addr,\s*["']paid["']\)/);
  });

  it("surfaces trialApiKey separately from the paid apiKey slot", () => {
    // The two scopes used to share the apiKey slot — a trial user who
    // upgraded had no isolation between their trial-scoped traffic and
    // their paid-scoped traffic. Now trial keys live in trialApiKey, paid
    // keys in apiKey, and provision returns both. After Phase 1.5 the
    // trial slots also fall back to the boundEmailTrial bridge for
    // wallet-only logins.
    expect(provisionSource).toMatch(/trialApiKey:\s*trialApiKey\s*\|\|\s*boundEmailTrial\?\.apiKey/);
    expect(provisionSource).toMatch(/trialSandboxApiKey:\s*trialSandboxApiKey\s*\|\|\s*boundEmailTrial\?\.sandboxApiKey/);
    expect(provisionSource).toMatch(/isTrialActive:/);
  });

  it("falls back to legacy existing.apiKey for pre-migration trial accounts", () => {
    // Legacy trial activations wrote into existing.apiKey/sandboxApiKey
    // when plan==="trial". provision keeps surfacing those through
    // trialApiKey so the dashboard's trial view doesn't lose its key for
    // accounts that haven't been re-activated since the schema split.
    expect(provisionSource).toMatch(
      /existing\.trialApiKey[\s\S]*?isTrialActive\s*\?\s*existing\.apiKey/,
    );
  });

  it("only marks hasPaid true when amountUSD > 0 AND a paid apiKey is set", () => {
    // Active trials are NOT counted as paid — the dashboard's Multichain
    // card relies on hasPaid to decide unlocked vs Locked state.
    expect(provisionSource).toMatch(
      /isPaid\s*=\s*\(existing\.amountUSD\s*\?\?\s*0\)\s*>\s*0\s*&&\s*!!paidApiKey/,
    );
  });
});

describe("trial — /api/payment/check surfaces trial status", () => {
  it('returns status: "trial" with trial expiry when trial is active', () => {
    expect(paymentCheckSource).toMatch(/status:\s*trialExpired\s*\?\s*["']trial_expired["']\s*:\s*["']trial["']/);
  });
});

describe("trial — relay route covers gas for active trials", () => {
  it("computes isActiveTrial from key scope (isTrialScopedKey) + trialExpiresAt + now", () => {
    // After the Phase 1 + scope fix, trial gating is keyed on the KEY's
    // own plan (keyRecord.plan === "trial"), not on subscription.plan.
    // This correctly handles paid users with legacy active trial keys.
    expect(relaySource).toMatch(
      /isActiveTrial\s*=\s*\n?\s*isTrialScopedKey\s*&&/,
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

describe("trial — email session merges into wallet activation", () => {
  it("reads the session cookie BEFORE the trial_used wallet check", () => {
    // Order matters: we want the email available so the by-email Sybil
    // block can fire at the same gate as the by-wallet sentinel.
    const sessionIdx = trialRouteSource.indexOf("getSession(req)");
    const usedIdx = trialRouteSource.indexOf("trialUsedKey(addr)");
    expect(sessionIdx).toBeGreaterThan(0);
    expect(usedIdx).toBeGreaterThan(0);
    expect(sessionIdx).toBeLessThan(usedIdx);
  });

  it("rejects with TRIAL_ALREADY_USED_EMAIL when an email session has already claimed a trial", () => {
    expect(trialRouteSource).toMatch(/trial_used_by_email:/);
    expect(trialRouteSource).toMatch(/code:\s*["']TRIAL_ALREADY_USED_EMAIL["']/);
  });

  it("drops body.email when it does not match the session-verified email (Q402-SEC-004)", () => {
    // body.email is a HINT for the UI, never a credential. The trial route
    // only writes subscription.email when the session cookie resolves to a
    // verified email AND (either no body.email is supplied OR body.email
    // matches the session email). Otherwise finalEmail is null so an
    // attacker can't poison subscription.email by sending an unverified
    // body.email alongside their own wallet signature.
    expect(trialRouteSource).toMatch(/claimedEmail/);
    expect(trialRouteSource).toMatch(
      /finalEmail\s*=\s*\n?\s*adoptedEmail\s*&&\s*\(!claimedEmail\s*\|\|\s*claimedEmail\s*===\s*adoptedEmail\)/,
    );
  });

  it("pairs the session with the wallet on successful activation (so /api/auth/me reflects it)", () => {
    expect(trialRouteSource).toMatch(/pairSessionWithWallet\(sid,\s*addr\)/);
  });

  it("atomically claims trial_used_by_email:{email} via SET NX before granting credits", () => {
    // Regression guard: previous revision checked the sentinel then wrote
    // it at separate gates. Two concurrent activations with the same
    // verified email both passed the check, both granted credits, and only
    // then raced to write — same email got TWO trials. The claim now uses
    // SET NX (claim-if-absent) and the route rejects with
    // TRIAL_ALREADY_USED_EMAIL on collision.
    expect(trialRouteSource).toMatch(/trial_used_by_email:\$\{adoptedEmail\}/);
    expect(trialRouteSource).toMatch(/kv\.set\([\s\S]+?nx:\s*true[\s\S]+?ex:\s*TRIAL_USED_TTL/);
    expect(trialRouteSource).toMatch(/code:\s*"TRIAL_ALREADY_USED_EMAIL"/);
    // The claim must precede the credit grant — that's the whole point of
    // NX being a pre-credit gate. Two-pool migration routes the grant
    // through addScopedCredits(..., "trial", ...).
    const claimIdx = trialRouteSource.indexOf("trial_used_by_email:${adoptedEmail}");
    const grantIdx = trialRouteSource.indexOf("await addScopedCredits(");
    expect(claimIdx).toBeGreaterThan(0);
    expect(grantIdx).toBeGreaterThan(0);
    expect(claimIdx).toBeLessThan(grantIdx);
  });

  it("registers the wallet in the trial-expiry index when an email is bound", () => {
    expect(trialRouteSource).toMatch(/addTrialSubscriptionToIndex\(addr\)/);
  });

  it("only rolls back trial_used_by_email when NO credits have persisted", () => {
    // Regression guard: an earlier iteration of the P1-4 fix wrapped the
    // catch block with a blanket `kv.del(trial_used_by_email:...)`. That
    // reopened the Sybil race the SET NX was supposed to close — if the
    // route threw AFTER addCredits succeeded (network blip on a later
    // KV write), the email sentinel got deleted and a different wallet
    // with the same email could re-claim and ALSO get credited.
    //
    // The rollback must be gated by a `creditsPersisted` flag that flips
    // to true the moment addCredits succeeds OR the credit_grant key is
    // already present (= a prior call's credits are still in the ledger).
    expect(trialRouteSource).toMatch(/let\s+creditsPersisted\s*=\s*false/);
    // Two-pool migration: grant is now scoped to the trial pool.
    expect(trialRouteSource).toMatch(
      /await\s+addScopedCredits\(addr,\s*["']trial["'],\s*TRIAL_CREDITS\)[\s\S]{0,80}?creditsPersisted\s*=\s*true/,
    );
    // The catch's rollback must require !creditsPersisted in addition to
    // emailClaimedByUs.
    expect(trialRouteSource).toMatch(
      /emailClaimedByUs[\s\S]{0,80}?!creditsPersisted[\s\S]{0,160}?kv\.del\(\s*`trial_used_by_email:/,
    );
  });
});

describe("trial — expiry-reminder cron leg", () => {
  it("iterates listTrialSubscriptionAddresses (no full-KV scan)", () => {
    expect(cronUsageAlertSource).toMatch(/listTrialSubscriptionAddresses\(\)/);
  });

  it("declares 7d / 3d / 1d reminder tiers", () => {
    expect(cronUsageAlertSource).toMatch(/TRIAL_ALERT_TIERS\s*=\s*\[\s*7,\s*3,\s*1\s*\]/);
  });

  it("prunes expired or non-trial index entries via removeTrialSubscriptionFromIndex", () => {
    expect(cronUsageAlertSource).toMatch(/removeTrialSubscriptionFromIndex\(addr\)/);
  });

  it("records the alerted tier via recordTrialAlertSent (downward-only hysteresis)", () => {
    expect(cronUsageAlertSource).toMatch(/recordTrialAlertSent\(addr,\s*tier\)/);
  });

  it("uses renderTrialExpiryHtml template", () => {
    expect(cronUsageAlertSource).toMatch(/renderTrialExpiryHtml\(/);
    expect(emailLibSource).toMatch(/export function renderTrialExpiryHtml/);
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

  it("derives magic-link host via getAppOrigin(req) — not raw Host header reads", () => {
    // Auth-bearing links flow through app/lib/app-origin.ts. The helper
    // takes the inbound request so preview deploys (no APP_ORIGIN env)
    // can resolve back to their own host instead of pointing at a
    // production deploy that may not have the email/* routes yet.
    // Direct Host-header reads in the route body remain forbidden —
    // the helper is the single source of origin truth.
    expect(emailStartSource).toMatch(/getAppOrigin\(\s*req\s*\)/);
    expect(emailStartSource).not.toMatch(/x-forwarded-proto/);
    expect(emailStartSource).not.toMatch(/req\.headers\.get\(\s*["']host["']\s*\)/);
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
