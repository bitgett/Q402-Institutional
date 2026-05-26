import { describe, it, expect } from "vitest";
import { friendlyError } from "@/app/lib/agentic-wallet-friendly-error";

describe("friendlyError", () => {
  it("maps SUBSCRIPTION_REQUIRED with /payment CTA", () => {
    const fe = friendlyError(402, { error: "SUBSCRIPTION_REQUIRED" });
    expect(fe.headline).toMatch(/Multichain subscription/);
    expect(fe.next?.href).toBe("/payment");
  });

  it("treats bare 402 (no code) as SUBSCRIPTION_REQUIRED", () => {
    const fe = friendlyError(402, {});
    expect(fe.headline).toMatch(/Multichain subscription/);
    expect(fe.next?.label).toMatch(/plan/i);
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
