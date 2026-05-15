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

describe("auth-client bindWallet helper", () => {
  it("exposes a tagged result type with WALLET_ALREADY_BOUND surfacing the bound address", () => {
    expect(authClientSource).toMatch(/code:\s*["']WALLET_ALREADY_BOUND["'];\s*boundAddress/);
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
