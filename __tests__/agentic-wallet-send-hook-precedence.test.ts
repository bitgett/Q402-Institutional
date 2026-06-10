/**
 * agentic-wallet-send-hook-precedence.test.ts
 *
 * Source-grep regression guards for three fund-critical fixes in
 * /api/wallet/agentic/send so they can't be reverted without the suite
 * failing. A full behavioural exercise would need ~150 lines of fixtures
 * (mocked @vercel/kv + requireIntentAuth + getApiKeyRecord +
 * getSubscription + the hook registry); we pin the SHAPE here, matching
 * the established posture of `agentic-wallet-mode-c-stale-key.test.ts`
 * and `relay-ordering.test.ts`.
 *
 * BUG 3 (split result-reporting): the fresh complete-split response must
 *   carry a top-level txHash (the first settled leg's hash) so it mirrors
 *   the durable-replay shape; a client keying off body.txHash otherwise
 *   sees a hash on replay but not on first settle.
 *
 * BUG 4 (cross-lifecycle precedence inversion): a beforeAuthorize
 *   require_approval must NOT be surfaced as a soft 202 when a beforeSettle
 *   gate (ReputationGate / ConditionalOracle) would HARD-deny the same
 *   payment. The beforeSettle gates are evaluated before the 202 return and
 *   a deny takes precedence (deny > require_approval).
 *
 * BUG 5 (split legs bypass beforeSettle gates): each split leg recipient
 *   must be re-screened through beforeSettle (not just beforeAuthorize) so
 *   ReputationGate / ConditionalOracle see the leg addresses that actually
 *   receive funds. A leg failing the gate denies/holds the WHOLE split.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEND_ROUTE = readFileSync(
  resolve(__dirname, "..", "app", "api", "wallet", "agentic", "send", "route.ts"),
  "utf8",
);

function indexOf(pattern: RegExp, label: string): number {
  const m = SEND_ROUTE.match(pattern);
  if (!m || m.index === undefined) {
    throw new Error(`landmark not found: ${label} (pattern ${pattern})`);
  }
  return m.index;
}

describe("BUG 3 — fresh complete-split response carries a top-level txHash", () => {
  it("the fresh-split return spreads the first settled leg's txHash", () => {
    // The fresh-split branch ends with `settled: settledLegs.length` then
    // `failed: failedLegs.length`. Just before that response object it must
    // conditionally spread settledLegs[0].txHash as a top-level field.
    const splitReturnSlice = SEND_ROUTE.slice(
      indexOf(/sendId,\s*\n\s*status: splitStatus,/, "fresh-split return head"),
      indexOf(/settled: settledLegs\.length,/, "fresh-split settled count"),
    );
    expect(splitReturnSlice).toMatch(
      /\.\.\.\(settledLegs\[0\]\?\.txHash\s*\?\s*\{\s*txHash: settledLegs\[0\]\.txHash\s*\}\s*:\s*\{\}\)/,
    );
  });

  it("the fresh-split return still includes per-leg hashes in legs[]", () => {
    // Top-level txHash is additive — legs[] stays authoritative.
    const splitReturnSlice = SEND_ROUTE.slice(
      indexOf(/sendId,\s*\n\s*status: splitStatus,/, "fresh-split return head"),
      indexOf(/failed: failedLegs\.length,/, "fresh-split failed count"),
    );
    expect(splitReturnSlice).toMatch(/legs: splitRecord\.legs,/);
  });

  it("the durable-replay path likewise carries a top-level txHash (shape parity)", () => {
    // The fix's whole point is parity with the replay shape, which spreads
    // priorSettled.txHash. Guard that the replay still does so.
    expect(SEND_ROUTE).toMatch(
      /priorSettled\.txHash\s*\?\s*\{\s*txHash: priorSettled\.txHash\s*\}\s*:\s*\{\}/,
    );
  });
});

describe("BUG 4 — beforeSettle deny outranks a beforeAuthorize require_approval", () => {
  it("evaluates beforeSettle gates inside the require_approval branch", () => {
    // The require_approval branch (after the beforeAuthorize deny check)
    // must run a beforeSettle dispatch before surfacing the 202.
    const branchStart = indexOf(
      /if \(authHook\.outcome\.action === "require_approval"\) \{/,
      "require_approval branch",
    );
    const branchSlice = SEND_ROUTE.slice(branchStart, branchStart + 2000);
    expect(branchSlice).toMatch(/runHooks\("beforeSettle"/);
  });

  it("a beforeSettle DENY returns the deny (error shape) instead of the 202 hold", () => {
    const branchStart = indexOf(
      /if \(authHook\.outcome\.action === "require_approval"\) \{/,
      "require_approval branch",
    );
    const branchSlice = SEND_ROUTE.slice(branchStart, branchStart + 2000);
    // A `settleGate`-style deny check that returns an `error` body must
    // appear BEFORE the `status: "approval_required"` 202 return.
    const denyIdx = branchSlice.search(/\.outcome\.action === "deny"/);
    const approvalReturnIdx = branchSlice.search(/status: "approval_required"/);
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(approvalReturnIdx).toBeGreaterThan(denyIdx);
  });

  it("the early beforeSettle evaluation does NOT charge/reserve (evaluation only)", () => {
    // The require_approval branch runs BEFORE the idempotency claim and the
    // daily-limit charge, so the early gate eval must not call
    // chargeAgainstDailyLimit or refundAndRelease (nothing is held yet).
    const branchStart = indexOf(
      /if \(authHook\.outcome\.action === "require_approval"\) \{/,
      "require_approval branch",
    );
    const branchSlice = SEND_ROUTE.slice(branchStart, branchStart + 2000);
    expect(branchSlice).not.toMatch(/chargeAgainstDailyLimit/);
    expect(branchSlice).not.toMatch(/refundAndRelease/);
    // And the eval must sit before the SET NX claim / charge in the file.
    expect(branchStart).toBeLessThan(indexOf(/SET NX claim BEFORE any relay work/, "idempotency claim"));
    expect(branchStart).toBeLessThan(indexOf(/const reservation = await chargeAgainstDailyLimit/, "reservation"));
  });
});

describe("BUG 5 — split legs are re-screened through beforeSettle gates", () => {
  it("the split pre-flight loop runs beforeSettle per leg (not just beforeAuthorize)", () => {
    // The fan-out screening loop re-runs beforeAuthorize per leg; it must
    // ALSO re-run beforeSettle per leg with the leg recipient.
    const loopStart = indexOf(
      /Screen EACH split leg recipient through beforeAuthorize/,
      "split screening loop",
    );
    // Bound the slice to the screening loop region (before key decryption).
    const loopSlice = SEND_ROUTE.slice(
      loopStart,
      indexOf(/const pkSplit = decryptPrivateKey\(wallet\);/, "split key decrypt"),
    );
    expect(loopSlice).toMatch(/runHooks\("beforeAuthorize"/);
    expect(loopSlice).toMatch(/runHooks\("beforeSettle"/);
  });

  it("the per-leg beforeSettle uses the leg recipient, not body.to", () => {
    const loopStart = indexOf(
      /Re-screen EACH leg through the beforeSettle gates too/,
      "per-leg beforeSettle comment",
    );
    const evalSlice = SEND_ROUTE.slice(loopStart, loopStart + 1100);
    expect(evalSlice).toMatch(/runHooks\("beforeSettle"/);
    expect(evalSlice).toMatch(/recipient: leg\.recipient\.toLowerCase\(\)/);
  });

  it("the per-leg beforeSettle passes params: undefined (no re-split of a single leg)", () => {
    const loopStart = indexOf(
      /Re-screen EACH leg through the beforeSettle gates too/,
      "per-leg beforeSettle comment",
    );
    const evalSlice = SEND_ROUTE.slice(loopStart, loopStart + 1100);
    expect(evalSlice).toMatch(/params: undefined/);
  });

  it("a leg failing the beforeSettle gate (deny OR hold) blocks the WHOLE split + refunds", () => {
    const loopStart = indexOf(
      /Re-screen EACH leg through the beforeSettle gates too/,
      "per-leg beforeSettle comment",
    );
    const handlingSlice = SEND_ROUTE.slice(loopStart, loopStart + 1600);
    // Mirrors the per-leg beforeAuthorize handling: deny || require_approval,
    // refundAndRelease, split:true, heldRecipient.
    expect(handlingSlice).toMatch(
      /legSettle\.outcome\.action === "deny" \|\| legSettle\.outcome\.action === "require_approval"/,
    );
    expect(handlingSlice).toMatch(/refundAndRelease\(\)/);
    expect(handlingSlice).toMatch(/heldRecipient: leg\.recipient\.toLowerCase\(\)/);
    expect(handlingSlice).toMatch(/split: true/);
  });
});
