/**
 * Q402 Hook system — registry + dispatcher.
 *
 * The registry is the ordered list of installed hooks. The dispatcher
 * runs the subset matching a lifecycle, in order, applying the
 * semantics documented in types.ts:
 *
 *   - First DENY short-circuits and is returned immediately.
 *   - At most one SPLIT is allowed; a second is a MULTIPLE_SPLITS deny.
 *   - A hook that throws resolves by its failMode (open → allow,
 *     closed → deny with `{name}_ERROR`).
 *   - A SPLIT returned outside beforeSettle is an INVALID_SPLIT_LIFECYCLE
 *     deny (defensive — split fan-out is only wired at settle time).
 *
 * `runHooks` takes the hook list as a parameter (default: the global
 * HOOKS registry) so tests can exercise the dispatcher with fabricated
 * hooks without touching global state.
 */

import type {
  Hook,
  HookContext,
  HookLifecycle,
  HookOutcome,
} from "./types";
import { reputationGate } from "./reputation-gate";
import { conditionalOracle } from "./conditional-oracle";
import { complianceGate } from "./compliance";
import { multiPayeeSplit } from "./multipayee-split";

/**
 * Installed hooks. Order matters: hooks run top-to-bottom, and the
 * first deny wins, so put the cheapest / most-likely-to-deny checks
 * first when the wave fills out (ComplianceGate before ReputationGate,
 * etc.).
 *
 * Hooks 1.0 wave (all shipped):
 *   #1 ComplianceGate    (beforeAuthorize)
 *   #2 ReputationGate    (beforeSettle)
 *   #4 ConditionalOracle (beforeSettle)
 *   #3 MultiPayeeSplit   (beforeSettle, transform)
 *
 * Order within beforeSettle: gates BEFORE the transform, so a deny
 * (reputation / oracle) short-circuits before we bother computing a
 * split. MultiPayeeSplit is last.
 */
export const HOOKS: Hook[] = [
  complianceGate,
  reputationGate,
  conditionalOracle,
  multiPayeeSplit,
];

export interface DispatchResult {
  outcome: HookOutcome;
  /** Names of hooks that actually ran (passed shouldRun), in order. */
  ran: string[];
}

/**
 * Run every hook registered for `lifecycle` against `ctx`.
 *
 * Returns the resolved outcome plus the list of hooks that executed
 * (for observability — the caller can log which hooks touched a
 * payment). A no-op (no hooks, or none applicable) yields
 * `{ action: "allow" }`.
 */
export async function runHooks(
  lifecycle: HookLifecycle,
  ctx: HookContext,
  hooks: Hook[] = HOOKS,
): Promise<DispatchResult> {
  const ran: string[] = [];
  let split: Extract<HookOutcome, { action: "split" }> | null = null;

  for (const hook of hooks) {
    if (hook.lifecycle !== lifecycle) continue;

    let applicable: boolean;
    try {
      applicable = await hook.shouldRun(ctx);
    } catch {
      // A shouldRun that throws is treated like the hook erroring:
      // resolve by failMode. A compliance hook whose enablement check
      // fails must not be silently skipped.
      if (hook.failMode === "closed") {
        return {
          outcome: {
            action: "deny",
            code: `${hook.name}_ERROR`,
            reason: `${hook.name} could not determine applicability`,
            status: 502,
          },
          ran,
        };
      }
      continue;
    }
    if (!applicable) continue;

    ran.push(hook.name);

    let outcome: HookOutcome;
    try {
      outcome = await hook.run(ctx);
    } catch (e) {
      if (hook.failMode === "open") {
        // Fail-soft: a transient error in a non-blocking filter
        // shouldn't wedge the payment. Treat as allow and move on.
        outcome = { action: "allow" };
      } else {
        // Fail-safe: a compliance / reputation check that errors must
        // deny — never let a payment through on an unevaluated gate.
        return {
          outcome: {
            action: "deny",
            code: `${hook.name}_ERROR`,
            reason:
              e instanceof Error
                ? `${hook.name} failed: ${e.message.slice(0, 160)}`
                : `${hook.name} failed`,
            status: 502,
          },
          ran,
        };
      }
    }

    if (outcome.action === "deny") {
      // First deny wins — short-circuit the rest of the chain.
      return { outcome, ran };
    }

    if (outcome.action === "split") {
      if (lifecycle !== "beforeSettle") {
        return {
          outcome: {
            action: "deny",
            code: "INVALID_SPLIT_LIFECYCLE",
            reason: `hook ${hook.name} returned a split outside beforeSettle`,
            status: 500,
          },
          ran,
        };
      }
      if (split) {
        return {
          outcome: {
            action: "deny",
            code: "MULTIPLE_SPLITS",
            reason: "two hooks returned a split for the same settlement",
            status: 500,
          },
          ran,
        };
      }
      split = outcome;
      // Don't short-circuit — later gate hooks can still deny a split
      // payment (e.g. a compliance check on one of the split legs is
      // out of scope for v1, but a reputation gate on the original
      // recipient still applies). Continue the chain.
    }
  }

  return { outcome: split ?? { action: "allow" }, ran };
}
