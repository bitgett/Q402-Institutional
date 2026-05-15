/**
 * wallet-email-bridge.test.ts
 *
 * Phase 1.5 — read-side bridge between a bound wallet and its email
 * pseudo-account (see docs/sprint-bnb-focus.md §12). This is the
 * structural counterpart to Phase 2's full migration: it doesn't move
 * any data, but it surfaces the email pseudo's trial state into the
 * wallet's /api/keys/provision response so a wallet-only login can
 * still see the trial credits + keys the user got via email signup.
 *
 * The regression mode this catches: someone refactors the bridge into
 * a no-op (drops the kv.set on bind, drops the loadBoundEmailTrial
 * lookup on provision) and the wallet-only login silently loses
 * visibility of the trial again — exactly the bug we just shipped a
 * fix for. Source-grep level only; an integration test would need a
 * full KV mock + signed-bind ECDSA round-trip.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const bindSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "wallet-bind", "route.ts"),
  "utf8",
);
const trialActivateSource = readFileSync(
  resolve(ROOT, "app", "api", "trial", "activate", "route.ts"),
  "utf8",
);
const provisionSource = readFileSync(
  resolve(ROOT, "app", "api", "keys", "provision", "route.ts"),
  "utf8",
);
const dashboardSource = readFileSync(
  resolve(ROOT, "app", "dashboard", "page.tsx"),
  "utf8",
);

describe("wallet_email_link write — both bind paths populate the bridge", () => {
  it("/api/auth/wallet-bind writes wallet_email_link on successful bind", () => {
    // The bind path must write the reverse pointer AFTER
    // pairSessionWithWallet succeeds. Skipping this leaves the wallet-
    // only-login view permanently unable to find the email pseudo.
    expect(bindSource).toMatch(/walletEmailLinkKey\(verifiedAddr\)/);
    expect(bindSource).toMatch(/kv\.set\(\s*walletEmailLinkKey\(verifiedAddr\),\s*session\.email/);
    // Order matters: write the bridge AFTER bind succeeds, not before.
    const pairIdx = bindSource.indexOf("pairSessionWithWallet(");
    const bridgeIdx = bindSource.indexOf("walletEmailLinkKey(verifiedAddr)");
    expect(pairIdx).toBeGreaterThan(0);
    expect(bridgeIdx).toBeGreaterThan(0);
    expect(pairIdx).toBeLessThan(bridgeIdx);
  });

  it("/api/auth/wallet-bind uses a 10y TTL on the bridge (mirrors trial_used sentinels)", () => {
    expect(bindSource).toMatch(/WALLET_EMAIL_LINK_TTL\s*=\s*10\s*\*\s*365/);
  });

  it("/api/trial/activate also writes wallet_email_link when adopting an email session", () => {
    // Defence-in-depth: the trial-activate path also pairs the session
    // when an email is adopted. It should populate the same bridge so
    // the wallet-only login of that user can still see the trial.
    expect(trialActivateSource).toMatch(/wallet_email_link:\$\{addr\}/);
    expect(trialActivateSource).toMatch(/adoptedEmail/);
  });
});

describe("/api/keys/provision — bridge read into trial union", () => {
  it("defines loadBoundEmailTrial helper that resolves the pseudo via wallet_email_link", () => {
    expect(provisionSource).toMatch(/async function loadBoundEmailTrial/);
    expect(provisionSource).toMatch(/walletEmailLinkKey\(addr\)/);
    expect(provisionSource).toMatch(/emailToAddrKey\(linkedEmail\)/);
  });

  it("returns null on any drift (missing link, missing email_to_addr, missing pseudo sub)", () => {
    // Three null-return paths. Each protects the dashboard from
    // rendering empty/undefined trial state on bridge breakage.
    const fn = provisionSource.match(/async function loadBoundEmailTrial[\s\S]+?\n\}/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/if\s*\(\s*!linkedEmail\s*\)\s*return null/);
    expect(body).toMatch(/if\s*\(\s*!pseudoAddr\s*\)\s*return null/);
    expect(body).toMatch(/if\s*\(\s*!pseudoSub\s*\)\s*return null/);
  });

  it("provision response surfaces boundEmailTrial AND trialApiKey from the bridge", () => {
    expect(provisionSource).toMatch(/boundEmailTrial:/);
    // trialApiKey should fall back to the bridge when the wallet's own
    // trial slot is empty.
    expect(provisionSource).toMatch(/trialApiKey\s*\|\|\s*boundEmailTrial\?\.apiKey/);
  });

  it("isTrialActive reflects the bridge's trialExpiresAt when wallet sub has no own trial", () => {
    expect(provisionSource).toMatch(
      /isTrialActive[\s\S]+?boundEmailTrial[\s\S]+?trialExpiresAt[\s\S]+?>\s*new Date\(\)/,
    );
  });

  it("read-side only — no migration write inside loadBoundEmailTrial", () => {
    // Phase 1.5 must not delete or move the pseudo's data. Anyone
    // wanting that should target Phase 2's separate migration job.
    const fn = provisionSource.match(/async function loadBoundEmailTrial[\s\S]+?\n\}/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).not.toMatch(/kv\.del\(/);
    expect(body).not.toMatch(/kv\.set\(/);
    expect(body).not.toMatch(/setSubscription/);
  });
});

describe("dashboard — boundEmailTrial fallback consumed in trial scope", () => {
  it("declares the boundEmailTrial state and mirrors it from provision response", () => {
    expect(dashboardSource).toMatch(/const \[boundEmailTrial, setBoundEmailTrial\]/);
    expect(dashboardSource).toMatch(/provData\.boundEmailTrial/);
  });

  it("trialApiKey falls back to boundEmailTrial.apiKey when no own/email trial", () => {
    expect(dashboardSource).toMatch(/boundEmailTrial\?\.apiKey/);
  });

  it("trialCredits falls back to boundEmailTrial.credits (preserves 0 when no bridge)", () => {
    expect(dashboardSource).toMatch(/boundEmailTrial\?\.credits\s*\?\?\s*0/);
  });

  it("Transactions trial-scope filter includes bridged keys (history visibility)", () => {
    const keySetBlock = dashboardSource.match(/trialKeySet\s*=\s*new Set[\s\S]+?\]\.filter/);
    expect(keySetBlock).toBeTruthy();
    expect(keySetBlock![0]).toMatch(/boundEmailTrial\?\.apiKey/);
    expect(keySetBlock![0]).toMatch(/boundEmailTrial\?\.sandboxApiKey/);
  });

  it("auto-flip treats a bridged trial as an active-trial signal", () => {
    expect(dashboardSource).toMatch(/bridgedTrialSignal/);
    expect(dashboardSource).toMatch(/walletHasTrialSignal\s*\|\|\s*emailHasTrialSignal\s*\|\|\s*bridgedTrialSignal/);
  });

  it("days-left chip falls back to bridged expiry when own/email expiry is missing", () => {
    expect(dashboardSource).toMatch(/boundEmailTrial\?\.trialExpiresAt/);
  });
});
