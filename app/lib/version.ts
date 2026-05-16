/**
 * Single source of truth for user-facing version strings.
 *
 * Bump these alongside `contracts.manifest.json`, `public/q402-sdk.js`,
 * and the published MCP package's `package.json`. The drift-guard tests
 * in __tests__/contracts-manifest.test.ts + mcp-package-drift.test.ts
 * catch the underlying chain/token registry getting out of sync; this
 * file catches the *labels* getting out of sync — the Hero header, the
 * /docs version badge, the /claude hero pill, README cover row, etc.
 *
 * Why a TypeScript module instead of inlined strings:
 *   Past release rounds (Mantle v1.18, the v1.23 hardening pass, RLUSD
 *   v1.27) each shipped with at least one screen still rendering the
 *   previous version. The pattern is always the same — a hand-written
 *   "v1.x.0" buried in a marketing component nobody grep'd. Forcing
 *   every surface to import from here means the next release is a
 *   one-line change.
 */

export const SDK_VERSION = "1.7.3-bnbfocus" as const;

/**
 * The npm-published @quackai/q402-mcp version. Kept in lockstep with
 * mcp-server/package.json + server.json + mcp-server/src/index.ts. The
 * mcp-package-drift test fetches the actual published version from
 * registry.npmjs.org, but UI labels reference *this* constant — so a
 * forgotten label after publish trips on screenshot review, not silently.
 */
export const MCP_VERSION = "0.3.12" as const;
