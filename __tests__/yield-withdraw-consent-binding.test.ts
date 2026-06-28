/**
 * yield-withdraw-consent-binding.test.ts
 *
 * Audit P1 (pre-launch blocker): the withdraw VENUE must be cryptographically bound
 * into the owner-signed intent, so a tampered/buggy body.protocol can't route a
 * user's "withdraw from Aave" approval to Lista (or vice versa) and still pass
 * signature verification. The server (execute.ts resolveOwner) and the dashboard
 * (AgenticWalletEarnSection) both add `protocol` to the intent when present;
 * buildIntentMessage sorts + serializes every intent field, so the venue is part of
 * the signed bytes. This pins that binding (and that it's OMITTED when absent, so
 * single-venue withdraws + deposits are unchanged).
 */
import { describe, it, expect } from "vitest";
import { buildIntentMessage } from "@/app/lib/auth";

describe("yield withdraw venue consent binding (protocol in signed intent)", () => {
  const base = { walletId: "0xabc", chain: "bnb", token: "USDT", amount: "100" };

  it("different venue => different signed bytes (a swapped protocol fails verification)", () => {
    const aave = buildIntentMessage("0xowner", "agentic.yield_withdraw", { ...base, protocol: "aave" }, "chal");
    const lista = buildIntentMessage("0xowner", "agentic.yield_withdraw", { ...base, protocol: "lista" }, "chal");
    expect(aave).not.toBe(lista);
    expect(aave).toContain("protocol: aave");
    expect(lista).toContain("protocol: lista");
  });

  it("omitted protocol => no protocol line (single-venue withdraw + deposit unaffected)", () => {
    const none = buildIntentMessage("0xowner", "agentic.yield_deposit", base, "chal");
    expect(none).not.toMatch(/protocol:/);
  });
});
