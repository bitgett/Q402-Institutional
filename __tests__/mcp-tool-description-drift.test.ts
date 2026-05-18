/**
 * mcp-tool-description-drift.test.ts
 *
 * MCP tool descriptions are what the agent reads to decide how/whether
 * to call a tool. If the description says "BNB-FOCUS SPRINT IS ACTIVE:
 * only chain: bnb" but the server actually accepts the full 7-chain
 * matrix for paid keys, the agent will refuse legitimate calls (or
 * worse, try to "correct" the user's intent).
 *
 * Earlier revisions of pay.ts + quote.ts hard-coded the BNB-only claim
 * even after BNB_FOCUS_MODE flipped to false. This test pins the
 * descriptions to match the actual per-tier policy:
 *
 *   - Trial keys → BNB only (server returns TRIAL_BNB_ONLY otherwise)
 *   - Paid keys  → full 7-chain matrix (avax, bnb, eth, xlayer, stable,
 *                  mantle, injective), USDC/USDT broadly, RLUSD on
 *                  Ethereum only, Injective USDT-only.
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
const available = existsSync(PAY_PATH) && existsSync(QUOTE_PATH);
const paySrc   = available ? readLF(PAY_PATH)   : "";
const quoteSrc = available ? readLF(QUOTE_PATH) : "";

describe.skipIf(!available)("MCP tool descriptions match actual server policy", () => {
  describe("PAY_TOOL.description", () => {
    it("does NOT claim a blanket 'BNB-FOCUS SPRINT IS ACTIVE: only chain: bnb' policy", () => {
      // The blanket claim was an earlier sprint snapshot that survived
      // past BNB_FOCUS_MODE being flipped to false — it lies to the
      // agent because the runtime actually accepts the paid 7-chain
      // matrix.
      expect(paySrc).not.toMatch(/BNB-FOCUS SPRINT IS ACTIVE/);
      expect(paySrc).not.toMatch(/every other chain and RLUSD return an error/);
    });

    it("documents the trial → BNB-only restriction", () => {
      expect(paySrc).toMatch(/trial keys/i);
      expect(paySrc).toMatch(/TRIAL_BNB_ONLY/);
    });

    it("documents the multichain → full 7-chain matrix", () => {
      // v0.5.0+ renamed "Paid keys" → "Multichain keys" to match the
      // dashboard's scope label. Both terms accepted so a future re-rename
      // back to "Paid" doesn't churn this test.
      expect(paySrc).toMatch(/Multichain keys|Paid keys/i);
      expect(paySrc).toMatch(/avax.+bnb.+eth.+xlayer.+stable.+mantle.+injective/i);
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

    it("documents the 8-chain quote surface", () => {
      expect(quoteSrc).toMatch(/8 chains/);
      expect(quoteSrc).toMatch(/avax.+bnb.+eth.+xlayer.+stable.+mantle.+injective.+monad/i);
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
});
