/**
 * relay-ordering.test.ts — Q402-SEC-001 + Q402-SEC-002 regression guard.
 *
 * Q402-SEC-001: quota must not be decremented before we know the relay is
 *   actually possible (supported chain, authorization lock, gas tank funded,
 *   relayer key loadable). Previously `loadRelayerKey()` fired AFTER
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
  const DECREMENT_CREDIT  = /const dec = await decrementCredit\(keyRecord\.address\);/;
  const RELAY_CALLS       = /await settlePayment\b|await settlePaymentXLayerEIP7702\b|await settlePaymentEIP3009\b/;

  it("validates CHAIN_CONFIG before decrementing credits", () => {
    expect(indexOf(CHAIN_CFG_CHECK, "chainCfg")).toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
  });

  it("enforces the authorization impl lock before decrementing credits", () => {
    expect(indexOf(AUTH_LOCK_GUARD, "auth lock")).toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
  });

  it("verifies gas tank funding before decrementing credits", () => {
    expect(indexOf(GAS_TANK_GUARD, "gas tank")).toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
  });

  it("confirms loadRelayerKey() succeeds before decrementing credits", () => {
    // This is the heart of Q402-SEC-001: a misconfigured RELAYER_PRIVATE_KEY
    // used to 503 after the credit decrement, silently burning quota.
    expect(indexOf(LOAD_RELAYER_KEY, "loadRelayerKey")).toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
  });

  it("reserves credits before calling any settle* relay function", () => {
    expect(indexOf(DECREMENT_CREDIT, "decrement")).toBeLessThan(indexOf(RELAY_CALLS, "relay"));
  });
});

describe("Q402-SEC-001 follow-up — nonce parsing must precede credit decrement", () => {
  // The original Q402-SEC-001 fix moved relayer-key + gas-tank checks ahead of
  // decrementCredit, but BigInt(xlayerNonce!) / BigInt(stableNonce!) still ran
  // INSIDE the relay branch — after the decrement. A malformed nonce therefore
  // threw a SyntaxError that escaped the !result.success refund path, leaving
  // the credit burned. This guards the prevalidation that fixes that.
  const NONCE_PARSE_BLOCK = /parsedXLayerNonce\s*=\s*BigInt\(xlayerNonce!\)|parsedStableNonce\s*=\s*BigInt\(stableNonce!\)/;
  const DECREMENT_CREDIT  = /const dec = await decrementCredit\(keyRecord\.address\);/;

  it("pre-parses xlayer/stable nonces before the credit decrement", () => {
    const parseIdx = routeSource.search(NONCE_PARSE_BLOCK);
    const decIdx   = routeSource.search(DECREMENT_CREDIT);
    expect(parseIdx).toBeGreaterThanOrEqual(0);
    expect(decIdx).toBeGreaterThanOrEqual(0);
    expect(parseIdx).toBeLessThan(decIdx);
  });

  it("returns a 400 (not a thrown 500) on malformed nonce input", () => {
    // Catch-and-400 must wrap the up-front parse so a garbage nonce never
    // bubbles up as an unhandled exception that bypasses refund logic.
    expect(routeSource).toMatch(/} catch \{[\s\S]{0,200}must be a valid uint256[\s\S]{0,80}status: 400/);
  });
});

describe("Q402-SEC-002 — webhook dispatch is live-only", () => {
  it("guards getWebhookConfig with !isSandbox so sandbox never reads webhook config", () => {
    // Single source of truth for the sandbox guard: the ternary around
    // getWebhookConfig. If this regresses to an unguarded call, the test fails.
    expect(routeSource).toMatch(/webhookCfg\s*=\s*isSandbox\s*\?\s*null\s*:\s*await\s+getWebhookConfig/);
  });

  it("does not short-circuit sandbox into the webhook dispatch branch", () => {
    // Defense-in-depth: any phrasing hinting that sandbox calls emit webhooks
    // must be gone. A reviewer scanning the route shouldn't see a comment
    // suggesting sandbox webhook delivery is intended.
    expect(routeSource).not.toMatch(/sandbox\s+included|includes?\s+sandbox/i);
    expect(routeSource).toMatch(/LIVE only|live[- ]only|Q402-SEC-002/i);
  });
});
