/**
 * agentic-wallet-routes-auth.test.ts
 *
 * Source-grep guard for the Agent Wallet HTTP surface. The behavioural
 * library tests (agentic-wallet.test.ts, agentic-keystore.test.ts) cover
 * the underlying state machine; this file pins the *route-shape*
 * invariants so a future refactor cannot quietly drop an auth check, let
 * a sandbox key pass through to a wallet read, or skip the rate limit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadRoute(...segments: string[]): string {
  return readFileSync(resolve(__dirname, "..", ...segments), "utf8");
}

const RESTORE_ROUTE   = loadRoute("app", "api", "wallet", "agentic", "restore",     "route.ts");
const SEND_ROUTE      = loadRoute("app", "api", "wallet", "agentic", "send",        "route.ts");
const INFO_BY_KEY     = loadRoute("app", "api", "wallet", "agentic", "info-by-key", "route.ts");
const BALANCE_ROUTE   = loadRoute("app", "api", "wallet", "agentic", "balance",     "route.ts");

describe("POST /api/wallet/agentic/restore — auth + grace handling", () => {
  it("requires the owner-sig path via requireAuth", () => {
    expect(RESTORE_ROUTE).toMatch(/requireAuth\s*\(/);
  });
  it("enforces a per-IP rate limit before doing work", () => {
    expect(RESTORE_ROUTE).toMatch(/rateLimit\(ip,\s*"agentic-wallet-restore"/);
  });
  it("calls restoreAgenticWallet only after auth resolves to a string", () => {
    const authIdx = RESTORE_ROUTE.search(/typeof result !== "string"/);
    const callIdx = RESTORE_ROUTE.search(/restoreAgenticWallet\(/);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(authIdx);
  });
  it("maps the lib's GRACE_EXPIRED throw to a 410 response", () => {
    expect(RESTORE_ROUTE).toMatch(/AGENTIC_WALLET_GRACE_EXPIRED/);
    expect(RESTORE_ROUTE).toMatch(/status:\s*410/);
  });
});

describe("POST /api/wallet/agentic/send — Mode A/B sig + Mode C apiKey paths", () => {
  it("accepts the owner-signature path via intent-bound challenge auth", () => {
    // Migrated from session-bound `requireAuth` to action-bound
    // `requireIntentAuth` so the signed bytes pin chain + token +
    // recipient + amount and the single-use challenge also acts as
    // the single-send idempotency guard.
    expect(SEND_ROUTE).toMatch(/requireIntentAuth/);
    expect(SEND_ROUTE).toMatch(/action:\s*"agentic\.send"/);
  });
  it("imports getApiKeyRecord for the Mode C path", () => {
    expect(SEND_ROUTE).toMatch(/getApiKeyRecord/);
  });
  it("rejects sandbox apiKeys with SANDBOX_KEY_REJECTED", () => {
    expect(SEND_ROUTE).toMatch(/SANDBOX_KEY_REJECTED/);
    expect(SEND_ROUTE).toMatch(/q402_test_/);
  });
  it("rejects an inactive or unknown apiKey", () => {
    expect(SEND_ROUTE).toMatch(/INVALID_API_KEY/);
  });
  it("verifies ownerAddress matches the apiKey record when both are provided", () => {
    expect(SEND_ROUTE).toMatch(/OWNER_MISMATCH/);
  });
  it("falls back to AUTH_REQUIRED when neither sig nor apiKey is present", () => {
    expect(SEND_ROUTE).toMatch(/AUTH_REQUIRED/);
  });
  it("still enforces multichain scope on non-BNB chains", () => {
    expect(SEND_ROUTE).toMatch(/hasMultichainScope/);
    expect(SEND_ROUTE).toMatch(/SUBSCRIPTION_REQUIRED/);
  });
  it("still atomically reserves daily-cap budget + refunds on failure", () => {
    expect(SEND_ROUTE).toMatch(/chargeAgainstDailyLimit/);
    expect(SEND_ROUTE).toMatch(/refundDailySpend/);
  });
});

describe("POST /api/wallet/agentic/info-by-key — apiKey-auth read endpoint", () => {
  it("requires an apiKey in the body", () => {
    expect(INFO_BY_KEY).toMatch(/API_KEY_REQUIRED/);
  });
  it("rejects sandbox apiKeys up front", () => {
    expect(INFO_BY_KEY).toMatch(/SANDBOX_KEY_REJECTED/);
  });
  it("rejects an inactive or unknown apiKey", () => {
    expect(INFO_BY_KEY).toMatch(/INVALID_API_KEY/);
  });
  it("returns the public wallet shape, not the encrypted private key", () => {
    expect(INFO_BY_KEY).not.toMatch(/encryptedPK/);
    expect(INFO_BY_KEY).toMatch(/dailyLimitUsd/);
    expect(INFO_BY_KEY).toMatch(/perTxMaxUsd/);
  });

  it("masks the owner EOA — only the short form leaves the server", () => {
    // An apiKey leak should not directly enumerate the wallet's owner
    // EOA. The full address resolves on the route side; only the
    // 6+4 mask is wired into the response shape.
    expect(INFO_BY_KEY).toMatch(/ownerAddrShort/);
    expect(INFO_BY_KEY).not.toMatch(/ownerAddr:\s*wallet\.ownerAddr/);
  });
  it("never accepts a signature — that's the whole point of this endpoint", () => {
    expect(INFO_BY_KEY).not.toMatch(/requireAuth/);
  });
});

describe("GET /api/wallet/agentic/balance — owner-sig + KV cache", () => {
  it("requires the owner-sig path via requireAuth", () => {
    expect(BALANCE_ROUTE).toMatch(/requireAuth\s*\(/);
  });
  it("caches the snapshot in KV with a 5-minute TTL", () => {
    expect(BALANCE_ROUTE).toMatch(/CACHE_TTL_SEC\s*=\s*5\s*\*\s*60/);
  });
  it("calls fetchAgenticBalances for the live read", () => {
    expect(BALANCE_ROUTE).toMatch(/fetchAgenticBalances/);
  });
  it("rate-limits per IP at the standard 30/min cadence", () => {
    expect(BALANCE_ROUTE).toMatch(/rateLimit\(ip,\s*"agentic-wallet-balance",\s*30,\s*60\)/);
  });
});
