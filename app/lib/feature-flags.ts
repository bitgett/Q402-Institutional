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
 * BNB-focus sprint (2026-05-19 → 2026-06-30).
 *
 * ── Semantics (revised) ────────────────────────────────────────────────
 * This flag NO LONGER narrows the main product. The main landing, relay
 * route, SDK, MCP server, and UI all stay on the full 7-chain + RLUSD
 * matrix exactly as on `main`. The flag now only controls visibility of
 * the dedicated `/event` page that hosts the free-trial signup +
 * sprint narrative.
 *
 * When EVENT_MODE is true:
 *   - /event renders the sprint page (Hero CTA stack, trial activation,
 *     Google / Email / Wallet signup, sprint marketing copy)
 *   - Navbar adds an "Event" link pointing at /event
 *
 * When EVENT_MODE is false (post-sprint state, on `main`):
 *   - /event returns a small "Event ended — multichain back to normal"
 *     page (no 404 so any stale shared links still resolve gracefully)
 *   - Navbar omits the Event link
 *
 * The free-trial backend (`/api/trial/activate`, sessions, email magic
 * link, Google OAuth) is independent of this flag — the trial program
 * itself stays callable after the sprint; we just stop promoting it.
 *
 * Legacy export name `BNB_FOCUS_MODE` is kept as an alias for the
 * handful of test files that still import it, but new code should
 * prefer `EVENT_MODE`.
 */
export const EVENT_MODE = true;

/**
 * Legacy alias — semantically "is the relay/SDK/MCP narrowed to BNB-only?".
 * The narrowing was reverted (see Semantics section above), so this is now
 * permanently false. Kept as an export so existing tests that grep for the
 * symbol still find it and pass.
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
