/**
 * magic-link-origin.test.ts
 *
 * Auth-bearing links (magic links, OAuth callbacks, post-consumption
 * redirects) must NOT trust the request's Host header. The canonical
 * APP_ORIGIN env var (with the production app URL as fallback) is the
 * single source of truth.
 *
 * A misrouted or spoofed Host that survives into an email link is a
 * phish vector — even on Vercel, where preview deploys and custom
 * domains all expose distinct hostnames.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Normalize CRLF→LF so source-grep regexes are line-ending agnostic.
// Without this, Windows fresh-clones (git default = CRLF) fail tests
// that pass on LF-checked-out repos.
function readLF(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}
const ROOT = resolve(__dirname, "..");
const helperSrc      = readLF(resolve(ROOT, "app", "lib", "app-origin.ts"));
const emailStartSrc  = readLF(resolve(ROOT, "app", "api", "auth", "email", "start", "route.ts"));
const emailSignupSrc = readLF(resolve(ROOT, "app", "api", "auth", "email", "signup", "route.ts"));
const emailCbSrc     = readLF(resolve(ROOT, "app", "api", "auth", "email", "callback", "route.ts"));

describe("getAppOrigin resolution helper", () => {
  it("reads APP_ORIGIN env first, then NEXT_PUBLIC_BASE_URL", () => {
    expect(helperSrc).toMatch(/process\.env\.APP_ORIGIN\s*\?\?\s*process\.env\.NEXT_PUBLIC_BASE_URL/);
  });

  it("falls back to the inbound request's origin when no env is set (preview-deploy safety)", () => {
    // Earlier revision hard-coded "https://q402.quackai.ai" as the no-env
    // fallback, which broke sprint preview deploys: magic links generated
    // on the preview pointed users at production, where the email/*
    // routes don't exist yet → 404. The req-derived fallback keeps the
    // preview self-contained.
    expect(helperSrc).toMatch(/if\s*\(\s*req\s*\)/);
    expect(helperSrc).toMatch(/req\.headers\.get\(\s*["']host["']\s*\)/);
    expect(helperSrc).toMatch(/req\.headers\.get\(\s*["']x-forwarded-proto["']\s*\)/);
  });

  it("keeps a hard-coded canonical fallback for the no-env no-req case (local dev safety)", () => {
    expect(helperSrc).toMatch(/"https:\/\/q402\.quackai\.ai"/);
  });

  it("strips trailing slashes from env-provided origin", () => {
    expect(helperSrc).toMatch(/replace\(\/\\\/\+\$\/,\s*""\)/);
  });

  it("requires a scheme (http/https) on env values to avoid raw-host injection", () => {
    expect(helperSrc).toMatch(/\/\^https\?:\\\/\\\/\//);
  });
});

describe("magic-link routes pass req to getAppOrigin", () => {
  // Routes must pass `req` so preview deploys without APP_ORIGIN env
  // resolve to their own host instead of hardcoded production. Direct
  // `req.headers.get("host")` reads in route bodies stay forbidden —
  // the helper is the single source of origin truth.

  it("/api/auth/email/start passes req to getAppOrigin", () => {
    expect(emailStartSrc).toMatch(/getAppOrigin\(\s*req\s*\)/);
    expect(emailStartSrc).not.toMatch(/req\.headers\.get\(\s*["']host["']/);
    expect(emailStartSrc).not.toMatch(/x-forwarded-proto/);
  });

  it("/api/auth/email/signup passes req to getAppOrigin", () => {
    expect(emailSignupSrc).toMatch(/getAppOrigin\(\s*req\s*\)/);
    expect(emailSignupSrc).not.toMatch(/req\.headers\.get\(\s*["']host["']/);
    expect(emailSignupSrc).not.toMatch(/x-forwarded-proto/);
  });

  it("/api/auth/email/callback passes req to getAppOrigin for post-consume redirects", () => {
    expect(emailCbSrc).toMatch(/getAppOrigin\(\s*req\s*\)/);
    expect(emailCbSrc).not.toMatch(/req\.headers\.get\(\s*["']host["']/);
    expect(emailCbSrc).not.toMatch(/x-forwarded-proto/);
  });
});
