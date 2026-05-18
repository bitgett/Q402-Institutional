/**
 * wallet-bind.test.ts
 *
 * Phase 1 identity-model coverage for /api/auth/wallet-bind (see
 * docs/sprint-bnb-focus.md §10). The route was rewritten from a silent
 * unsigned hint into a high-risk gate, so the regression mode we worry
 * about is someone deleting the signature check or accidentally
 * re-allowing silent re-pair to a different wallet.
 *
 * Source-level grep — behavioural integration is out of scope here
 * (would need a live KV mock + ECDSA signer). The structural assertions
 * below are calibrated to detect the bad refactors that have shipped
 * elsewhere in the codebase: missing requireFreshAuth, silent overwrite
 * of session.address, missing 409 on mismatch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const bindSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "wallet-bind", "route.ts"),
  "utf8",
);
const meSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "me", "route.ts"),
  "utf8",
);
const authClientSource = readFileSync(
  resolve(ROOT, "app", "lib", "auth-client.ts"),
  "utf8",
);
const sessionSource = readFileSync(
  resolve(ROOT, "app", "lib", "session.ts"),
  "utf8",
);

describe("/api/auth/wallet-bind — signed bind gate", () => {
  it("requires fresh challenge + signature (not just body.address)", () => {
    // The legacy v0 of this route trusted body.address verbatim because
    // wallet connection alone was assumed to prove control. Phase 1 lifts
    // bind from "hint" to "irrevocable identity claim" — must verify.
    expect(bindSource).toMatch(/requireFreshAuth\(\s*body\.address.*body\.challenge.*body\.signature/s);
  });

  it("never calls pairSessionWithWallet before requireFreshAuth resolves", () => {
    // Ordering matters: write-after-verify, never the inverse. Look at
    // call-sites (the parenthesised invocations) — the import line at the
    // top of the file lists both symbols and isn't a meaningful order.
    const reqCallIdx = bindSource.indexOf("requireFreshAuth(");
    const pairCallIdx = bindSource.indexOf("pairSessionWithWallet(");
    expect(reqCallIdx).toBeGreaterThan(0);
    expect(pairCallIdx).toBeGreaterThan(0);
    expect(reqCallIdx).toBeLessThan(pairCallIdx);
  });

  it("returns 409 WALLET_ALREADY_BOUND when session has a different bound wallet", () => {
    expect(bindSource).toMatch(/code:\s*["']WALLET_ALREADY_BOUND["']/);
    expect(bindSource).toMatch(/status:\s*409/);
    // Surface the existing bound address so the client can render the
    // hard-block screen with the correct identity comparison.
    expect(bindSource).toMatch(/boundAddress:\s*session\.address/);
  });

  it("never silently overwrites session.address — mismatch path returns 409 instead of pairing", () => {
    // Regression catch: a refactor that removes the if/return and
    // just calls pairSessionWithWallet unconditionally must fail this.
    const mismatchBlock = bindSource.match(
      /session\.address\s*!==\s*verifiedAddr[\s\S]+?\}\s*,\s*\{\s*status:\s*409/,
    );
    expect(mismatchBlock).toBeTruthy();
  });

  it("treats same-address re-bind as idempotent (200 ok, no re-sign loop)", () => {
    // A page refresh while bound shouldn't force the user to sign again.
    expect(bindSource).toMatch(/idempotent:\s*true/);
    expect(bindSource).toMatch(/session\.address\s*===\s*verifiedAddr/);
  });

  it("rejects requests without a session cookie (401)", () => {
    expect(bindSource).toMatch(/Not signed in/);
    expect(bindSource).toMatch(/status:\s*401/);
  });

  it("rate limits at the IP layer (10 req / 60s)", () => {
    expect(bindSource).toMatch(/rateLimit\(ip,\s*["']wallet-bind["']/);
  });
});

describe("/api/auth/me — bind state exposed to client", () => {
  it("surfaces boundAddress (explicit) alongside the legacy address alias", () => {
    expect(meSource).toMatch(/boundAddress/);
    expect(meSource).toMatch(/address:\s*boundAddress/);
  });

  it("derives bindState as 'bound' | 'unbound' from session.address", () => {
    expect(meSource).toMatch(/bindState:\s*boundAddress\s*\?\s*["']bound["']\s*:\s*["']unbound["']/);
  });
});

describe("wallet-bind — global 1:1 uniqueness (cross-session)", () => {
  // Phase 1 closed per-session bind-once (same session can't switch wallet).
  // These tests cover the cross-session attacks/mistakes that needed the
  // wallet_email_link + email_to_wallet reverse indexes to actually
  // enforce a 1:1 contract.

  it("reads BOTH global indexes before committing the bind", () => {
    // Two-direction check — wallet→email AND email→wallet. Either alone
    // leaves a hole: missing wallet→email lets two emails bind the same
    // wallet; missing email→wallet lets one email re-bind after logout
    // to a different wallet (fresh sessions reset session.address).
    expect(bindSource).toMatch(/walletEmailLinkKey\(verifiedAddr\)/);
    expect(bindSource).toMatch(/emailToWalletKey\(/);
    // Reads happen up front (Promise.all) so the policy decision uses a
    // consistent KV snapshot rather than racing in between writes.
    expect(bindSource).toMatch(
      /Promise\.all\(\[[\s\S]+?walletEmailLinkKey\(verifiedAddr\)[\s\S]+?emailToWalletKey\(/,
    );
  });

  it("returns 409 WALLET_TAKEN when this wallet is claimed by a different email", () => {
    expect(bindSource).toMatch(/code:\s*["']WALLET_TAKEN["']/);
    // The check is "existing wallet→email entry differs from this session's email".
    expect(bindSource).toMatch(
      /existingEmailLc\s*&&\s*existingEmailLc\s*!==\s*emailLc/,
    );
  });

  it("does NOT leak the bound email in the WALLET_TAKEN response", () => {
    // Surfacing the colliding email would be a free email-existence
    // oracle for an attacker who controls a wallet — keep the response
    // information-light. The owner can recover via support; the prompt
    // says "linked to a different Q402 account" without naming it.
    //
    // Narrow the regex to JUST the NextResponse.json object literal
    // for the WALLET_TAKEN code so we don't false-trip on surrounding
    // comments / variable names.
    const takenResponse = bindSource.match(
      /NextResponse\.json\(\s*\{[^}]*code:\s*["']WALLET_TAKEN["'][^}]*\}/,
    );
    expect(takenResponse).toBeTruthy();
    expect(takenResponse![0]).not.toMatch(/existingEmailLc/);
    expect(takenResponse![0]).not.toMatch(/session\.email/);
    expect(takenResponse![0]).not.toMatch(/email:/);
  });

  it("returns 409 EMAIL_ALREADY_BOUND when this email already claimed a different wallet (cross-session)", () => {
    expect(bindSource).toMatch(/code:\s*["']EMAIL_ALREADY_BOUND["']/);
    expect(bindSource).toMatch(
      /existingWalletLc\s*&&\s*existingWalletLc\s*!==\s*verifiedAddr/,
    );
    // Echo back the bound wallet so the dashboard can render "switch your
    // wallet extension to 0x...X".
    expect(bindSource).toMatch(/boundAddress:\s*existingWalletLc/);
  });

  it("idempotent re-bind accepts EITHER session.address match OR existing indexes match", () => {
    // Cross-session legitimate case: user signs out, signs back in with
    // the same email, reconnects the same wallet. session.address starts
    // null but BOTH indexes already point at this pair. Treat as
    // idempotent rather than rejecting with EMAIL_ALREADY_BOUND.
    expect(bindSource).toMatch(
      /session\.address\s*===\s*verifiedAddr\s*\|\|\s*\(\s*existingEmailLc\s*===\s*emailLc\s*&&\s*existingWalletLc\s*===\s*verifiedAddr/,
    );
  });

  it("writes BOTH indexes on successful first bind (not just one direction)", () => {
    // After bind success, both indexes get written so the next bind
    // attempt from any direction sees the claim. Missing either write
    // leaves a half-closed gate that future attempts can exploit.
    const writeBlock = bindSource.match(/Promise\.all\(\[[\s\S]+?walletEmailLinkKey[\s\S]+?emailToWalletKey[\s\S]+?\]\)/);
    expect(writeBlock).toBeTruthy();
  });
});

describe("auth-client bindWallet helper — full tagged result", () => {
  it("exposes a tagged result type with WALLET_ALREADY_BOUND surfacing the bound address", () => {
    expect(authClientSource).toMatch(/code:\s*["']WALLET_ALREADY_BOUND["'];\s*boundAddress/);
  });

  it("exposes WALLET_TAKEN (cross-email collision) without leaking the colliding email", () => {
    expect(authClientSource).toMatch(/code:\s*["']WALLET_TAKEN["']\s*\}/);
  });

  it("exposes EMAIL_ALREADY_BOUND (cross-session collision) with the bound wallet", () => {
    expect(authClientSource).toMatch(/code:\s*["']EMAIL_ALREADY_BOUND["'];\s*boundAddress/);
  });

  it("distinguishes SIGNATURE_CANCELLED / NETWORK / REJECTED so the UI doesn't lump failures", () => {
    expect(authClientSource).toMatch(/code:\s*["']SIGNATURE_CANCELLED["']/);
    expect(authClientSource).toMatch(/code:\s*["']NETWORK["']/);
    expect(authClientSource).toMatch(/code:\s*["']REJECTED["']/);
  });

  it("uses getFreshChallenge (high-risk path), not the cached session signature", () => {
    // Same rationale as the server-side requireFreshAuth assertion above.
    // Cached signatures must NEVER be reused to bind a wallet.
    const bindFn = authClientSource.match(/export async function bindWallet[\s\S]+?\n\}/);
    expect(bindFn).toBeTruthy();
    expect(bindFn![0]).toMatch(/getFreshChallenge/);
    expect(bindFn![0]).not.toMatch(/getAuthCreds/);
  });
});

describe("session.ts — canonical bound semantics documented", () => {
  it("doc explicitly names session.address as the canonical BOUND wallet", () => {
    expect(sessionSource).toMatch(/canonical\s+BOUND\s+wallet/i);
  });

  it("doc references the bind-once contract via /api/auth/wallet-bind", () => {
    expect(sessionSource).toMatch(/\/api\/auth\/wallet-bind/);
  });
});
