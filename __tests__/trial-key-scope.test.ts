/**
 * trial-key-scope.test.ts
 *
 * Phase 1 + trial/paid key separation regression coverage.
 *
 * The bug this catches: when Phase 1 split trial keys into their own
 * `subscription.trialApiKey` / `trialSandboxApiKey` slots, /api/relay and
 * /api/keys/verify's "is this the current key for this subscription?"
 * check still ONLY compared against the paid slots (subscription.apiKey
 * + sandboxApiKey). Every fresh email/Google trial signup ended up with
 * a key the relay rejected as "rotated" — breaking the trial → relay
 * happy path entirely.
 *
 * These tests assert the scope-aware shape of the gate so the
 * regression can't ship silently again:
 *   1. isCurrentKey includes all four slots
 *   2. trial vs paid expiry is scoped to the KEY's plan, not the
 *      subscription's current plan (so a paid user's old trial key
 *      still hits trial-expiry, not paid-expiry semantics)
 *   3. BNB-only enforcement is scoped to the KEY's plan as well
 *   4. trialMeta surfacing on /api/keys/verify uses the key scope
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const relaySource = readFileSync(
  resolve(ROOT, "app", "api", "relay", "route.ts"),
  "utf8",
);
const verifySource = readFileSync(
  resolve(ROOT, "app", "api", "keys", "verify", "route.ts"),
  "utf8",
);

describe("/api/relay — trial keys recognised as current keys", () => {
  it("isCurrentKey accepts paid AND trial slots (all four)", () => {
    // Regression catch: the gate must check trialApiKey + trialSandboxApiKey
    // alongside the legacy paid slots. Missing either trial slot means
    // every fresh email-signup user gets a 401 "rotated" on every relay.
    const block = relaySource.match(/isCurrentKey\s*=[\s\S]+?if\s*\(\s*!isCurrentKey/);
    expect(block).toBeTruthy();
    const checks = block![0];
    expect(checks).toMatch(/subscription\.apiKey\s*===\s*apiKey/);
    expect(checks).toMatch(/subscription\.sandboxApiKey\s*===\s*apiKey/);
    expect(checks).toMatch(/subscription\.trialApiKey\s*===\s*apiKey/);
    expect(checks).toMatch(/subscription\.trialSandboxApiKey\s*===\s*apiKey/);
  });

  it("trial-vs-paid scope is determined by keyRecord.plan, not subscription.plan", () => {
    // A paid user with a legacy active trial key must hit trial gates
    // on that key — using subscription.plan would lump it into paid
    // semantics because the sub upgraded to "starter"/etc.
    expect(relaySource).toMatch(/isTrialScopedKey\s*=\s*keyRecord\.plan\s*===\s*["']trial["']/);
  });

  it("paid expiry skips trial-scoped keys (no paid-expiry on trial keys)", () => {
    expect(relaySource).toMatch(/!isSandbox\s*&&\s*!isTrialScopedKey\s*&&\s*isPaidAccount/);
  });

  it("trial expiry fires for trial-scoped keys (not gated on subscription.plan)", () => {
    expect(relaySource).toMatch(/!isSandbox\s*&&\s*isTrialScopedKey[\s\S]+?trialExpiresAt/);
  });

  it("BNB-only enforcement is scoped to the KEY, not the subscription plan", () => {
    expect(relaySource).toMatch(
      /!isSandbox\s*&&\s*isTrialScopedKey\s*&&\s*chain\s*!==\s*["']bnb["']/,
    );
    expect(relaySource).toMatch(/TRIAL_BNB_ONLY/);
  });

  it("isActiveTrial (gas-tank skip) uses isTrialScopedKey", () => {
    expect(relaySource).toMatch(
      /isActiveTrial\s*=\s*\n?\s*isTrialScopedKey\s*&&[\s\S]+?subscription\?\.trialExpiresAt/,
    );
  });

  it("the legacy 'subscription.plan === \"trial\"' gates are gone (replaced by key-scope)", () => {
    expect(relaySource).not.toMatch(/subscription\?\.\bplan\s*===\s*["']trial["']/);
    expect(relaySource).not.toMatch(/subscription\.\bplan\s*===\s*["']trial["']/);
  });
});

describe("/api/keys/verify — trial keys verified correctly", () => {
  it("isCurrentKey accepts trial slots alongside paid slots", () => {
    const block = verifySource.match(/isCurrentKey\s*=[\s\S]+?if\s*\(\s*!isCurrentKey/);
    expect(block).toBeTruthy();
    const checks = block![0];
    expect(checks).toMatch(/subscription\.trialApiKey\s*===\s*apiKey/);
    expect(checks).toMatch(/subscription\.trialSandboxApiKey\s*===\s*apiKey/);
  });

  it("trial-vs-paid scope is determined by record.plan", () => {
    expect(verifySource).toMatch(/isTrialScopedKey\s*=\s*record\.plan\s*===\s*["']trial["']/);
  });

  it("paid expiry gate excludes trial-scoped keys", () => {
    expect(verifySource).toMatch(/!isSandboxKey\s*&&\s*!isTrialScopedKey\s*&&\s*isPaidAccount/);
  });

  it("trial expiry gate fires on key scope, not subscription plan", () => {
    expect(verifySource).toMatch(/!isSandboxKey\s*&&\s*isTrialScopedKey[\s\S]+?trialExpiresAt/);
  });

  it("trialMeta (q402_balance hint) is keyed on record.plan", () => {
    expect(verifySource).toMatch(/record\.plan\s*===\s*["']trial["'][\s\S]+?isTrial:\s*true/);
  });
});

describe("scope determination — trial vs paid is per-key, not per-subscription", () => {
  it("relay never falls back to subscription.plan for gating decisions", () => {
    // subscription.plan still exists as a field but should not appear in
    // any gate condition. Use keyRecord.plan via isTrialScopedKey.
    const gateConditions = relaySource.match(/!isSandbox[\s\S]+?subscription/g) ?? [];
    for (const cond of gateConditions) {
      // None of the gate conditions should compare subscription.plan
      // directly to "trial" — they should route via isTrialScopedKey.
      expect(cond).not.toMatch(/subscription\??\.plan\s*===\s*["']trial["']/);
    }
  });
});
