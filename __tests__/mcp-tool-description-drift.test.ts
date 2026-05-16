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

const ROOT = resolve(__dirname, "..");
const PAY_PATH   = resolve(ROOT, "mcp-server", "src", "tools", "pay.ts");
const QUOTE_PATH = resolve(ROOT, "mcp-server", "src", "tools", "quote.ts");
const available = existsSync(PAY_PATH) && existsSync(QUOTE_PATH);
const paySrc   = available ? readFileSync(PAY_PATH,   "utf8") : "";
const quoteSrc = available ? readFileSync(QUOTE_PATH, "utf8") : "";

describe.skipIf(!available)("MCP tool descriptions match actual server policy", () => {
  describe("PAY_TOOL.description", () => {
    it("does NOT claim a blanket 'BNB-FOCUS SPRINT IS ACTIVE: only chain: bnb' policy", () => {
      // The blanket claim is the bug Codex caught — it lies to the agent
      // when BNB_FOCUS_MODE is off, which it currently is.
      expect(paySrc).not.toMatch(/BNB-FOCUS SPRINT IS ACTIVE/);
      expect(paySrc).not.toMatch(/every other chain and RLUSD return an error/);
    });

    it("documents the trial → BNB-only restriction", () => {
      expect(paySrc).toMatch(/trial keys/i);
      expect(paySrc).toMatch(/TRIAL_BNB_ONLY/);
    });

    it("documents the paid → full 7-chain matrix", () => {
      expect(paySrc).toMatch(/Paid keys/i);
      expect(paySrc).toMatch(/avax.+bnb.+eth.+xlayer.+stable.+mantle.+injective/i);
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

    it("documents the 7-chain quote surface", () => {
      expect(quoteSrc).toMatch(/7 chains/);
      expect(quoteSrc).toMatch(/avax.+bnb.+eth.+xlayer.+stable.+mantle.+injective/i);
    });

    it("notes that trial keys see a narrower view", () => {
      expect(quoteSrc).toMatch(/Trial[- ]tier|trial.+BNB[- ]only/i);
    });
  });
});
