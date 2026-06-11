/**
 * recurring-payouts-hooks.test.ts
 *
 * Regression guard for the /api/cron/recurring-payouts hook bypass.
 *
 * THE BUG (HIGH — fund/consent): the unattended recurring cron settled
 * each recipient straight through `submitToRelay` and NEVER called
 * `runHooks` for ANY lifecycle. It only re-implemented the wallet's
 * NATIVE perTxMaxUsd + dailyLimitUsd caps. So a wallet owner's opted-in
 * SpendCapPolicy — the `allowedRecipients` whitelist (a beforeAuthorize
 * HARD deny: "only pay these counterparties") and `allowedWindowsUtc`
 * (business-hours-only) — plus the global ComplianceGate (OFAC) and the
 * beforeSettle ReputationGate were SILENTLY SKIPPED on scheduled fires.
 * Because rules are creatable with just an API key (Mode C), a
 * compromised key could stand up a rule paying recipients the owner
 * explicitly excluded, at any hour, and the cron would honour it.
 * /api/relay only backstops OFAC, nothing else.
 *
 * THE FIX (mirrors batch/route.ts + send/route.ts):
 *   - Screen EVERY recipient through `runHooks("beforeAuthorize")` BEFORE
 *     the daily-cap reservation. A deny / require_approval TERMINATES the
 *     rule via recordRuleCapExceeded (binds SpendCapPolicy allowlist +
 *     window + ComplianceGate) — the owner must fix config + resume.
 *   - Run `runHooks("beforeSettle")` per recipient inside the settle
 *     loop, BEFORE signAgenticPayment, dropping a non-allow row the same
 *     way a relay-failure row is dropped (binds ReputationGate).
 *
 * Source-grep landmarks so the fix can't be reverted without this suite
 * failing. If processOneRule is refactored, update the landmarks — not the
 * invariant that BOTH hook lifecycles bind on the scheduled cron and a
 * blocked recipient never settles.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLF(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

const ROOT = resolve(__dirname, "..");
const cronSrc = readLF(
  resolve(ROOT, "app", "api", "cron", "recurring-payouts", "route.ts"),
);
const batchSrc = readLF(
  resolve(ROOT, "app", "api", "wallet", "agentic", "batch", "route.ts"),
);

function indexOf(src: string, pattern: RegExp, label: string): number {
  const m = src.match(pattern);
  if (!m || m.index === undefined) {
    throw new Error(`landmark not found: ${label} (pattern ${pattern})`);
  }
  return m.index;
}

describe("cron/recurring-payouts — payment hooks bind on scheduled fires", () => {
  const BEFORE_AUTHORIZE = /runHooks\(\s*"beforeAuthorize"/;
  const BEFORE_SETTLE = /runHooks\(\s*"beforeSettle"/;
  const SIGN_PAYMENT = /await signAgenticPayment\(/;
  const SUBMIT_RELAY = /await submitToRelay\(/;
  const DAILY_RESERVE = /chargeAgainstDailyLimit\(/;
  const CAP_EXCEEDED = /recordRuleCapExceeded\(/;

  it("imports + dispatches runHooks (was entirely absent on the cron)", () => {
    // The core of the bug: NO runHooks call existed in the cron. Both
    // lifecycles must now be wired or the owner's SpendCapPolicy /
    // ComplianceGate / ReputationGate are bypassed on unattended fires.
    expect(cronSrc).toMatch(/from\s+"@\/app\/lib\/hooks"/);
    expect(cronSrc).toMatch(BEFORE_AUTHORIZE);
    expect(cronSrc).toMatch(BEFORE_SETTLE);
  });

  it("uses source:\"recurring\" + both lifecycles in the dispatch context", () => {
    expect(cronSrc).toMatch(/source:\s*"recurring"/);
    expect(cronSrc).toMatch(/lifecycle:\s*"beforeAuthorize"/);
    expect(cronSrc).toMatch(/lifecycle:\s*"beforeSettle"/);
  });

  it("runs beforeAuthorize BEFORE the daily-cap reservation (no shadow-lock)", () => {
    // beforeAuthorize must gate before any daily charge — matching
    // send/batch — so a hook deny doesn't reserve (and then have to
    // refund) the daily bucket. SpendCapPolicy (allowlist + window) +
    // ComplianceGate are beforeAuthorize hooks; this is where they bind.
    const authIdx = indexOf(cronSrc, BEFORE_AUTHORIZE, "beforeAuthorize");
    const reserveIdx = indexOf(cronSrc, DAILY_RESERVE, "chargeAgainstDailyLimit");
    expect(authIdx).toBeLessThan(reserveIdx);
  });

  it("a beforeAuthorize deny / require_approval TERMINATES the rule (binds allowlist + window + OFAC)", () => {
    // A blocked recipient must freeze the rule (recordRuleCapExceeded:
    // fired-cap-exceeded + ZSET removal + lastError) and NOT settle —
    // analogous to the per-tx / daily-cap exceedance terminal path. The
    // owner fixes the spend policy / compliance posture and resumes.
    const authIdx = indexOf(cronSrc, BEFORE_AUTHORIZE, "beforeAuthorize");
    const denyGuard = cronSrc.indexOf(
      'auth.outcome.action === "deny" || auth.outcome.action === "require_approval"',
    );
    expect(denyGuard).toBeGreaterThan(authIdx);
    // The terminate call lives after the deny guard.
    expect(cronSrc).toMatch(CAP_EXCEEDED);
    expect(cronSrc).toMatch(/outcome:\s*"skipped-hook-denied"/);
  });

  it("runs beforeSettle BEFORE signing each recipient (binds ReputationGate)", () => {
    // beforeSettle must gate the per-recipient settlement: it runs in the
    // settle loop and BEFORE signAgenticPayment, or a denied recipient
    // still gets signed + relayed. Mirrors processRow in batch/route.ts.
    const settleIdx = indexOf(cronSrc, BEFORE_SETTLE, "beforeSettle");
    const signIdx = indexOf(cronSrc, SIGN_PAYMENT, "signAgenticPayment");
    const relayIdx = indexOf(cronSrc, SUBMIT_RELAY, "submitToRelay");
    expect(settleIdx).toBeLessThan(signIdx);
    expect(signIdx).toBeLessThan(relayIdx);
  });

  it("a beforeSettle non-allow row is dropped via the existing failure path (no settle)", () => {
    // A denied beforeSettle outcome must funnel into the SAME per-row
    // failure machinery used for relay errors (firstFailureBeforeAnySuccess
    // on row 0, failedRows.push otherwise) so the row never reaches the
    // sign/relay and the partial-success refund accounting stays intact.
    expect(cronSrc).toMatch(
      /settleHook\.outcome\.action === "deny"[\s\S]{0,80}settleHook\.outcome\.action === "require_approval"/,
    );
    expect(cronSrc).toMatch(/firstFailureBeforeAnySuccess = errMsg;/);
    expect(cronSrc).toMatch(/failedRows\.push\(\{ to: row\.to, amount: row\.amount, reason: errMsg, index: i \}\);/);
  });

  it("matches the canonical batch-route beforeSettle pattern (parity)", () => {
    // The fix mirrors batch/route.ts, which already gates per-row
    // beforeSettle before signing. If batch ever drops its dispatch that's
    // a separate regression — assert parity so the surfaces stay aligned.
    expect(batchSrc).toMatch(BEFORE_SETTLE);
  });
});
