/**
 * mcp-tool-description-drift.test.ts
 *
 * MCP tool descriptions are what the agent reads to decide how/whether
 * to call a tool. If the description says "BNB-FOCUS SPRINT IS ACTIVE:
 * only chain: bnb" but the server actually accepts the full 9-chain
 * matrix for paid keys, the agent will refuse legitimate calls (or
 * worse, try to "correct" the user's intent).
 *
 * Earlier revisions of pay.ts + quote.ts hard-coded the BNB-only claim
 * even after BNB_FOCUS_MODE flipped to false. This test pins the
 * descriptions to match the actual per-tier policy:
 *
 *   - Trial keys → BNB only (server returns TRIAL_BNB_ONLY otherwise)
 *   - Paid keys  → full 9-chain matrix (avax, bnb, eth, xlayer, stable,
 *                  mantle, injective, monad, scroll), USDC/USDT broadly,
 *                  RLUSD on Ethereum only, Injective USDT-only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// CRLF→LF normalization so the source-grep regexes work in fresh
// Windows clones too (git default checkout = CRLF).
function readLF(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}
const ROOT = resolve(__dirname, "..");
const PAY_PATH   = resolve(ROOT, "mcp-server", "src", "tools", "pay.ts");
const QUOTE_PATH = resolve(ROOT, "mcp-server", "src", "tools", "quote.ts");
const BATCH_PATH = resolve(ROOT, "mcp-server", "src", "tools", "batch-pay.ts");
const available = existsSync(PAY_PATH) && existsSync(QUOTE_PATH) && existsSync(BATCH_PATH);
const paySrc   = available ? readLF(PAY_PATH)   : "";
const quoteSrc = available ? readLF(QUOTE_PATH) : "";
const batchSrc = available ? readLF(BATCH_PATH) : "";

describe.skipIf(!available)("MCP tool descriptions match actual server policy", () => {
  describe("PAY_TOOL.description", () => {
    it("does NOT claim a blanket 'BNB-FOCUS SPRINT IS ACTIVE: only chain: bnb' policy", () => {
      // The blanket claim was an earlier sprint snapshot that survived
      // past BNB_FOCUS_MODE being flipped to false — it lies to the
      // agent because the runtime actually accepts the paid 9-chain
      // matrix.
      expect(paySrc).not.toMatch(/BNB-FOCUS SPRINT IS ACTIVE/);
      expect(paySrc).not.toMatch(/every other chain and RLUSD return an error/);
    });

    it("documents the trial → BNB-only restriction", () => {
      expect(paySrc).toMatch(/trial keys/i);
      expect(paySrc).toMatch(/TRIAL_BNB_ONLY/);
    });

    it("documents the multichain → full 9-chain matrix", () => {
      // v0.5.0+ renamed "Paid keys" → "Multichain keys" to match the
      // dashboard's scope label. Both terms accepted so a future re-rename
      // back to "Paid" doesn't churn this test.
      expect(paySrc).toMatch(/Multichain keys|Paid keys/i);
      expect(paySrc).toMatch(/avax.+bnb.+eth.+xlayer.+stable.+mantle.+injective.+monad.+scroll/i);
    });

    it("documents the Q402_TRIAL_API_KEY / Q402_MULTICHAIN_API_KEY split", () => {
      // v0.5.0 two-key model: env vars must be named in the description so
      // a user reading the tool catalogue understands which env powers what.
      expect(paySrc).toMatch(/Q402_TRIAL_API_KEY/);
      expect(paySrc).toMatch(/Q402_MULTICHAIN_API_KEY/);
      expect(paySrc).toMatch(/keyScope/);
    });

    it("keeps the sandbox-by-default safety contract", () => {
      expect(paySrc).toMatch(/SANDBOX BY DEFAULT/);
      expect(paySrc).toMatch(/Q402_ENABLE_REAL_PAYMENTS=1/);
    });

    it("keeps the explicit-user-confirmation contract", () => {
      expect(paySrc).toMatch(/explicit user confirmation/);
    });
  });

  describe("QUOTE_TOOL.description", () => {
    it("does NOT claim a blanket BNB-only restriction", () => {
      expect(quoteSrc).not.toMatch(/results are currently restricted to BNB Chain/);
    });

    it("documents the 9-chain quote surface", () => {
      expect(quoteSrc).toMatch(/9 chains/);
      expect(quoteSrc).toMatch(/avax.+bnb.+eth.+xlayer.+stable.+mantle.+injective.+monad.+scroll/i);
    });

    it("notes that trial keys see a narrower view", () => {
      // v0.4.4+: quote tool doesn't read an API key, so it can't filter by
      // scope. The description now says so explicitly and tells the caller
      // to treat non-BNB rows as informational when using a Trial key.
      // Accept either the old "trial keys see BNB-only" wording or the
      // new "any non-BNB row as informational" wording.
      expect(quoteSrc).toMatch(/Trial[- ]tier|trial.+BNB[- ]only|Trial API Key/i);
      expect(quoteSrc).toMatch(/BNB/);
    });
  });

  describe("BATCH_PAY_TOOL.description (v0.4.7 unified routing + ambiguity gate)", () => {
    it("does NOT claim batches always pick Multichain", () => {
      // v0.4.6 wording. Replaced in 0.4.7 with the unified rule + ambiguity
      // gate so the description matches the actual auto-routing behavior.
      expect(batchSrc).not.toMatch(/ALWAYS picks (the )?Multichain/i);
      expect(batchSrc).not.toMatch(/ALWAYS routes batches to the (\s)*Multichain/i);
      expect(batchSrc).not.toMatch(/silently break(s)? 6\+ row batches/);
    });

    it("documents the unified auto-routing rule (same as q402_pay)", () => {
      // The auto rule: BNB + Q402_TRIAL_API_KEY set → Trial; else Multichain.
      // Must mention "same rule as q402_pay" so an agent reading either tool
      // description gets the same mental model. Names must both appear in
      // the source — order and case don't matter.
      expect(batchSrc).toMatch(/same rule as q402_pay/i);
      expect(batchSrc).toMatch(/BNB/i);
      expect(batchSrc).toMatch(/Q402_TRIAL_API_KEY/);
    });

    it("documents the ambiguity gate for 6+ recipient BNB batches", () => {
      // When auto would land on Trial AND the batch exceeds the Trial cap
      // (5), the tool must NOT execute — return status="ambiguous" and let
      // the agent ask the user. Pin the wording so a future refactor can't
      // silently bring back the v0.4.6 "always multichain" path.
      expect(batchSrc).toMatch(/status=?["']ambiguous["']|status: ?["']ambiguous["']/);
      expect(batchSrc).toMatch(/ambigui|ambiguous/i);
      expect(batchSrc).toMatch(/recipients\.length > 5|exceeds the Trial cap/i);
    });

    it("describes the three resolution paths for an ambiguous batch", () => {
      // Agent surfaces the choice list to the human. Must mention all three:
      // (a) trim to 5 with keyScope=trial, (b) all paid with keyScope=multichain,
      // (c) split via two calls.
      expect(batchSrc).toMatch(/keyScope=?["']trial["']/);
      expect(batchSrc).toMatch(/keyScope=?["']multichain["']/);
      expect(batchSrc).toMatch(/split|two calls/i);
    });

    it("keeps the recipient caps explicit (5 trial / 20 paid)", () => {
      expect(batchSrc).toMatch(/RECIPIENT_LIMIT_TRIAL.*5|max 5 recipients|5 recipients per call/);
      expect(batchSrc).toMatch(/RECIPIENT_LIMIT_PAID.*20|max 20 recipients|20 recipients per call/);
    });

    it("keeps the sandbox-by-default safety contract", () => {
      expect(batchSrc).toMatch(/SANDBOX BY DEFAULT/);
      expect(batchSrc).toMatch(/Q402_ENABLE_REAL_PAYMENTS=1/);
    });

    it("keeps the explicit-user-confirmation contract for batches", () => {
      expect(batchSrc).toMatch(/explicit user confirmation/);
      expect(batchSrc).toMatch(/full batch.*not the individual rows|individual rows/);
    });
  });
});
