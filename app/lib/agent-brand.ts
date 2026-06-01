/**
 * agent-brand.ts — single source of truth for the Q402 agent brand lock.
 *
 * Used by:
 *   • POST /register-agent (prepare)  → input validation on body fields
 *   • POST /register-agent/confirm    → defence-in-depth verification
 *                                       against the on-chain agentURI's
 *                                       metadata, in case the user
 *                                       sidestepped the prepare lock
 *                                       (e.g. by mutating the calldata)
 *   • AgenticWalletAgentModal (UI)    → readonly labels + preview
 *
 * If ANY of these constants change we want every site that enforces the
 * policy to update in lockstep. Putting them here + drift-guarding via a
 * test fixes that across the file tree.
 *
 * This module is intentionally framework-agnostic (no `next/server`
 * imports) so it's safe to bundle into client components.
 */

/** Exact agent name every Q402 user mints under, no exceptions. */
export const REQUIRED_AGENT_NAME = "Q402 Agent (by Quack AI)";

/**
 * Required description prefix. The full description must be EITHER this
 * exact string, OR `${prefix} ${tagline}` where tagline is 1..MAX_TAGLINE
 * chars (post-trim).
 */
export const REQUIRED_DESC_PREFIX = "Gasless stablecoin payment agent on BNB Chain.";

/** Max chars for the optional per-agent tagline. */
export const MAX_TAGLINE = 120;

/** Path the brand icon is served under on every Q402 deploy. */
export const BRAND_ICON_PATH = "/icon.svg";

/**
 * Build the canonical image URL the brand lock requires for a given
 * deploy origin. Same string on both client (window.location.origin) and
 * server (originFromRequest(req)) when they converge.
 */
export function brandIconUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/$/, "")}${BRAND_ICON_PATH}`;
}

/**
 * Validate a description against the brand lock. Returns `null` if OK,
 * else an error tag identifying which rule failed.
 */
export type DescriptionError = "DESCRIPTION_PREFIX_REQUIRED" | "TAGLINE_LENGTH";

export function validateDescription(description: string): DescriptionError | null {
  if (description === REQUIRED_DESC_PREFIX) return null;
  if (!description.startsWith(REQUIRED_DESC_PREFIX + " ")) {
    return "DESCRIPTION_PREFIX_REQUIRED";
  }
  const tagline = description.slice(REQUIRED_DESC_PREFIX.length + 1);
  if (tagline.length === 0 || tagline.length > MAX_TAGLINE) {
    return "TAGLINE_LENGTH";
  }
  return null;
}
