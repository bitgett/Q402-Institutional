/**
 * agentic-batch-before-settle.test.ts
 *
 * Regression guard for the /api/wallet/agentic/batch beforeSettle bypass.
 *
 * THE BUG: the batch route's only hook dispatch was the per-row
 * `runHooks("beforeAuthorize")` loop. It NEVER called
 * `runHooks("beforeSettle")`. The dispatcher skips hooks whose lifecycle
 * doesn't match the requested lifecycle, so ReputationGate (lifecycle
 * beforeSettle, reads STORED per-wallet config) was FULLY bypassed on
 * /batch — an owner who enabled "only pay reputable counterparties"
 * (incl. onUnknown:"deny") silently lost that guarantee the moment
 * payments routed through /batch instead of /send.
 *
 * THE FIX: run `runHooks("beforeSettle")` per batch row BEFORE settling
 * that row (mirroring send/route.ts), and DROP any row whose beforeSettle
 * hook returns a non-allow outcome (deny / require_approval / split) so it
 * is recorded as a failed result rather than settling.
 *
 * Source-grep so the fix can't be reverted without this suite failing.
 * If processRow is refactored, update the landmarks — not the invariant
 * that beforeSettle runs per row and a non-allow outcome drops the row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLF(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

const ROOT = resolve(__dirname, "..");
const batchSrc = readLF(resolve(ROOT, "app", "api", "wallet", "agentic", "batch", "route.ts"));
const sendSrc = readLF(resolve(ROOT, "app", "api", "wallet", "agentic", "send", "route.ts"));

function indexOf(src: string, pattern: RegExp, label: string): number {
  const m = src.match(pattern);
  if (!m || m.index === undefined) {
    throw new Error(`landmark not found: ${label} (pattern ${pattern})`);
  }
  return m.index;
}

describe("agentic/batch — beforeSettle hooks run per row (ReputationGate not bypassed)", () => {
  const BEFORE_SETTLE = /runHooks\(\s*"beforeSettle"/;
  const BEFORE_AUTHORIZE = /runHooks\(\s*"beforeAuthorize"/;
  const PROCESS_ROW = /async function processRow\(/;
  const SIGN_PAYMENT = /await signAgenticPayment\(/;

  it("dispatches runHooks(\"beforeSettle\") on the batch route", () => {
    // The core of the fix: without this call ReputationGate (beforeSettle)
    // is never evaluated on /batch and the owner's stored gate is bypassed.
    expect(batchSrc).toMatch(BEFORE_SETTLE);
  });

  it("still dispatches the per-row beforeAuthorize screen (unchanged)", () => {
    expect(batchSrc).toMatch(BEFORE_AUTHORIZE);
  });

  it("runs beforeSettle INSIDE processRow, BEFORE signing that row", () => {
    // beforeSettle must gate the per-row settlement: it has to live inside
    // processRow and run before the signAgenticPayment for that row, or a
    // denied recipient still gets signed + relayed.
    const procIdx = indexOf(batchSrc, PROCESS_ROW, "processRow");
    const settleIdx = indexOf(batchSrc, BEFORE_SETTLE, "beforeSettle");
    const signIdx = indexOf(batchSrc, SIGN_PAYMENT, "signAgenticPayment");
    expect(procIdx).toBeLessThan(settleIdx);
    expect(settleIdx).toBeLessThan(signIdx);
  });

  it("passes source:\"batch\" and lifecycle:\"beforeSettle\" to the dispatch", () => {
    // The dispatch must be a real beforeSettle call against the batch
    // surface — same context shape the send route uses, with source=batch.
    expect(batchSrc).toMatch(/lifecycle:\s*"beforeSettle"/);
    expect(batchSrc).toMatch(/source:\s*"batch"/);
  });

  it("drops (does NOT settle) a row whose beforeSettle outcome is not allow", () => {
    // A non-allow outcome (deny / require_approval / split) must short out
    // of processRow with ok:false BEFORE the sign/relay, so the row never
    // settles. The batch's partial/failed (207/502) accounting + daily-cap
    // refund flow from the resulting ok:false row, unchanged.
    expect(batchSrc).toMatch(/settleHook\.outcome\.action\s*!==\s*"allow"/);
    expect(batchSrc).toMatch(/return\s*\{\s*to:\s*row\.to,\s*amount:\s*row\.amount,\s*ok:\s*false/);
  });

  it("does not treat a split outcome as a single-recipient settle (no fund misdirection)", () => {
    // Batch has no per-row fan-out; a split outcome must drop the row, not
    // silently pay the full amount to row.to.
    expect(batchSrc).toMatch(/SPLIT_NOT_SUPPORTED_IN_BATCH/);
  });

  it("matches the canonical send-route beforeSettle pattern (parity)", () => {
    // The fix mirrors send/route.ts, which has long dispatched beforeSettle.
    // If send ever drops its beforeSettle, that's a separate regression —
    // assert parity so the two payment surfaces stay aligned.
    expect(sendSrc).toMatch(BEFORE_SETTLE);
  });
});
