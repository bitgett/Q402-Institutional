/**
 * feature-flags.ts
 *
 * Sprint-scoped feature flags. Build-time constants — reversibility is
 * provided by git (this file differs between `main` and
 * `feat/bnb-focus-sprint`) and Vercel can swap its production branch
 * between the two without a code revert.
 *
 * If you find yourself needing a runtime toggle, swap a constant for
 * `process.env.NEXT_PUBLIC_*` *but* keep the import surface identical
 * so callers don't have to change.
 */

/**
 * BNB-focus sprint (2026-05-13 → 2026-05-20).
 *
 * When true, the relay route, SDK, MCP server, and UI all collapse
 * Q402's supported surface down to **BNB Chain + USDC + USDT only**.
 * The other six chains (Ethereum, Avalanche, X Layer, Stable, Mantle,
 * Injective EVM) and RLUSD are explicitly rejected with a sprint-aware
 * error message — "BNB-focus sprint: this chain/token is temporarily
 * hidden, scheduled to return after the sprint." None of the
 * underlying code is removed; the original 7-chain matrix is one
 * branch swap away.
 *
 * Rationale: a focused message during a 1-week growth sprint that
 * leans into BNB Chain ecosystem / partnership / KR exchange
 * narratives. Everything that v1.27 shipped (Round 1~4 reviews,
 * RLUSD integration, 372 settled TX history, MCP v0.3.4 on the
 * Anthropic MCP Registry) stays intact on `main` and on the
 * `v1.27-multichain` tag for restoration.
 */
export const BNB_FOCUS_MODE = true;

/**
 * Single source of the user-facing message when something is rejected
 * because of BNB_FOCUS_MODE. Used by the relay route error body, the
 * SDK throw, the MCP tool error, and the UI tooltip on disabled chains.
 */
export const BNB_FOCUS_REJECTION_MESSAGE =
  "BNB-focus sprint: this chain/token is temporarily hidden. Full multi-chain support returns after the sprint window. See the dashboard for chains currently active.";

/**
 * The single allow-listed chain/token pair during the sprint. Keep
 * this as a function so it's easy to change to a multi-chain set if
 * the sprint scope shifts mid-week.
 */
export function getSprintAllowedChains(): readonly string[] {
  return BNB_FOCUS_MODE ? (["bnb"] as const) : [];
}

export function getSprintAllowedTokens(chain: string): readonly string[] {
  if (!BNB_FOCUS_MODE) return ["USDC", "USDT", "RLUSD"];
  if (chain === "bnb") return ["USDC", "USDT"];
  return [];
}
