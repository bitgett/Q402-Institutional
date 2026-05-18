/**
 * APP_ORIGIN resolution for auth-bearing links (magic links, OAuth
 * callbacks, redirect URIs).
 *
 * Resolution order (first non-empty match wins):
 *   1. process.env.APP_ORIGIN          — explicit, recommended
 *   2. process.env.NEXT_PUBLIC_BASE_URL — legacy public env, already used
 *                                          elsewhere in the codebase
 *   3. ${req.proto}://${req.host}       — derived from the inbound request
 *                                          (only when `req` is passed)
 *   4. "https://q402.quackai.ai"        — last-resort canonical fallback
 *
 * Why the hierarchy:
 *   - Production should set APP_ORIGIN explicitly. With the env var in
 *     place, a misrouted or spoofed request can never survive into a
 *     magic-link email — the link is always built off the operator-
 *     controlled value.
 *   - Vercel **preview deploys** are the failure case the earlier "always
 *     canonical" fallback created: the sprint branch lives on a preview
 *     URL while production still serves main, so a magic link generated
 *     on the preview deploy was pointing users back to a production
 *     domain that doesn't have the email/callback route yet — 404.
 *     Passing `req` here lets the helper honour the deploy the user
 *     actually hit when no env override is configured.
 *   - Local dev (no env, no req) still gets a sane fallback (production
 *     canonical) instead of throwing.
 *
 * Callers in /api/auth/email/{start,signup,callback} now pass req so the
 * preview path resolves to the preview Host. Production sets APP_ORIGIN
 * in Vercel env so it can't drift to a Host-header-controlled value.
 */
import type { NextRequest } from "next/server";

export function getAppOrigin(req?: NextRequest): string {
  const fromEnv = process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (fromEnv && /^https?:\/\//.test(fromEnv)) {
    return fromEnv.replace(/\/+$/, "");
  }
  if (req) {
    const host  = req.headers.get("host");
    const proto =
      req.headers.get("x-forwarded-proto") ??
      (req.url.startsWith("https") ? "https" : "http");
    if (host) {
      // Strip any port if it slips through ":443" / ":80" — clean origins
      // only. Numeric ports stay (e.g. "localhost:3000" for dev).
      return `${proto}://${host}`.replace(/:443$|:80$/, "");
    }
  }
  return "https://q402.quackai.ai";
}
