/**
 * relay-ordering.test.ts — Q402-SEC-001 + Q402-SEC-002 regression guard.
 *
 * Q402-SEC-001: quota and daily-cap must not be charged before we know the
 *   relay is actually possible (supported chain, authorization lock, gas tank
 *   funded, relayer key loadable). Previously `loadRelayerKey()` fired AFTER
 *   `decrementCredit()`, so a misconfigured RELAYER_PRIVATE_KEY silently
 *   drained every caller's quota on 503 return.
 *
 * Q402-SEC-002: sandbox relays fabricate txHash + blockNumber. Dispatching a
 *   HMAC-signed `relay.success` webhook for sandbox traffic lets a caller with
 *   a sandbox key forge a signature-valid "settlement" event. Webhook dispatch
 *   must be live-only.
 *
 * These are source-grep tests so the fix can't be reverted without the suite
 * failing. If the route is refactored, update the landmark comments, not the
 * ordering invariants themselves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
  "utf8"
);

function indexOf(pattern: RegExp, label: string): number {
  const m = routeSource.match(pattern);
  if (!m || m.index === undefined) {
    throw new Error(`ordering landmark not found: ${label} (pattern ${pattern})`);
  }
  return m.index;
}

describe("Q402-SEC-001 — relay must not charge before viability is known", () => {
  const CHAIN_CFG_CHECK   = /const chainCfg = CHAIN_CONFIG\[chain\];/;
  const AUTH_LOCK_GUARD   = /authorization\.address must be the official Q402/;
  const GAS_TANK_GUARD    = /Insufficient gas tank on \$\{chain\}/;
  const LOAD_RELAYER_KEY  = /const key = loadRelayerKey\(\);/;
  const DAILY_CAP_RL      = /rateLimit\(dailyCapKey, "daily", dailyCap, 86400, false\)/;
  const DECREMENT_CREDIT  = /const dec = await decrementCredit\(keyRecord\.address\);/;
  const RELAY_CALLS       = /await settlePayment\b|await settlePaymentXLayerEIP7702\b|await settlePaymentEIP3009\b/;

  it("validates CHAIN_CONFIG before charging the daily cap", () => {
    expect(indexOf(CHAIN_CFG_CHECK, "chainCfg")).toBeLessThan(indexOf(DAILY_CAP_RL, "daily cap"));
  });

  it("enforces the authorization impl lock before charging the daily cap", () => {
    expect(indexOf(AUTH_LOCK_GUARD, "auth lock")).toBeLessThan(indexOf(DAILY_CAP_RL, "daily cap"));
  });

  it("verifies gas tank funding before charging the daily cap", () => {
    expect(indexOf(GAS_TANK_GUARD, "gas tank")).toBeLessThan(indexOf(DAILY_CAP_RL, "daily cap"));
  });

  it("confirms loadRelayerKey() succeeds before charging the daily cap", () => {
    // This is the heart of Q402-SEC-001: a misconfigured RELAYER_PRIVATE_KEY
    // used to 503 after the credit decrement, silently burning quota.
    expect(indexOf(LOAD_RELAYER_KEY, "loadRelayerKey")).toBeLessThan(indexOf(DAILY_CAP_RL, "daily cap"));
  });

  it("confirms loadRelayerKey() succeeds before decrementing credits", () => {
    expect(indexOf(LOAD_RELAYER_KEY, "loadRelayerKey")).toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
  });

  it("charges the daily cap before the credit decrement (so refund path works)", () => {
    // Retained invariant: when credit underflow occurs, daily-cap refund is
    // issued. Requires cap-before-credit ordering.
    expect(indexOf(DAILY_CAP_RL, "daily cap")).toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
  });

  it("reserves credits before calling any settle* relay function", () => {
    expect(indexOf(DECREMENT_CREDIT, "decrement")).toBeLessThan(indexOf(RELAY_CALLS, "relay"));
  });
});

describe("Q402-SEC-002 — webhook dispatch is live-only", () => {
  it("guards getWebhookConfig with !isSandbox so sandbox never reads webhook config", () => {
    // Single source of truth for the sandbox guard: the ternary around
    // getWebhookConfig. If this regresses to an unguarded call, the test fails.
    expect(routeSource).toMatch(/webhookCfg\s*=\s*isSandbox\s*\?\s*null\s*:\s*await\s+getWebhookConfig/);
  });

  it("does not short-circuit sandbox into the webhook dispatch branch", () => {
    // Defense-in-depth: the `sandbox 포함` phrasing from the previous version
    // must be gone. A reviewer scanning the route shouldn't see a comment
    // suggesting sandbox webhook delivery is intended.
    expect(routeSource).not.toMatch(/sandbox 포함/);
    expect(routeSource).toMatch(/LIVE only|live[- ]only|Q402-SEC-002/i);
  });
});
