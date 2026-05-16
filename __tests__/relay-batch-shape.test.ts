/**
 * relay-batch-shape.test.ts
 *
 * Source-grep guards for the multi-recipient settlement surface introduced
 * alongside `q402_batch_pay`. We don't spin up a live request here — instead
 * we lock in the structural invariants that, if silently flipped, would let
 * a trial key fan out a 20-row batch or skip the scope check entirely.
 *
 * Checks:
 *   1. /api/relay/batch route exists and enforces the trial/paid recipient
 *      caps off `keyRecord.plan === "trial"`.
 *   2. The route fans out through internal fetch to /api/relay (not a
 *      re-implementation), preserving every guard in the canonical pipeline.
 *   3. First-failure abort is wired (recipient[0] must succeed before the
 *      delegation can be reused).
 *   4. The browser SDK exposes `batchPay()` and signs sequential EIP-7702
 *      auth nonces (base + i) so the relayer can apply them in order.
 *   5. The MCP server registers `q402_batch_pay` in both the ListTools array
 *      and the CallTool switch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const batchRouteSrc = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "batch", "route.ts"),
  "utf8",
);
const sdkSrc = readFileSync(
  resolve(__dirname, "..", "public", "q402-sdk.js"),
  "utf8",
);
const mcpIndexSrc = readFileSync(
  resolve(__dirname, "..", "mcp-server", "src", "index.ts"),
  "utf8",
);
const mcpBatchToolSrc = readFileSync(
  resolve(__dirname, "..", "mcp-server", "src", "tools", "batch-pay.ts"),
  "utf8",
);

describe("/api/relay/batch route", () => {
  it("declares trial=5 and paid=20 recipient caps as named constants", () => {
    expect(batchRouteSrc).toMatch(/MAX_RECIPIENTS_TRIAL\s*=\s*5/);
    expect(batchRouteSrc).toMatch(/MAX_RECIPIENTS_PAID\s*=\s*20/);
  });

  it("selects the cap off keyRecord.plan === \"trial\" (not a header or hint)", () => {
    // The plan field on the DB record is the authoritative source. Anyone
    // moving this to req headers / body input would let the client lie.
    expect(batchRouteSrc).toMatch(/keyRecord\.plan\s*===\s*"trial"/);
  });

  it("returns 403 BATCH_TOO_LARGE when recipients exceed the scope cap", () => {
    expect(batchRouteSrc).toMatch(/BATCH_TOO_LARGE/);
    expect(batchRouteSrc).toMatch(/status:\s*403/);
  });

  it("fans out via internal fetch to /api/relay (preserves canonical guards)", () => {
    // Reimplementing the relay pipeline here would duplicate every rate-limit,
    // scope, gas-tank, and credit-decrement check. The relay-batch route
    // MUST internally POST to /api/relay so those guards run per transfer.
    expect(batchRouteSrc).toMatch(/\$\{req\.nextUrl\.origin\}\/api\/relay/);
    expect(batchRouteSrc).toMatch(/method:\s*"POST"/);
  });

  it("aborts the batch after the first transfer fails", () => {
    // The first transfer installs the EIP-7702 delegation; if it fails,
    // every subsequent transfer is guaranteed to fail. Pressing on burns
    // signatures and confuses partial-success reporting.
    expect(batchRouteSrc).toMatch(/firstFailed/);
    expect(batchRouteSrc).toMatch(/if\s*\(firstFailed\)\s*break/);
  });

  it("validates recipient shape early with a 400 (not a partial-success batch)", () => {
    // Bad-payload should surface as one 400, not a 200 with N error rows.
    expect(batchRouteSrc).toMatch(/recipients\[\$\{i\}\]\.to must be a 0x address/);
    expect(batchRouteSrc).toMatch(/recipients\[\$\{i\}\]\.amount must be a positive integer string/);
  });

  it("rate-limits the batch endpoint separately from the single relay", () => {
    // Outer cap so a batchPay flood doesn't drown the per-key inner budget
    // 20 inner calls at a time.
    expect(batchRouteSrc).toMatch(/rateLimit\([^,]+,\s*"relay-batch"/);
  });
});

describe("browser SDK batchPay()", () => {
  it("exposes `async batchPay(...)` on Q402Client", () => {
    expect(sdkSrc).toMatch(/async\s+batchPay\s*\(\s*\{\s*recipients/);
  });

  it("caps recipients at 20 client-side (server is authoritative)", () => {
    expect(sdkSrc).toMatch(/recipients\.length\s*>\s*20/);
  });

  it("uses sequential authorization nonces (baseAuthNonce + i)", () => {
    // Each EIP-7702 authorization on the same EOA must use a different
    // nonce or the relayer can only apply one. Sequential from
    // `getTransactionCount(owner)` is the canonical pattern.
    expect(sdkSrc).toMatch(/baseAuthNonce\s*=\s*await\s+provider\.getTransactionCount/);
    expect(sdkSrc).toMatch(/nonce:\s*baseAuthNonce\s*\+\s*i/);
  });

  it("posts to /api/relay/batch (not /api/relay)", () => {
    expect(sdkSrc).toMatch(/relayUrl\.replace\(\/\\\/relay\$\/,\s*"\/relay\/batch"\)/);
  });

  it("rejects non-default EIP-7702 modes (xlayer/stable/eip3009) for batchPay", () => {
    // Those paths use chain-specific nonce fields the batch endpoint
    // doesn't currently fan out for. Fail loud rather than sign 20 rows
    // that get partial-rejected downstream.
    expect(sdkSrc).toMatch(/batchPay does not yet support chain/);
  });
});

describe("MCP server q402_batch_pay registration", () => {
  it("imports BATCH_PAY_TOOL, BatchPayInputSchema, runBatchPay", () => {
    expect(mcpIndexSrc).toMatch(
      /import\s*\{\s*BATCH_PAY_TOOL,\s*BatchPayInputSchema,\s*runBatchPay\s*\}\s*from\s*"\.\/tools\/batch-pay\.js"/,
    );
  });

  it("registers BATCH_PAY_TOOL in the ListTools response", () => {
    expect(mcpIndexSrc).toMatch(/tools:\s*\[[^\]]*BATCH_PAY_TOOL[^\]]*\]/);
  });

  it("handles the q402_batch_pay case in CallTool", () => {
    expect(mcpIndexSrc).toMatch(/case\s+"q402_batch_pay"/);
    expect(mcpIndexSrc).toMatch(/BatchPayInputSchema\.parse/);
    expect(mcpIndexSrc).toMatch(/runBatchPay\(parsed\)/);
  });

  it("declares trial=5 / paid=20 client-side ceiling for early rejection", () => {
    // Matches the server limits. Authoritative cap is server-side; the
    // client-side ceiling stops a malformed call from signing 100
    // authorizations locally before the server rejects them.
    expect(mcpBatchToolSrc).toMatch(/RECIPIENT_LIMIT_TRIAL\s*=\s*5/);
    expect(mcpBatchToolSrc).toMatch(/RECIPIENT_LIMIT_PAID\s*=\s*20/);
  });

  it("requires confirm: true in the input schema", () => {
    // q402_pay's user-approval contract — the agent must not flip this
    // flag on behalf of the user.
    expect(mcpBatchToolSrc).toMatch(/confirm:\s*z\s*\.?\s*\n?\s*\.literal\(true\)/m);
  });

  it("applies max-amount + allowlist guards PER RECIPIENT", () => {
    expect(mcpBatchToolSrc).toMatch(/maxAmountGuardBatch/);
    expect(mcpBatchToolSrc).toMatch(/recipientAllowlistGuardBatch/);
  });
});
