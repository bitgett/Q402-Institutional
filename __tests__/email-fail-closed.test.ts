/**
 * email-fail-closed.test.ts
 *
 * Production email signup/start must fail closed when the delivery
 * pipeline cannot send. Earlier revision only returned 502 when
 * RESEND_API_KEY was set AND the send failed — production deploys
 * that simply forgot to configure RESEND silently returned ok:true
 * and the user stared at "Check your inbox" forever.
 *
 * New semantics, locked here:
 *   production              + send failure (any cause)  → 502
 *   dev/preview + RESEND set + send failure             → 502
 *   dev/preview + RESEND unset                          → ok, devLink returned
 *
 * Source-grep only — the actual response behaviour is covered by the
 * route in its own happy-path tests; this file just keeps the policy
 * from drifting back to silent fail-open.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Normalize CRLF→LF so source-grep regexes are line-ending agnostic.
function readLF(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}
const ROOT = resolve(__dirname, "..");
const signupSrc = readLF(resolve(ROOT, "app", "api", "auth", "email", "signup", "route.ts"));
const startSrc  = readLF(resolve(ROOT, "app", "api", "auth", "email", "start",  "route.ts"));

function expectFailClosed(src: string, label: string) {
  // The guard MUST consider isProd OR resend-set — NOT just resend-set.
  // The exact phrasing is "isProd || process.env.RESEND_API_KEY".
  expect(src, `${label}: fail-closed guard must consider production env`).toMatch(
    /isProd\s*\|\|\s*process\.env\.RESEND_API_KEY/,
  );
  // Old shape (RESEND-only short-circuit) must not be the sole gate.
  // We tolerate the substring inside the new guard's body, but not as
  // the bare conditional that previously caused fail-open.
  expect(src, `${label}: old "RESEND-only" early-return must be gone`).not.toMatch(
    /if\s*\(\s*!sendResult\.ok\s*&&\s*process\.env\.RESEND_API_KEY\s*\)/,
  );
  expect(src, `${label}: 502 status on send failure`).toMatch(/status:\s*502/);
  expect(src, `${label}: EMAIL_SEND_FAILED error code surfaced`).toMatch(/EMAIL_SEND_FAILED/);
}

describe("email signup fails closed in production", () => {
  it("/api/auth/email/signup", () => expectFailClosed(signupSrc, "signup"));
  it("/api/auth/email/start",  () => expectFailClosed(startSrc,  "start"));
});
