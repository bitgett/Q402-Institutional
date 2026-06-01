/**
 * agent-origin.ts — server-only origin derivation for the ERC-8004
 * registration flow.
 *
 * Why this file is separate from `agent-brand.ts`: this one imports a
 * type from `next/server`. Even with `import type` the file gets pulled
 * into the client bundle's module graph when imported transitively from
 * a `"use client"` component. Splitting keeps the brand-lock constants
 * fully framework-agnostic so the dashboard modal can import them
 * without dragging Next server types into the browser.
 */
import type { NextRequest } from "next/server";

/**
 * Origin derivation used by the agent-register flow. Deliberately
 * derived from the request host (NOT from APP_ORIGIN env) so the
 * client's `window.location.origin` always converges with the server's
 * notion of origin within the same browser session.
 *
 * Why not `getAppOrigin(req)`: that helper prioritises APP_ORIGIN env,
 * which canonicalises to `q402.quackai.ai` in prod. Users sometimes hit
 * preview deploys (q402-institutional.vercel.app), at which point the
 * canonical env value diverges from `window.location.origin` on the
 * client → metadata hash mismatch on prepare. Host-derived origin
 * removes that whole failure mode.
 */
export function originFromRequest(req: NextRequest): string {
  const host = req.headers.get("host");
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (req.url.startsWith("https") ? "https" : "http");
  if (!host) {
    // Defensive fallback — every real Vercel/edge request carries host.
    return "https://q402.quackai.ai";
  }
  return `${proto}://${host}`.replace(/:443$|:80$/, "");
}
