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
 * EVENT_MODE — toggles the dedicated `/event` page that hosts the free-
 * trial signup + event narrative. The main landing, relay route, SDK,
 * MCP server, and UI all stay on the full 7-chain + RLUSD matrix
 * regardless of this flag.
 *
 * When EVENT_MODE is true:
 *   - /event renders the event page (Hero CTA stack, trial activation,
 *     Google / Email / Wallet signup, event marketing copy)
 *   - Navbar adds an "Event" link pointing at /event
 *
 * When EVENT_MODE is false:
 *   - /event returns a small "Event ended — multichain back to normal"
 *     page (no 404 so any stale shared links still resolve gracefully)
 *   - Navbar omits the Event link
 *
 * The free-trial backend (`/api/trial/activate`, sessions, email magic
 * link, Google OAuth) is independent of this flag — the trial program
 * itself stays callable; this flag only controls promotion.
 *
 * Legacy export name `BNB_FOCUS_MODE` is kept as an alias for the
 * handful of test files that still import it, but new code should
 * prefer `EVENT_MODE`.
 */
export const EVENT_MODE = true;

/**
 * Optional BNB-only narrowing of the relay/SDK/MCP chain matrix. When
 * true, every non-BNB chain's supportedTokens collapses to [] and the
 * matching server-side guards reject non-BNB calls. Currently disabled;
 * the constant is still exported so existing source-grep tests that
 * look for the symbol resolve cleanly.
 */
export const BNB_FOCUS_MODE = false;
export const BNB_FOCUS_REJECTION_MESSAGE = "";

export function getSprintAllowedChains(): readonly string[] {
  return [];
}

export function getSprintAllowedTokens(chain: string): readonly string[] {
  void chain;
  return ["USDC", "USDT", "RLUSD"];
}

/**
 * Free-trial parameters — independent of EVENT_MODE so the trial program
 * itself keeps working after the event-page visibility flips off. The
 * 30 days × 2,000 TX shape matches the plan's no-friction onboarding
 * pitch and the paid 30-day subscription window.
 */
export const TRIAL_DURATION_DAYS = 30;
export const TRIAL_CREDITS = 2_000;
export const TRIAL_PLAN_NAME = "trial";
