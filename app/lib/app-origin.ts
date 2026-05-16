/**
 * Canonical APP_ORIGIN resolution for auth-bearing links (magic links,
 * OAuth callbacks, redirect URIs).
 *
 * Why a helper instead of `req.headers.get("host")`:
 *   - On Vercel a request can be served from the production domain, a
 *     preview deploy URL, a custom domain, or a load-balancer edge — the
 *     Host header reflects whichever entry point the request used. For
 *     content delivery that's fine; for security-bearing links (magic
 *     link emails, OAuth state, password reset) it is NOT — a misrouted
 *     or spoofed request can yield a link with an attacker-chosen host.
 *   - Pinning to APP_ORIGIN (set per-environment in Vercel) means the
 *     link the user clicks always lands on the canonical site, even if
 *     the request itself came in through a different hostname (preview
 *     deploy, CDN edge, etc).
 *
 * Resolution order:
 *   1. process.env.APP_ORIGIN     — explicit, recommended
 *   2. process.env.NEXT_PUBLIC_BASE_URL — legacy public env (already used
 *                                   elsewhere in the codebase)
 *   3. "https://q402.quackai.ai" — production fallback. Preview/local that
 *      don't set APP_ORIGIN still get a working canonical link, just to
 *      production. That's safer than letting an attacker-controlled host
 *      survive into an email.
 */
export function getAppOrigin(): string {
  const fromEnv = process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (fromEnv && /^https?:\/\//.test(fromEnv)) {
    return fromEnv.replace(/\/+$/, "");
  }
  return "https://q402.quackai.ai";
}
