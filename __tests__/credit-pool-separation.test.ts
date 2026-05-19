/**
 * credit-pool-separation.test.ts
 *
 * Source-grep coverage for the Phase 2 single-pool → two-pool credit
 * migration. The architecture splits the historical `quota:{addr}` counter
 * into two scoped counters — `quota:trial:{addr}` and `quota:paid:{addr}` —
 * so the dashboard can render Trial and Multichain credits independently
 * AND so a trial-keyed relay can never drain the paid pool (or vice versa).
 *
 * These assertions pin the wire shape across db.ts, the four activate
 * routes, the relay route, provision/verify/email-sandbox, the dashboard
 * hydration path, cron usage-alert, and the topup endpoint. If a refactor
 * accidentally reverts a scope, this suite fails fast.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const dbSource             = read("app/lib/db.ts");
const trialActivateSource  = read("app/api/trial/activate/route.ts");
const paymentActivateSource= read("app/api/payment/activate/route.ts");
const emailCallbackSource  = read("app/api/auth/email/callback/route.ts");
const googleSource         = read("app/api/auth/google/route.ts");
const relaySource          = read("app/api/relay/route.ts");
const provisionSource      = read("app/api/keys/provision/route.ts");
const verifySource         = read("app/api/keys/verify/route.ts");
const emailSandboxSource   = read("app/api/keys/email-sandbox/route.ts");
const dashboardSource      = read("app/dashboard/page.tsx");
const cronSource           = read("app/api/cron/usage-alert/route.ts");
const topupSource          = read("app/api/keys/topup/route.ts");

describe("db.ts — scoped key model + helpers", () => {
  it("declares scopedQuotaKey helper with `quota:${scope}:${addr}` format", () => {
    expect(dbSource).toMatch(
      /scopedQuotaKey\s*=\s*\(\s*addr:\s*string,\s*scope:\s*CreditScope\s*\)[\s\S]{0,200}?quota:\$\{scope\}:\$\{addr\.toLowerCase\(\)\}/,
    );
  });

  it("declares legacyQuotaKey helper pointing at the pre-migration `quota:{addr}` key", () => {
    expect(dbSource).toMatch(
      /legacyQuotaKey\s*=\s*\(\s*addr:\s*string\s*\)[\s\S]{0,120}?quota:\$\{addr\.toLowerCase\(\)\}/,
    );
  });

  it("exports CreditScope = 'trial' | 'paid'", () => {
    expect(dbSource).toMatch(/CreditScope\s*=\s*["']trial["']\s*\|\s*["']paid["']/);
  });

  it("exports getScopedCredits / addScopedCredits / decrementScopedCredit / refundScopedCredit / initScopedQuotaIfNeeded / seedFromLegacy", () => {
    for (const fn of [
      "getScopedCredits",
      "addScopedCredits",
      "decrementScopedCredit",
      "refundScopedCredit",
      "initScopedQuotaIfNeeded",
      "seedFromLegacy",
    ]) {
      expect(dbSource).toMatch(new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`));
    }
  });

  it("getScopedCredits reads the scoped key first (post-migration source of truth)", () => {
    const fn = dbSource.match(/export\s+async\s+function\s+getScopedCredits[\s\S]+?\n\}/);
    expect(fn).toBeTruthy();
    // The body must hit scopedQuotaKey before any legacy fallback.
    const body = fn![0];
    const scopedIdx = body.indexOf("scopedQuotaKey");
    const legacyIdx = body.indexOf("legacyQuotaKey");
    expect(scopedIdx).toBeGreaterThan(0);
    if (legacyIdx > 0) expect(scopedIdx).toBeLessThan(legacyIdx);
  });

  it("Subscription interface declares trialQuotaBonus + paidQuotaBonus mirrors", () => {
    expect(dbSource).toMatch(/trialQuotaBonus\?:\s*number/);
    expect(dbSource).toMatch(/paidQuotaBonus\?:\s*number/);
  });

  it("addQuotaBonus (admin topup) hardcodes the paid scope", () => {
    // Trial topup would bypass trial TTL gating — the admin surface is
    // paid-only by construction. Verify the legacy wrapper routes to "paid".
    const fn = dbSource.match(/export\s+async\s+function\s+addQuotaBonus[\s\S]+?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).toMatch(/addScopedCredits\([\s\S]{0,40}?["']paid["']/);
  });
});

describe("activate routes — write to the matching pool", () => {
  it("trial/activate grants into the trial pool", () => {
    expect(trialActivateSource).toMatch(
      /addScopedCredits\(\s*addr,\s*["']trial["'],\s*TRIAL_CREDITS\s*\)/,
    );
  });

  it("trial/activate writes trialQuotaBonus mirror onto the subscription", () => {
    expect(trialActivateSource).toMatch(/trialQuotaBonus:/);
  });

  it("payment/activate grants into the paid pool", () => {
    expect(paymentActivateSource).toMatch(
      /addScopedCredits\(\s*addr,\s*["']paid["'],\s*addedTxs\s*\)/,
    );
  });

  it("payment/activate writes paidQuotaBonus mirror onto the subscription", () => {
    expect(paymentActivateSource).toMatch(/paidQuotaBonus:/);
  });

  it("payment/activate pre-seeds the trial pool BEFORE flipping the sub to paid (trial-only transition)", () => {
    // The seed runs only when `hasTrialSignal && !hasPaidSignal` — i.e. a
    // pure-trial sub that's about to receive its first paid grant. Without
    // this, the legacy quota counter would be ambiguous to seedFromLegacy
    // once `plan` flips to a paid tier.
    expect(paymentActivateSource).toMatch(/hasTrialSignal\s*&&\s*!hasPaidSignal/);
    expect(paymentActivateSource).toMatch(
      /initScopedQuotaIfNeeded\(\s*addr,\s*["']trial["']/,
    );
  });

  it("payment/activate promotes legacy trial key from apiKey slot to trialApiKey slot", () => {
    // Pre-Phase-1 trial accounts stored the trial key in `apiKey` (no
    // `trialApiKey` field existed). If payment/activate didn't move it to
    // the trialApiKey slot, the paid activation would (a) reuse the trial
    // key as the paid live key and (b) flip its plan attribute from "trial"
    // to the paid tier via updateApiKeyPlan — orphaning the trial pool
    // credits because no key in the user's possession would have
    // plan==="trial" to spend them.
    //
    // The promotion runs when `hasLegacyTrialKey && existing.apiKey` and
    // moves apiKey → trialApiKey (plus sandbox), clears apiKey so a fresh
    // paid key gets generated downstream. Pin the shape so a future
    // refactor can't quietly drop the migration step.
    expect(paymentActivateSource).toMatch(/hasLegacyTrialKey\s*&&\s*existing\.apiKey/);
    expect(paymentActivateSource).toMatch(/existing\.trialApiKey\s*=\s*existing\.apiKey/);
    expect(paymentActivateSource).toMatch(/existing\.trialSandboxApiKey\s*=\s*existing\.sandboxApiKey/);
    expect(paymentActivateSource).toMatch(/existing\.apiKey\s*=\s*""/);
  });

  it("email/callback grants pseudo-trial into the trial pool", () => {
    expect(emailCallbackSource).toMatch(
      /addScopedCredits\(\s*pseudoAddr,\s*["']trial["'],\s*TRIAL_CREDITS\s*\)/,
    );
  });

  it("google signup grants pseudo-trial into the trial pool", () => {
    expect(googleSource).toMatch(
      /addScopedCredits\(\s*pseudoAddr,\s*["']trial["'],\s*TRIAL_CREDITS\s*\)/,
    );
  });
});

describe("relay route — scope-aware reservation + refund", () => {
  it("defines creditScope from isTrialScopedKey BEFORE the actual decrementScopedCredit call", () => {
    // Match the *assignment* (creditScope = ...) and the *call*
    // (decrementScopedCredit(...)) — not the surrounding documentation
    // strings, which also mention these symbols.
    const scopeIdx  = relaySource.search(/creditScope\s*=\s*isTrialScopedKey\s*\?\s*["']trial["']\s*:\s*["']paid["']/);
    const decIdx    = relaySource.search(/const\s+dec\s*=\s*await\s+decrementScopedCredit\(/);
    expect(scopeIdx).toBeGreaterThan(0);
    expect(decIdx).toBeGreaterThan(0);
    expect(scopeIdx).toBeLessThan(decIdx);
  });

  it("seeds the scoped pool from legacy before reserving (idempotent)", () => {
    const seedIdx = relaySource.search(/const\s+seed\s*=\s*await\s+seedFromLegacy\(\s*keyRecord\.address,\s*creditScope\s*\)/);
    const decIdx  = relaySource.search(/const\s+dec\s*=\s*await\s+decrementScopedCredit\(/);
    expect(seedIdx).toBeGreaterThan(0);
    expect(seedIdx).toBeLessThan(decIdx);
  });

  it("refunds into the same pool that was decremented (captured creditScope)", () => {
    // Regression guard: re-deriving the scope at refund time would split
    // refund vs decrement on a key-rotation edge case. Capture-at-decrement
    // is the safe pattern.
    expect(relaySource).toMatch(/await\s+refundScopedCredit\(\s*keyRecord\.address,\s*creditScope\s*\)/);
  });

  it("quick pre-check is scope-aware (trial keys check trial pool, paid keys check paid pool)", () => {
    // The pre-check derives a local quickScope from isTrialScopedKey, then
    // reads getScopedCredits with it. Pattern accepts both styles.
    expect(relaySource).toMatch(
      /quickScope\s*:\s*CreditScope\s*=\s*isTrialScopedKey\s*\?\s*["']trial["']\s*:\s*["']paid["']/,
    );
    expect(relaySource).toMatch(
      /getScopedCredits\(\s*keyRecord\.address,\s*quickScope\s*\)/,
    );
  });

  it("mirror sync writes to the trial OR paid bonus field based on creditScope", () => {
    expect(relaySource).toMatch(
      /creditScope\s*===\s*["']trial["']\s*\?\s*["']trialQuotaBonus["']\s*:\s*["']paidQuotaBonus["']/,
    );
  });
});

describe("Q402-SEC-001 ordering — scope-aware version", () => {
  it("loadRelayerKey < decrementScopedCredit < first settle call", () => {
    const loadIdx = relaySource.search(/const key = loadRelayerKey\(\);/);
    const decIdx  = relaySource.search(/const\s+dec\s*=\s*await\s+decrementScopedCredit\(/);
    const relayIdx= relaySource.search(/result\s*=\s*await\s+settlePayment(?:EIP3009|XLayerEIP7702|StableEIP7702)?\(/);
    expect(loadIdx).toBeGreaterThan(0);
    expect(decIdx).toBeGreaterThan(loadIdx);
    expect(relayIdx).toBeGreaterThan(decIdx);
  });
});

describe("provision response — two-pool fields exposed", () => {
  it("returns trialCredits + paidCredits from getScopedCredits", () => {
    expect(provisionSource).toMatch(/trialCredits[,:]/);
    expect(provisionSource).toMatch(/paidCredits[,:]/);
    expect(provisionSource).toMatch(/getScopedCredits\(addr,\s*["']trial["']\)/);
    expect(provisionSource).toMatch(/getScopedCredits\(addr,\s*["']paid["']\)/);
  });

  it("isTrialActive does NOT require plan === 'trial' (Bug Fix 1)", () => {
    // Verify the legacy gate is gone. Paid users with active legacy trial
    // keys must still see their Trial view populated.
    expect(provisionSource).not.toMatch(/isTrialActive\s*=\s*existing\.plan\s*===\s*["']trial["']/);
  });

  it("includes amountUSD on the response (Bug Fix 2)", () => {
    expect(provisionSource).toMatch(/amountUSD:\s*existing\.amountUSD\s*\?\?\s*0/);
  });

  it("loadBoundEmailTrial reads from the trial pool (pseudos are trial-only)", () => {
    expect(provisionSource).toMatch(/getScopedCredits\(\s*pseudoAddr,\s*["']trial["']\s*\)/);
  });
});

describe("verify route — MCP balance picks scope from key's plan", () => {
  it("CreditScope picked from record.plan === 'trial'", () => {
    expect(verifySource).toMatch(
      /scope:\s*CreditScope\s*=\s*record\.plan\s*===\s*["']trial["']\s*\?\s*["']trial["']\s*:\s*["']paid["']/,
    );
  });

  it("remainingCredits reads via getScopedCredits", () => {
    expect(verifySource).toMatch(/getScopedCredits\(record\.address,\s*scope\)/);
  });
});

describe("email-sandbox route — pseudo trial read uses trial pool", () => {
  it("getScopedCredits is called with 'trial' scope", () => {
    expect(emailSandboxSource).toMatch(/getScopedCredits\(\s*pseudoAddr,\s*["']trial["']\s*\)/);
  });
});

describe("dashboard — hydrates scoped state + uses hasPaid for paid scope", () => {
  it("Subscription interface declares trialQuotaBonus + paidQuotaBonus", () => {
    expect(dashboardSource).toMatch(/trialQuotaBonus\?:\s*number/);
    expect(dashboardSource).toMatch(/paidQuotaBonus\?:\s*number/);
  });

  it("state hydration reads provData.trialCredits / paidCredits / amountUSD", () => {
    expect(dashboardSource).toMatch(/trialQuotaBonus:\s*provData\.trialCredits/);
    expect(dashboardSource).toMatch(/paidQuotaBonus:\s*provData\.paidCredits/);
    expect(dashboardSource).toMatch(/amountUSD:[\s\S]{0,80}?provData\.amountUSD/);
  });

  it("showPaidScope = hasPaid === true (Bug Fix 2 — not amountUSD > 0)", () => {
    expect(dashboardSource).toMatch(/showPaidScope\s*=\s*!trialViewActive\s*&&\s*hasPaid\s*===\s*true/);
  });

  it("trial credit derivation does NOT gate on plan === 'trial' once scoped mirrors exist", () => {
    // hasScopedMirrors short-circuits to trialPoolCredits — that's the
    // post-migration source of truth.
    expect(dashboardSource).toMatch(/hasScopedMirrors[\s\S]{0,80}?trialPoolCredits/);
  });

  it("baseCredits uses TRIAL_CREDITS in the trial view, plan quota in the paid view", () => {
    expect(dashboardSource).toMatch(
      /baseCredits\s*=\s*trialViewActive\s*\?\s*TRIAL_CREDITS\s*:\s*\(PLAN_QUOTA\[/,
    );
  });
});

describe("cron usage-alert — paid pool only", () => {
  it("reads getScopedCredits(_, 'paid') for the burn-down denominator", () => {
    expect(cronSource).toMatch(/getScopedCredits\(addr,\s*["']paid["']\)/);
  });

  it("denominator prefers sub.paidQuotaBonus, falls back to legacy quotaBonus", () => {
    expect(cronSource).toMatch(/sub\?\.paidQuotaBonus\s*\?\?\s*sub\?\.quotaBonus/);
  });
});

describe("topup endpoint — paid-pool math", () => {
  it("newTotal uses paidQuotaBonus first, falls back to legacy quotaBonus", () => {
    expect(topupSource).toMatch(/sub\.paidQuotaBonus\s*\?\?\s*sub\.quotaBonus/);
  });
});
