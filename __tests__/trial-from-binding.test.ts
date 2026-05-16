/**
 * trial-from-binding.test.ts
 *
 * Source-grep guards for the trial-scope `from`-wallet binding gate in
 * /api/relay. A leaked trial API key alone must not let an attacker burn
 * the legit owner's 2,000 sponsored TX credits by signing witnesses with
 * their own EOA.
 *
 * Rules (locked in source):
 *   - keyRecord.address is an EVM address          → from === keyRecord.address
 *   - keyRecord.address starts with "email:"
 *     AND subscription has bound wallet            → from === bound wallet
 *     AND no bound wallet (email-only signup)      → fall through (no anchor)
 *
 * Paid keys are intentionally out of scope here (their threat model + use
 * case differs and needs a separate product decision).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSrc = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
  "utf8",
);

describe("trial-scope from-wallet binding (/api/relay)", () => {
  it("declares the binding gate with TRIAL_FROM_NOT_BOUND error code", () => {
    expect(routeSrc).toMatch(/TRIAL_FROM_NOT_BOUND/);
  });

  it("EVM-owned trial key: enforces from === keyRecord.address", () => {
    // For non-email pseudo addresses, the gate is a direct equality check
    // on the lower-cased from vs keyRecord.address.
    expect(routeSrc).toMatch(/!isEmailPseudo/);
    expect(routeSrc).toMatch(/fromLc\s*!==\s*ownerAddrLc/);
  });

  it("email-pseudo trial key: enforces from === bound wallet (via email_to_wallet index)", () => {
    // The lookup must go through subscription.email + email_to_wallet, not
    // keyRecord.address — Google OAuth keys store the googleSub in the
    // pseudo, not the actual email.
    expect(routeSrc).toMatch(/email_to_wallet:\$\{subscription\.email\.toLowerCase\(\)\}/);
    expect(routeSrc).toMatch(/fromLc\s*!==\s*boundWallet\.toLowerCase\(\)/);
  });

  it("email-pseudo trial key WITHOUT bound wallet falls through (no anchor)", () => {
    // The gate is `if (boundWallet && fromLc !== ...)`. The `&& boundWallet`
    // short-circuit is what lets brand-new email-only signups still relay
    // before they ever connect a wallet.
    expect(routeSrc).toMatch(/boundWallet\s*&&\s*fromLc\s*!==\s*boundWallet\.toLowerCase\(\)/);
  });

  it("paid keys bypass the trial from-binding gate", () => {
    // The whole block is guarded by `if (!isSandbox && isTrialScopedKey)`.
    expect(routeSrc).toMatch(/if\s*\(\s*!isSandbox\s*&&\s*isTrialScopedKey\s*\)\s*\{[\s\S]*?TRIAL_FROM_NOT_BOUND/);
  });

  it("sandbox keys bypass", () => {
    // Same `!isSandbox` guard. Belt-and-suspenders assertion.
    expect(routeSrc).toMatch(/!isSandbox\s*&&\s*isTrialScopedKey/);
  });

  it("returns 403 on binding mismatch", () => {
    expect(routeSrc).toMatch(/TRIAL_FROM_NOT_BOUND[\s\S]*?status:\s*403/);
  });
});
