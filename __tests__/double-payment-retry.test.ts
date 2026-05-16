/**
 * double-payment-retry.test.ts
 *
 * If a user's ERC20 transfer succeeds but the subsequent server-side
 * activation step fails, the "Try Again" button on /payment must NOT
 * re-trigger the ERC20 transfer — that's the user paying twice for one
 * activation. Earlier revision called payWithWallet() directly from the
 * retry button, which restarted the full flow from the intent step.
 *
 * The fix:
 *   - payWithWallet() branches on submittedTxHash:
 *       has txHash  → activation-only retry (no new ERC20)
 *       no txHash   → full flow
 *   - intentId persisted across retries so the server-side activation
 *     route can dedupe against (intentId, txHash).
 *   - Retry button copy reflects whether a payment is already pending.
 *
 * Source-grep only; an integration test would need a wagmi mock + a
 * server fixture for /api/payment/activate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pageSrc = readFileSync(
  resolve(__dirname, "..", "app", "payment", "page.tsx"),
  "utf8",
);

describe("payment retry — no double-charge", () => {
  it("payWithWallet branches on submittedTxHash before running ERC20 transfer", () => {
    // The branch is the entire guard against the double-spend; if a
    // refactor drops the conditional, this assertion trips.
    expect(pageSrc).toMatch(/if\s*\(\s*submittedTxHash\s*\)\s*\{[\s\S]+?runActivationOnly/);
  });

  it("activation-only path is a separate function, called by the txHash branch", () => {
    expect(pageSrc).toMatch(/async function runActivationOnly\(\s*txHash:\s*string,\s*intentId:\s*string\s*\|\s*null\s*\)/);
  });

  it("activation-only path does NOT call sendErc20Transfer", () => {
    // Capture the runActivationOnly function body and assert no ERC20
    // call inside. The function must end at its own closing brace before
    // any sendErc20Transfer reference appears.
    const fn = pageSrc.match(/async function runActivationOnly[\s\S]+?\n  \}\n/);
    expect(fn).not.toBeNull();
    expect(fn![0]).not.toMatch(/sendErc20Transfer/);
  });

  it("intentId is persisted across retries via lastIntentId state", () => {
    expect(pageSrc).toMatch(/const\s*\[\s*lastIntentId,\s*setLastIntentId\s*\]/);
    expect(pageSrc).toMatch(/setLastIntentId\(intentId\)/);
    // And the activation-only retry path consumes that state, not the
    // fresh intent.
    expect(pageSrc).toMatch(/runActivationOnly\(\s*submittedTxHash,\s*lastIntentId\s*\)/);
  });

  it("clears submittedTxHash + lastIntentId at the start of a FRESH attempt", () => {
    // Only the fresh-flow branch clears them. The retry branch must NOT
    // wipe them (the activation-only path needs both).
    expect(pageSrc).toMatch(/setSubmittedTxHash\(""\)[\s\S]+?setLastIntentId\(null\)/);
  });

  it("retry button label tells the user no new payment will be sent when a tx already landed", () => {
    expect(pageSrc).toMatch(/Retry Activation \(no new payment\)/);
  });
});
