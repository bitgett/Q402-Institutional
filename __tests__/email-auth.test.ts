/**
 * email-auth.test.ts
 *
 * Source-level coverage for the email + Google OAuth signup paths added
 * alongside the BNB-focus sprint. The session/auth flow is wallet-free for
 * sign-in, so the regression we worry about is "someone weakens the
 * verification path and accepts a forged token". Each assertion locks down
 * the security-relevant gates so a refactor can't quietly drop them.
 *
 * Five surfaces:
 *   1. session.ts             — cookie name + HttpOnly + 30d TTL + KV-backed
 *   2. google-auth.ts         — aud / iss / email_verified / exp checks
 *   3. /api/auth/google       — verify → ensure pseudo-addr + sandbox key
 *   4. /api/auth/email/signup — rate limit per-IP + per-email
 *   5. /api/auth/email/callback — dual-mode (pair vs signup) + cookie set
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const sessionSource = readFileSync(resolve(ROOT, "app", "lib", "session.ts"), "utf8");
const googleAuthSource = readFileSync(resolve(ROOT, "app", "lib", "google-auth.ts"), "utf8");
const googleRouteSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "google", "route.ts"),
  "utf8",
);
const emailSignupSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "email", "signup", "route.ts"),
  "utf8",
);
const emailCallbackSource = readFileSync(
  resolve(ROOT, "app", "api", "auth", "email", "callback", "route.ts"),
  "utf8",
);
const emailSandboxSource = readFileSync(
  resolve(ROOT, "app", "api", "keys", "email-sandbox", "route.ts"),
  "utf8",
);

describe("session.ts — cookie + KV invariants", () => {
  it("cookie name is q402_sid (frozen wire constant)", () => {
    expect(sessionSource).toMatch(/SESSION_COOKIE\s*=\s*["']q402_sid["']/);
  });

  it("session TTL is 30 days (matches paid + trial subscription window)", () => {
    expect(sessionSource).toMatch(/SESSION_TTL_SEC\s*=\s*30\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
  });

  it("attachSessionCookie sets HttpOnly + Secure-in-prod + SameSite=lax", () => {
    expect(sessionSource).toMatch(/httpOnly:\s*true/);
    expect(sessionSource).toMatch(/secure:\s*process\.env\.NODE_ENV\s*===\s*["']production["']/);
    expect(sessionSource).toMatch(/sameSite:\s*["']lax["']/);
  });

  it("createSession uses 32-byte random ids and sets KV TTL", () => {
    expect(sessionSource).toMatch(/randomBytes\(\s*32\s*\)\.toString\(["']hex["']\)/);
    expect(sessionSource).toMatch(/ex:\s*SESSION_TTL_SEC/);
  });

  it("getSession rejects malformed cookie values before any KV read", () => {
    expect(sessionSource).toMatch(/\/\^\[0-9a-f\]\{64\}\$\/\.test\(sid\)/);
  });
});

describe("google-auth.ts — ID token verification gates", () => {
  it("verifies via Google's tokeninfo endpoint (zero-dep path)", () => {
    expect(googleAuthSource).toMatch(/TOKENINFO_URL\s*=\s*["']https:\/\/oauth2\.googleapis\.com\/tokeninfo["']/);
  });

  it("requires GOOGLE_CLIENT_ID env to be set", () => {
    expect(googleAuthSource).toMatch(/process\.env\.GOOGLE_CLIENT_ID/);
  });

  it("rejects when aud does not match the configured client id", () => {
    expect(googleAuthSource).toMatch(
      /payload\.aud\s*!==\s*clientId[\s\S]*?Token audience does not match/,
    );
  });

  it("validates iss is accounts.google.com (or https variant)", () => {
    expect(googleAuthSource).toMatch(/payload\.iss\s*!==\s*["']accounts\.google\.com["']/);
    expect(googleAuthSource).toMatch(/payload\.iss\s*!==\s*["']https:\/\/accounts\.google\.com["']/);
  });

  it("rejects when email_verified is not true/\"true\"", () => {
    expect(googleAuthSource).toMatch(
      /email_verified\s*===\s*true\s*\|\|\s*payload\.email_verified\s*===\s*["']true["']/,
    );
  });

  it("rejects expired tokens (exp claim)", () => {
    expect(googleAuthSource).toMatch(/Token has expired/);
  });

  it("has a 5-second AbortSignal timeout so a hung Google endpoint doesn't block the request", () => {
    expect(googleAuthSource).toMatch(/AbortSignal\.timeout\(\s*5000\s*\)/);
  });
});

describe("/api/auth/google — signup ↔ session bridge", () => {
  it("rate-limits by IP (20 req / 60s)", () => {
    expect(googleRouteSource).toMatch(/rateLimit\(\s*ip,\s*["']auth-google["'],\s*20,\s*60\s*\)/);
  });

  it("verifies the ID token via verifyGoogleIdToken before any KV write", () => {
    const verifyIdx = googleRouteSource.indexOf("verifyGoogleIdToken(");
    const setSubIdx = googleRouteSource.indexOf("setSubscription(");
    expect(verifyIdx).toBeGreaterThan(0);
    expect(setSubIdx).toBeGreaterThan(verifyIdx);
  });

  it("creates a pseudo-address keyed by Google sub (stable across logins)", () => {
    expect(googleRouteSource).toMatch(/email:\$\{googleSub\}/);
  });

  it("generates a sandbox API key for first-time Google sign-ins", () => {
    expect(googleRouteSource).toMatch(/generateSandboxKey\(pseudoAddr,\s*["']starter["']\)/);
  });

  it("sets the session cookie via attachSessionCookie", () => {
    expect(googleRouteSource).toMatch(/attachSessionCookie\(resp,\s*sid\)/);
  });
});

describe("/api/auth/email/signup — magic-link send", () => {
  it("validates email shape + length before issuing token", () => {
    expect(emailSignupSource).toMatch(/code:\s*["']INVALID_EMAIL["']/);
    expect(emailSignupSource).toMatch(/email\.length\s*>\s*254/);
  });

  it("rate-limits per-IP (5 / 60s) AND per-email (3 / 600s)", () => {
    expect(emailSignupSource).toMatch(/rateLimit\(\s*ip,\s*["']email-signup["'],\s*5,\s*60\s*\)/);
    expect(emailSignupSource).toMatch(
      /rateLimit\(\s*email,\s*["']email-signup-per-email["'],\s*3,\s*600\s*\)/,
    );
  });

  it("stores token payload with mode: \"signup\" so callback knows it's email-only", () => {
    expect(emailSignupSource).toMatch(/mode:\s*["']signup["']/);
  });

  it("returns devLink only when RESEND_API_KEY is unset AND NODE_ENV !== production", () => {
    expect(emailSignupSource).toMatch(
      /process\.env\.NODE_ENV\s*!==\s*["']production["'][\s\S]*?!process\.env\.RESEND_API_KEY/,
    );
  });
});

describe("/api/auth/email/callback — dual-mode handling", () => {
  it("branches on payload.mode === \"signup\" (email-only) vs default (wallet-paired)", () => {
    expect(emailCallbackSource).toMatch(/mode\s*===\s*["']signup["']/);
    expect(emailCallbackSource).toMatch(/isEmailOnly/);
  });

  it("sets a session cookie in BOTH modes (signup and pair)", () => {
    // We expect attachSessionCookie called at least twice — one per branch.
    const matches = emailCallbackSource.match(/attachSessionCookie\(/g);
    expect(matches, "callback should set cookie in both code paths").not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("redirects with status 302 (not 303 — keeps GET semantics for browser back button)", () => {
    expect(emailCallbackSource).toMatch(/NextResponse\.redirect\([^)]+,\s*302\s*\)/);
  });

  it("SET NX on consumed marker is BEFORE the token payload read (single-use guard)", () => {
    const consumedIdx = emailCallbackSource.indexOf("consumedKey(token)");
    const getPayloadIdx = emailCallbackSource.indexOf("tokenKvKey(token)");
    expect(consumedIdx).toBeGreaterThan(0);
    expect(getPayloadIdx).toBeGreaterThan(0);
    expect(consumedIdx).toBeLessThan(getPayloadIdx);
  });
});

describe("/api/keys/email-sandbox — session-gated sandbox key fetch", () => {
  it("requires a session cookie (no client-supplied email)", () => {
    expect(emailSandboxSource).toMatch(/getSession\(req\)/);
    expect(emailSandboxSource).toMatch(/Not signed in/);
  });

  it("falls back to deterministic pseudo-address when KV index is missing", () => {
    expect(emailSandboxSource).toMatch(/email:\$\{session\.email\}/);
  });

  it("generates a sandbox key if the account doesn't have one yet", () => {
    expect(emailSandboxSource).toMatch(/generateSandboxKey\(pseudoAddr,\s*["']starter["']\)/);
  });
});
