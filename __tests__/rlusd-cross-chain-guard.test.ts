/**
 * rlusd-cross-chain-guard.test.ts
 *
 * RLUSD (Ripple USD, NY DFS regulated, decimals 18) is supported ONLY on
 * Ethereum mainnet. The other 6 Q402 chains must reject `token: "RLUSD"`.
 * This file is the triplet check: SDK ↔ relay route ↔ contracts.manifest.
 *
 * Why a dedicated guard file:
 *   - RLUSD uses decimals 18 vs USDC/USDT's 6, so accidentally routing it
 *     to a chain that doesn't list RLUSD would either revert on-chain or
 *     send a wildly wrong raw amount.
 *   - Cross-chain stablecoin support (Wormhole NTT etc.) is a moving target
 *     in 2026; if a future PR adds RLUSD on Base or Arbitrum, this file is
 *     where the matrix gets updated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "contracts.manifest.json"), "utf8")
) as {
  chains: Record<string, { tokens: Record<string, { address: string; decimals: number }> }>;
};

const sdkSource = readFileSync(
  resolve(__dirname, "..", "public", "q402-sdk.js"),
  "utf8"
);

const routeSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
  "utf8"
);

const intentRouteSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "payment", "intent", "route.ts"),
  "utf8"
);

// MCP server lives in a separate repo (bitgett/q402-mcp) and the `mcp-server/`
// directory is .gitignore'd in this repo. On a local dev tree the working copy
// often sits as a sibling and the MCP-side assertions run; on a fresh clone
// they would normally be skipped.
//
// Skipping is acceptable in local dev (the MCP repo has its own tests + the
// published-version drift guard in `mcp-package-drift.test.ts`), but on CI it
// hides a real coverage gap. The CI workflow at .github/workflows/ci.yml
// clones the MCP repo before running the suite specifically so the assertions
// below execute. If anything goes wrong with that clone step, the explicit
// hard-fail here surfaces it instead of leaving the suite quietly green.
function tryRead(...segments: string[]): string | null {
  try {
    return readFileSync(resolve(__dirname, "..", ...segments), "utf8");
  } catch {
    return null;
  }
}
const mcpChainsSource    = tryRead("mcp-server", "src", "chains.ts");
const mcpPayToolSource   = tryRead("mcp-server", "src", "tools", "pay.ts");
const mcpQuoteToolSource = tryRead("mcp-server", "src", "tools", "quote.ts");
const mcpAvailable       = mcpChainsSource !== null && mcpPayToolSource !== null && mcpQuoteToolSource !== null;

// On CI we expect the workflow to have cloned the sibling MCP repo. If it
// didn't, fail loudly during the top-level describe registration so the
// reason is obvious in the run log (vs 11 silent skips).
if (process.env.CI === "true" && !mcpAvailable) {
  throw new Error(
    "[rlusd-cross-chain-guard] CI=true but mcp-server/ is missing — " +
    "the .github/workflows/ci.yml step that clones bitgett/q402-mcp " +
    "didn't run or failed. The MCP-side cross-chain guard would be " +
    "silently skipped, which defeats the purpose. Aborting.",
  );
}

const NON_ETH_CHAINS = ["avax", "bnb", "xlayer", "stable", "mantle", "injective"] as const;

describe("RLUSD: Ethereum-only invariant — manifest", () => {
  it("manifest.chains.eth.tokens.RLUSD exists with the canonical address + decimals 18", () => {
    const eth = manifest.chains.eth;
    expect(eth.tokens.RLUSD).toBeDefined();
    expect(eth.tokens.RLUSD.address.toLowerCase()).toBe(
      "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD".toLowerCase(),
    );
    expect(eth.tokens.RLUSD.decimals).toBe(18);
  });

  it.each(NON_ETH_CHAINS)("manifest.chains.%s.tokens has no RLUSD entry", (chain) => {
    const c = manifest.chains[chain];
    expect(c.tokens.RLUSD).toBeUndefined();
  });
});

describe("RLUSD: Ethereum-only invariant — SDK Q402_CHAIN_CONFIG", () => {
  it("SDK declares eth.rlusd with the canonical proxy address", () => {
    expect(sdkSource).toMatch(
      /eth:\s*\{[\s\S]*?rlusd:\s*\{\s*address:\s*["']0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD["']/i,
    );
  });

  it("SDK declares eth.supportedTokens including 'RLUSD'", () => {
    const m = sdkSource.match(
      /eth:\s*\{[\s\S]*?supportedTokens:\s*\[([^\]]+)\][\s\S]*?\}/,
    );
    expect(m, "SDK eth chain should declare supportedTokens").not.toBeNull();
    const tokens = m![1].split(",").map(s => s.trim().replace(/['"]/g, ""));
    expect(tokens).toEqual(["USDC", "USDT", "RLUSD"]);
  });

  it.each(NON_ETH_CHAINS)(
    "SDK %s.supportedTokens does NOT include RLUSD",
    (chain) => {
      const m = sdkSource.match(
        new RegExp(`${chain}:\\s*\\{[\\s\\S]*?supportedTokens:\\s*\\[([^\\]]+)\\][\\s\\S]*?\\}`),
      );
      expect(
        m,
        `SDK ${chain} chain should declare supportedTokens to actively gate RLUSD`,
      ).not.toBeNull();
      const tokens = m![1].split(",").map(s => s.trim().replace(/['"]/g, ""));
      expect(tokens).not.toContain("RLUSD");
    },
  );
});

describe("RLUSD: Ethereum-only invariant — relay route allowlist", () => {
  it("relay route's body type accepts RLUSD as a token symbol", () => {
    expect(routeSource).toMatch(/token:\s*"USDC"\s*\|\s*"USDT"\s*\|\s*"RLUSD"/);
  });

  it("relay route's CHAIN_TOKEN_ALLOWLIST lists RLUSD under eth", () => {
    expect(routeSource).toMatch(
      /eth:\s*\[\s*["']USDC["']\s*,\s*["']USDT["']\s*,\s*["']RLUSD["']\s*\]/,
    );
  });

  it.each(NON_ETH_CHAINS)(
    "relay route's CHAIN_TOKEN_ALLOWLIST does NOT list RLUSD under %s",
    (chain) => {
      // The allowlist entry for each non-eth chain should not mention RLUSD.
      // We extract the array literal and assert RLUSD is absent.
      const m = routeSource.match(
        new RegExp(`${chain}:\\s*\\[([^\\]]+)\\]`),
      );
      if (!m) {
        // If the chain has no entry at all, that's also acceptable (loose mode)
        // — but every chain we currently ship has an explicit entry, so flag it.
        throw new Error(
          `relay route should declare an explicit CHAIN_TOKEN_ALLOWLIST entry for ${chain}`,
        );
      }
      const tokens = m[1].split(",").map(s => s.trim().replace(/['"]/g, ""));
      expect(tokens).not.toContain("RLUSD");
    },
  );

  it("relay route surfaces a RLUSD-specific error message", () => {
    // The user-facing error should explicitly name RLUSD so integrators
    // see the constraint immediately, not a generic "unsupported token".
    expect(routeSource).toMatch(
      /RLUSD is only supported on Ethereum mainnet/,
    );
  });
});

describe("RLUSD: Ethereum-only invariant — subscription payment intent route", () => {
  // payment/intent is the subscription checkout entry point (separate from the
  // /api/relay path that handles end-user gasless settlements). The payment
  // page exposes eth-rlusd in PAY_TOKENS, so the intent route MUST also accept
  // RLUSD or the checkout drops 400 before any user signature.
  it("VALID_TOKENS includes RLUSD alongside USDC and USDT", () => {
    expect(intentRouteSource).toMatch(
      /VALID_TOKENS\s*=\s*\[\s*["']USDC["']\s*,\s*["']USDT["']\s*,\s*["']RLUSD["']\s*\]/,
    );
  });

  it("rejects RLUSD when chain is not eth (mirrors relay route's CHAIN_TOKEN_ALLOWLIST)", () => {
    // Source-level check that the cross-chain guard exists in the intent
    // route. The /api/relay path has its own guard; both must enforce the
    // same Ethereum-only invariant or one becomes an attack surface for
    // creating intents that the scanner can never match.
    expect(intentRouteSource).toMatch(
      /token\s*===\s*["']RLUSD["']\s*&&\s*chain\s*!==\s*["']eth["']/,
    );
    expect(intentRouteSource).toMatch(
      /RLUSD is only supported on Ethereum mainnet/,
    );
  });
});

describe.skipIf(!mcpAvailable)("RLUSD: Ethereum-only invariant — MCP server local source (skipped when mcp-server/ is absent)", () => {
  it("mcp-server chains.ts declares eth.rlusd with the canonical address + decimals 18", () => {
    expect(mcpChainsSource).toMatch(
      /eth:\s*\{[\s\S]*?rlusd:\s*\{\s*address:\s*["']0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD["']\s*,\s*decimals:\s*18\s*\}/i,
    );
  });

  it("mcp-server eth.supportedTokens includes RLUSD", () => {
    const m = mcpChainsSource!.match(
      /eth:\s*\{[\s\S]*?supportedTokens:\s*\[([^\]]+)\][\s\S]*?\}/,
    );
    expect(m, "MCP eth chain should declare supportedTokens").not.toBeNull();
    const tokens = m![1].split(",").map(s => s.trim().replace(/['"]/g, ""));
    expect(tokens).toEqual(["USDC", "USDT", "RLUSD"]);
  });

  it.each(NON_ETH_CHAINS)(
    "mcp-server %s.supportedTokens does NOT include RLUSD",
    (chain) => {
      const m = mcpChainsSource!.match(
        new RegExp(`${chain}:\\s*\\{[\\s\\S]*?supportedTokens:\\s*\\[([^\\]]+)\\][\\s\\S]*?\\}`),
      );
      expect(
        m,
        `MCP ${chain} chain should declare supportedTokens to gate RLUSD`,
      ).not.toBeNull();
      const tokens = m![1].split(",").map(s => s.trim().replace(/['"]/g, ""));
      expect(tokens).not.toContain("RLUSD");
    },
  );

  it("mcp-server tokenFor() throws when RLUSD is requested on a non-eth chain", () => {
    // Source-level check that the chain guard exists. Runtime semantics are
    // covered indirectly by the supportedTokens lists above (zod rejects the
    // request before tokenFor() is ever called), but the throw is the
    // belt-and-braces defense in case zod validation is skipped.
    expect(mcpChainsSource).toMatch(/RLUSD is currently Ethereum-only/);
  });

  it("MCP q402_pay tool accepts RLUSD in its token enum", () => {
    expect(mcpPayToolSource).toMatch(
      /token:\s*z\.enum\(\[\s*["']USDC["']\s*,\s*["']USDT["']\s*,\s*["']RLUSD["']\s*\]\)/,
    );
  });

  it("MCP q402_quote tool accepts RLUSD in its optional token filter", () => {
    expect(mcpQuoteToolSource).toMatch(
      /token:\s*z\s*\.enum\(\[\s*["']USDC["']\s*,\s*["']USDT["']\s*,\s*["']RLUSD["']\s*\]\)/,
    );
  });
});
