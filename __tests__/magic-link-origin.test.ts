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

const ROOT = resolve(__dirname, "..");
const helperSrc      = readFileSync(resolve(ROOT, "app", "lib", "app-origin.ts"), "utf8");
const emailStartSrc  = readFileSync(resolve(ROOT, "app", "api", "auth", "email", "start", "route.ts"), "utf8");
const emailSignupSrc = readFileSync(resolve(ROOT, "app", "api", "auth", "email", "signup", "route.ts"), "utf8");
const emailCbSrc     = readFileSync(resolve(ROOT, "app", "api", "auth", "email", "callback", "route.ts"), "utf8");

describe("getAppOrigin canonical helper", () => {
  it("reads APP_ORIGIN env first, then NEXT_PUBLIC_BASE_URL, then production fallback", () => {
    expect(helperSrc).toMatch(/process\.env\.APP_ORIGIN\s*\?\?\s*process\.env\.NEXT_PUBLIC_BASE_URL/);
    expect(helperSrc).toMatch(/"https:\/\/q402\.quackai\.ai"/);
  });

  it("strips trailing slashes from env-provided origin", () => {
    expect(helperSrc).toMatch(/replace\(\/\\\/\+\$\/,\s*""\)/);
  });

  it("requires a scheme (http/https) on env values to avoid raw-host injection", () => {
    expect(helperSrc).toMatch(/\/\^https\?:\\\/\\\/\//);
  });
});

describe("magic-link routes use getAppOrigin (not Host header)", () => {
  it("/api/auth/email/start uses getAppOrigin for the magic link URL", () => {
    expect(emailStartSrc).toMatch(/getAppOrigin\(\)/);
    // And the old Host-header read is gone.
    expect(emailStartSrc).not.toMatch(/req\.headers\.get\(\s*["']host["']/);
    expect(emailStartSrc).not.toMatch(/x-forwarded-proto/);
  });

  it("/api/auth/email/signup uses getAppOrigin for the magic link URL", () => {
    expect(emailSignupSrc).toMatch(/getAppOrigin\(\)/);
    expect(emailSignupSrc).not.toMatch(/req\.headers\.get\(\s*["']host["']/);
    expect(emailSignupSrc).not.toMatch(/x-forwarded-proto/);
  });

  it("/api/auth/email/callback uses getAppOrigin for post-consume redirects", () => {
    expect(emailCbSrc).toMatch(/getAppOrigin\(\)/);
    expect(emailCbSrc).not.toMatch(/req\.headers\.get\(\s*["']host["']/);
    expect(emailCbSrc).not.toMatch(/x-forwarded-proto/);
  });
});
