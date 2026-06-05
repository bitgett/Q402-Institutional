import { describe, it, expect } from "vitest";
import { friendlyError } from "@/app/lib/agentic-wallet-friendly-error";

describe("friendlyError", () => {
  it("maps SUBSCRIPTION_REQUIRED with /payment CTA", () => {
    const fe = friendlyError(402, { error: "SUBSCRIPTION_REQUIRED" });
    expect(fe.headline).toMatch(/Multichain subscription/);
    expect(fe.next?.href).toBe("/payment");
  });

  it("does NOT assume bare 402 is SUBSCRIPTION_REQUIRED (gas-tank empties + relay rejections also return 402)", () => {
    const fe = friendlyError(402, {});
    // No code, no message — falls to generic copy, NOT a misleading
    // "needs Multichain" banner. Regression guard for the case where a
    // paid Multichain user hits a 402 because their Gas Tank is empty.
    expect(fe.headline).not.toMatch(/Multichain subscription/);
  });

  it("maps TRIAL_BNB_ONLY with /payment CTA", () => {
    const fe = friendlyError(402, { error: "TRIAL_BNB_ONLY" });
    expect(fe.headline).toMatch(/Trial key only/);
    expect(fe.next?.href).toBe("/payment");
  });

  it("maps NO_API_KEY with /payment CTA", () => {
    const fe = friendlyError(402, { error: "NO_API_KEY" });
    expect(fe.headline).toMatch(/Activate a Q402/);
    expect(fe.next?.href).toBe("/payment");
  });

  it("maps the relay's free-form gas-tank exhaustion message", () => {
    const fe = friendlyError(402, { error: "Insufficient gas tank on eth. Deposit native tokens to your gas tank." });
    expect(fe.headline).toMatch(/Gas Tank is empty on eth/);
    expect(fe.headline).not.toMatch(/Multichain subscription/);
    expect(fe.next?.href).toBe("#gas-tank");
  });

  it("maps the relay's generic 400 to an Agent-Wallet-balance hint instead of a bare HTTP code", () => {
    const fe = friendlyError(400, { error: "Relay failed. Check your signature and parameters." });
    expect(fe.headline).toMatch(/0 balance/);
    expect(fe.headline).not.toMatch(/HTTP 400/);
  });

  it("surfaces a free-form backend error string as the headline when no specific branch matches", () => {
    const fe = friendlyError(400, { error: "some_backend_specific_error" });
    expect(fe.headline).toBe("some_backend_specific_error");
  });

  it("maps RELAYER_LOW to a clear infrastructure-refilling message", () => {
    const fe = friendlyError(503, { error: "RELAYER_LOW" });
    expect(fe.headline).toMatch(/refilling/);
    expect(fe.headline).toMatch(/quota and Gas Tank are untouched/);
    expect(fe.next).toBeUndefined();
  });

  it("maps DAILY_LIMIT_EXCEEDED and echoes the cap", () => {
    const fe = friendlyError(403, { error: "DAILY_LIMIT_EXCEEDED", limit: 500 });
    expect(fe.headline).toMatch(/\$500/);
    expect(fe.headline).toMatch(/00:00 UTC/);
    expect(fe.next?.href).toBe("#raise-limits");
  });

  it("maps PER_TX_LIMIT_EXCEEDED and echoes the cap", () => {
    const fe = friendlyError(403, { error: "PER_TX_LIMIT_EXCEEDED", limit: 200 });
    expect(fe.headline).toMatch(/per-tx cap of \$200/);
    expect(fe.next?.href).toBe("#raise-limits");
  });

  it("maps AGENTIC_WALLET_NOT_FOUND without a next action", () => {
    const fe = friendlyError(404, { error: "AGENTIC_WALLET_NOT_FOUND" });
    expect(fe.headline).toMatch(/not found/i);
    expect(fe.next).toBeUndefined();
  });

  it("maps archived wallet variants to the restore copy", () => {
    expect(friendlyError(403, { error: "AGENTIC_WALLET_ARCHIVED" }).headline).toMatch(/archived/);
    expect(friendlyError(403, { error: "WALLET_ARCHIVED" }).headline).toMatch(/archived/);
  });

  it("maps relay/keystore 503s to a friendly retry copy", () => {
    expect(friendlyError(503, { error: "relay_unavailable" }).headline).toMatch(/briefly offline/);
    expect(friendlyError(503, { error: "keystore_unavailable" }).headline).toMatch(/briefly offline/);
  });

  it("maps NONCE_EXPIRED to a re-sign copy", () => {
    expect(friendlyError(401, { error: "NONCE_EXPIRED" }).headline).toMatch(/session signature/i);
  });

  it("falls back to a generic 5xx copy when no code matches", () => {
    const fe = friendlyError(502, { error: "weird_backend_thing" });
    expect(fe.headline).toMatch(/our side/);
  });

  it("surfaces the backend message verbatim for unknown 4xx", () => {
    const fe = friendlyError(400, { message: "Custom human-readable explanation." });
    expect(fe.headline).toBe("Custom human-readable explanation.");
  });

  it("falls back to a default copy when both code and message are absent", () => {
    const fe = friendlyError(418, {});
    expect(fe.headline).toMatch(/HTTP 418/);
  });
});
