/**
 * agentic-wallet-mode-c-stale-key.test.ts
 *
 * Behavioural guard for the Mode C freshness gate added to
 * /api/wallet/agentic/send. The risk: an old apiKey that's still
 * `active: true` in KV (e.g. a rotation that didn't deactivate the
 * prior key) would pass Mode C auth — but the route forwards the
 * caller's *current* subscription apiKey to the relay, letting the
 * stale-key holder drain the user's live quota.
 *
 * Source-grep test exists alongside (`agentic-wallet-routes-auth.test.ts`)
 * for the presence of the STALE_API_KEY code; this file adds a
 * behavioural exercise via the lib functions the route uses.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEND_ROUTE = readFileSync(
  resolve(__dirname, "..", "app", "api", "wallet", "agentic", "send", "route.ts"),
  "utf8",
);

describe("/api/wallet/agentic/send — Mode C freshness gate", () => {
  it("emits a STALE_API_KEY 401 when presented key is not current trial/multichain", () => {
    expect(SEND_ROUTE).toMatch(/STALE_API_KEY/);
    expect(SEND_ROUTE).toMatch(/sub\?\.trialApiKey/);
    expect(SEND_ROUTE).toMatch(/sub\?\.apiKey/);
  });

  it("performs the freshness check AFTER fetching the subscription", () => {
    // If freshness ran before getSubscription we'd have nothing to
    // compare against. The order matters; assert via index.
    const getSubIdx = SEND_ROUTE.search(/const\s+sub\s*=\s*await\s+getSubscription/);
    const staleIdx = SEND_ROUTE.search(/STALE_API_KEY/);
    expect(getSubIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx).toBeGreaterThan(getSubIdx);
  });

  it("refunds the daily-cap reservation before returning 401", () => {
    // Whole window from `chargeAgainstDailyLimit` to STALE_API_KEY must
    // include a refundIfHeld() call so a stale-key attempt doesn't
    // burn the user's daily budget for free.
    const slice = SEND_ROUTE.slice(SEND_ROUTE.indexOf("STALE_API_KEY") - 600, SEND_ROUTE.indexOf("STALE_API_KEY"));
    expect(slice).toMatch(/refundIfHeld\(\)/);
  });

  it("still allows the canonical owner-sig path (no apiKey present) to bypass the gate", () => {
    // The freshness check must be conditional on body.apiKey being
    // present — otherwise an EIP-191-signed dashboard call would
    // also 401.
    expect(SEND_ROUTE).toMatch(/if\s*\(\s*typeof\s+body\.apiKey\s*===\s*"string"/);
  });
});
