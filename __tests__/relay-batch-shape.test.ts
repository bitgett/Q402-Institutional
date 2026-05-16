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
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

const batchRouteSrc = readFileSync(
  resolve(ROOT, "app", "api", "relay", "batch", "route.ts"),
  "utf8",
);
const sdkSrc = readFileSync(
  resolve(ROOT, "public", "q402-sdk.js"),
  "utf8",
);

// The MCP server is a sibling repo (bitgett/q402-mcp), gitignored here.
// On a fresh clone of q402-landing the `mcp-server/` directory is absent
// and we'd ENOENT at module load. Soft-skip the MCP-side blocks when the
// sibling repo isn't checked out alongside; the same suites still run on
// the canonical local dev layout where it IS present.
//
// Every cross-repo readFileSync runs at TOP LEVEL with an existsSync
// guard, never inside a describe(...) body. `describe.skipIf` only skips
// the it() callbacks below it — the describe callback itself is always
// evaluated, so a raw readFileSync nested inside would ENOENT before
// the skipIf even runs.
const MCP_INDEX_PATH       = resolve(ROOT, "mcp-server", "src", "index.ts");
const MCP_BATCH_TOOL_PATH  = resolve(ROOT, "mcp-server", "src", "tools", "batch-pay.ts");
const MCP_CLIENT_PATH      = resolve(ROOT, "mcp-server", "src", "client.ts");
const mcpAvailable         = existsSync(MCP_INDEX_PATH) && existsSync(MCP_BATCH_TOOL_PATH);
const mcpClientAvailable   = existsSync(MCP_CLIENT_PATH);
const mcpIndexSrc          = mcpAvailable       ? readFileSync(MCP_INDEX_PATH,      "utf8") : "";
const mcpBatchToolSrc      = mcpAvailable       ? readFileSync(MCP_BATCH_TOOL_PATH, "utf8") : "";
const mcpClientSrc         = mcpClientAvailable ? readFileSync(MCP_CLIENT_PATH,     "utf8") : "";

describe("/api/relay/batch route", () => {
  it("declares trial=5 and paid=20 recipient caps as named constants", () => {
    expect(batchRouteSrc).toMatch(/MAX_RECIPIENTS_TRIAL\s*=\s*5/);
    expect(batchRouteSrc).toMatch(/MAX_RECIPIENTS_PAID\s*=\s*20/);
  });

  it("aborted batches return ok:false with status 424", () => {
    // Previous revision returned 200/ok:true even when recipient[0]
    // failed and the batch was abandoned. SDK wrappers that only throw
    // on !resp.ok would silently surface a fully-failed batch as
    // success. The status policy lives in source so a regression
    // (e.g. a refactor that drops the `{ status }` arg) trips here.
    expect(batchRouteSrc).toMatch(/ok:\s*totalFailed\s*===\s*0/);
    expect(batchRouteSrc).toMatch(/isAborted\s*\?\s*424/);
    expect(batchRouteSrc).toMatch(/isPartialFailure\s*\?\s*207/);
  });

  it("rejects non-batchable chains (xlayer / stable) with CHAIN_NOT_BATCHABLE", () => {
    // The server is the authoritative chain gate for batching. Browser
    // SDK + Node client + MCP tool schema all agree on the same 5-chain
    // set; this assertion locks the server in lockstep.
    expect(batchRouteSrc).toMatch(/CHAIN_NOT_BATCHABLE/);
    expect(batchRouteSrc).toMatch(/BATCHABLE_CHAINS[\s\S]*?"avax"[\s\S]*?"bnb"[\s\S]*?"eth"[\s\S]*?"mantle"[\s\S]*?"injective"/);
    expect(batchRouteSrc).not.toMatch(/BATCHABLE_CHAINS[^)]*"xlayer"/);
    expect(batchRouteSrc).not.toMatch(/BATCHABLE_CHAINS[^)]*"stable"/);
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

  it("throws BatchPayError on aborted or partial-failure responses", () => {
    // Earlier revision only threw on !resp.ok; the server now returns
    // 424/207/200 + ok:false, and the SDK MUST surface either as an
    // exception so callers can't keep treating the response as success.
    expect(sdkSrc).toMatch(/!resp\.ok\s*\|\|\s*data\?\.ok\s*===\s*false/);
    expect(sdkSrc).toMatch(/err\.name\s*=\s*"BatchPayError"/);
    expect(sdkSrc).toMatch(/err\.aborted\s*=/);
    expect(sdkSrc).toMatch(/err\.results\s*=/);
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

describe.skipIf(!mcpAvailable)("MCP server q402_batch_pay registration", () => {
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

  it("input schema restricts chain to the 5-chain batchable set", () => {
    // xlayer + stable must NOT appear in the Zod enum or in the JSON
    // schema enum — the server is authoritative but the tool surface
    // should fail fast for the agent. Same set as Node client + server.
    expect(mcpBatchToolSrc).toMatch(/z\.enum\(\[\s*"avax",\s*"bnb",\s*"eth",\s*"mantle",\s*"injective"\s*\]\)/);
    expect(mcpBatchToolSrc).toMatch(/enum:\s*\[\s*"avax",\s*"bnb",\s*"eth",\s*"mantle",\s*"injective"\s*\]/);
    // Negative: xlayer / stable should NOT appear in either enum.
    // (They may still appear in comments — restrict the check to the
    // schema declarations only via tight surrounding context.)
    const zodChainBlock = mcpBatchToolSrc.match(/chain:\s*z\.enum\([^)]+\)/);
    expect(zodChainBlock?.[0]).not.toMatch(/"xlayer"|"stable"/);
  });

  it("BatchPayInputSchema accepts the (token, recipients) shape — no per-row token", () => {
    // The recipient items in the Zod schema must be { to, amount } only
    // — adding a per-row token here would silently allow mixed-token
    // batches that the server can't fan out.
    const recipientsBlock = mcpBatchToolSrc.match(/recipients:\s*z\s*\.\s*array\([\s\S]*?\.describe/);
    expect(recipientsBlock).not.toBeNull();
    expect(recipientsBlock![0]).not.toMatch(/\btoken:\s*z\./);
  });
});

describe.skipIf(!mcpClientAvailable)("MCP Node client batchPay()", () => {
  it("signature is `batchPay({ token, recipients })` — not `PayInput[]`", () => {
    // The previous signature `batchPay(inputs: PayInput[])` let callers
    // build payloads where every row had its own token field, but only
    // inputs[0].token was actually shipped. The new signature surfaces
    // the constraint in the type so mixed-token batches are impossible.
    expect(mcpClientSrc).toMatch(/async\s+batchPay\(\s*input:\s*\{[^}]*token:[^}]*recipients:/);
    expect(mcpClientSrc).not.toMatch(/async\s+batchPay\(\s*inputs:\s*PayInput\[\]/);
  });

  it("rejects xlayer / stable chains early", () => {
    expect(mcpClientSrc).toMatch(/chain\.key\s*===\s*"xlayer"\s*\|\|\s*chain\.key\s*===\s*"stable"/);
    expect(mcpClientSrc).toMatch(/batchPay does not yet support chain/);
  });

  it("throws BatchPayError on aborted / partial-failure server responses", () => {
    expect(mcpClientSrc).toMatch(/export\s+class\s+BatchPayError\s+extends\s+Error/);
    expect(mcpClientSrc).toMatch(/!resp\.ok\s*\|\|\s*data\.ok\s*===\s*false/);
    expect(mcpClientSrc).toMatch(/throw\s+err/);
  });
});
