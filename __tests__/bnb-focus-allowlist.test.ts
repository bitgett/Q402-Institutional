/**
 * bnb-focus-allowlist.test.ts
 *
 * Sprint-scoped guard (2026-05-13 → 2026-05-20). While BNB_FOCUS_MODE is true,
 * every chain other than BNB and every token other than USDC/USDT on BNB must
 * be rejected by the same code paths that normally route them. The test reads
 * source files directly (not behaviour at runtime) because the sprint is
 * deliberately a no-op when the flag is off — flipping BNB_FOCUS_MODE back to
 * false on `main` removes every guard below without changing call surfaces.
 *
 * Five surfaces are checked in lockstep:
 *   1. app/lib/feature-flags.ts — BNB_FOCUS_MODE flag + helper functions
 *   2. app/api/relay/route.ts   — SPRINT_CHAIN_TOKEN_ALLOWLIST + error message
 *   3. public/q402-sdk.js       — Q402_BNB_FOCUS_MODE + post-config rewrite
 *   4. app/components/Hero.tsx  — UI narrative narrowed to BNB-only
 *   5. mcp-server/src/chains.ts — BNB_FOCUS_MODE export + rewrite block
 *      (skipped when mcp-server/ is absent — see rlusd-cross-chain-guard.test.ts
 *      for the same skip pattern.)
 *
 * If any of these drift, the relay rejects calls the SDK happily signs (worst
 * UX) or the SDK refuses to sign requests the server would have accepted
 * (silent UX). The single import-surface boundary is the BNB_FOCUS_MODE
 * constant in feature-flags.ts — that boolean is the rollback lever.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BNB_FOCUS_MODE,
  BNB_FOCUS_REJECTION_MESSAGE,
  getSprintAllowedChains,
  getSprintAllowedTokens,
} from "../app/lib/feature-flags";

const ROOT = resolve(__dirname, "..");
const flagsSource = readFileSync(resolve(ROOT, "app", "lib", "feature-flags.ts"), "utf8");
const routeSource = readFileSync(resolve(ROOT, "app", "api", "relay", "route.ts"), "utf8");
const sdkSource = readFileSync(resolve(ROOT, "public", "q402-sdk.js"), "utf8");
const heroSource = readFileSync(resolve(ROOT, "app", "components", "Hero.tsx"), "utf8");
const trustedBySource = readFileSync(
  resolve(ROOT, "app", "components", "TrustedBy.tsx"),
  "utf8",
);

function tryRead(...segments: string[]): string | null {
  try {
    return readFileSync(resolve(ROOT, ...segments), "utf8");
  } catch {
    return null;
  }
}
const mcpChainsSource = tryRead("mcp-server", "src", "chains.ts");
const mcpPayToolSource = tryRead("mcp-server", "src", "tools", "pay.ts");
const mcpAvailable = mcpChainsSource !== null && mcpPayToolSource !== null;

if (process.env.CI === "true" && !mcpAvailable) {
  throw new Error(
    "[bnb-focus-allowlist] CI=true but mcp-server/ is missing — the .github/workflows/ci.yml " +
      "step that clones bitgett/q402-mcp didn't run or failed. Without it the sprint guard " +
      "would be silently skipped, which defeats the purpose. Aborting.",
  );
}

const NON_BNB_CHAINS = ["avax", "eth", "xlayer", "stable", "mantle", "injective"] as const;

describe("BNB-focus sprint — feature-flags.ts (single source of truth)", () => {
  it("BNB_FOCUS_MODE is the live sprint flag (currently true on this branch)", () => {
    expect(BNB_FOCUS_MODE).toBe(true);
  });

  it("rejection message references the sprint and is non-empty", () => {
    expect(typeof BNB_FOCUS_REJECTION_MESSAGE).toBe("string");
    expect(BNB_FOCUS_REJECTION_MESSAGE.length).toBeGreaterThan(20);
    expect(BNB_FOCUS_REJECTION_MESSAGE).toMatch(/sprint/i);
  });

  it("getSprintAllowedChains() returns ['bnb'] while flag is on", () => {
    expect(Array.from(getSprintAllowedChains())).toEqual(["bnb"]);
  });

  it("getSprintAllowedTokens('bnb') returns ['USDC','USDT']", () => {
    expect(Array.from(getSprintAllowedTokens("bnb"))).toEqual(["USDC", "USDT"]);
  });

  it.each(NON_BNB_CHAINS)(
    "getSprintAllowedTokens(%s) is empty (no tokens routable while flag is on)",
    (chain) => {
      expect(Array.from(getSprintAllowedTokens(chain))).toEqual([]);
    },
  );

  it("source file exports the flag (so other modules can import it for inline gating)", () => {
    expect(flagsSource).toMatch(/export\s+const\s+BNB_FOCUS_MODE\s*=/);
    expect(flagsSource).toMatch(/export\s+const\s+BNB_FOCUS_REJECTION_MESSAGE\s*=/);
  });
});

describe("BNB-focus sprint — relay route gating", () => {
  it("imports BNB_FOCUS_MODE from feature-flags (same source as everywhere else)", () => {
    expect(routeSource).toMatch(/import\s*\{[^}]*BNB_FOCUS_MODE[^}]*\}\s*from\s*["']@\/app\/lib\/feature-flags["']/);
  });

  it("declares SPRINT_CHAIN_TOKEN_ALLOWLIST with bnb → ['USDC','USDT']", () => {
    expect(routeSource).toMatch(/SPRINT_CHAIN_TOKEN_ALLOWLIST/);
    const m = routeSource.match(
      /SPRINT_CHAIN_TOKEN_ALLOWLIST[\s\S]*?bnb:\s*\[([^\]]+)\]/,
    );
    expect(m, "sprint allowlist should declare bnb entry").not.toBeNull();
    const tokens = m![1].split(",").map(s => s.trim().replace(/['"]/g, ""));
    expect(tokens).toEqual(["USDC", "USDT"]);
  });

  it.each(NON_BNB_CHAINS)(
    "SPRINT_CHAIN_TOKEN_ALLOWLIST does NOT enumerate %s (omitting = effective rejection)",
    (chain) => {
      const m = routeSource.match(
        new RegExp(`SPRINT_CHAIN_TOKEN_ALLOWLIST[\\s\\S]*?${chain}:\\s*\\[`),
      );
      expect(m, `sprint allowlist must not list ${chain}`).toBeNull();
    },
  );

  it("retains FULL_CHAIN_TOKEN_ALLOWLIST verbatim for one-flag rollback", () => {
    expect(routeSource).toMatch(/FULL_CHAIN_TOKEN_ALLOWLIST/);
    // Sanity: the multichain table still lists eth + RLUSD so reverting the
    // flag immediately routes eth/RLUSD again with zero code edits.
    expect(routeSource).toMatch(
      /FULL_CHAIN_TOKEN_ALLOWLIST[\s\S]*?eth:\s*\[\s*["']USDC["']\s*,\s*["']USDT["']\s*,\s*["']RLUSD["']\s*\]/,
    );
  });

  it("active CHAIN_TOKEN_ALLOWLIST is chosen via BNB_FOCUS_MODE ternary", () => {
    expect(routeSource).toMatch(
      /CHAIN_TOKEN_ALLOWLIST\s*=\s*BNB_FOCUS_MODE\s*\?\s*SPRINT_CHAIN_TOKEN_ALLOWLIST\s*:\s*FULL_CHAIN_TOKEN_ALLOWLIST/,
    );
  });

  it("surfaces BNB_FOCUS_REJECTION_MESSAGE in the rejection path", () => {
    expect(routeSource).toMatch(/BNB_FOCUS_REJECTION_MESSAGE/);
  });
});

describe("BNB-focus sprint — SDK (browser, no module imports)", () => {
  it("declares Q402_BNB_FOCUS_MODE constant set to true", () => {
    expect(sdkSource).toMatch(/const\s+Q402_BNB_FOCUS_MODE\s*=\s*true/);
  });

  it("declares Q402_BNB_FOCUS_REJECTION_MESSAGE that references the sprint", () => {
    expect(sdkSource).toMatch(/Q402_BNB_FOCUS_REJECTION_MESSAGE/);
    expect(sdkSource).toMatch(/BNB-focus sprint[\s\S]*temporarily hidden/);
  });

  it("retains the bnb chain entry with ['USDC','USDT']", () => {
    const m = sdkSource.match(
      /bnb:\s*\{[\s\S]*?supportedTokens:\s*\[([^\]]+)\][\s\S]*?\}/,
    );
    expect(m).not.toBeNull();
    const tokens = m![1].split(",").map(s => s.trim().replace(/['"]/g, ""));
    expect(tokens).toEqual(["USDC", "USDT"]);
  });

  it("contains the post-config rewrite block that zeros non-BNB supportedTokens", () => {
    expect(sdkSource).toMatch(
      /if\s*\(\s*Q402_BNB_FOCUS_MODE\s*\)\s*\{[\s\S]*?Q402_CHAIN_CONFIG\[c\]\.supportedTokens\s*=\s*\[\][\s\S]*?\}/,
    );
  });

  it("pay() throws Q402_BNB_FOCUS_REJECTION_MESSAGE during sprint", () => {
    expect(sdkSource).toMatch(
      /if\s*\(\s*Q402_BNB_FOCUS_MODE\s*\)\s*\{\s*throw\s+new\s+Error\(\s*Q402_BNB_FOCUS_REJECTION_MESSAGE\s*\)/,
    );
  });
});

describe("BNB-focus sprint — UI surfaces import the shared flag", () => {
  it("Hero.tsx imports BNB_FOCUS_MODE from feature-flags", () => {
    expect(heroSource).toMatch(
      /import\s*\{\s*BNB_FOCUS_MODE\s*\}\s*from\s*["']@\/app\/lib\/feature-flags["']/,
    );
  });

  it("TrustedBy.tsx imports BNB_FOCUS_MODE and filters chains via SPRINT_ALLOWED", () => {
    expect(trustedBySource).toMatch(
      /import\s*\{\s*BNB_FOCUS_MODE\s*\}\s*from\s*["']@\/app\/lib\/feature-flags["']/,
    );
    expect(trustedBySource).toMatch(/SPRINT_ALLOWED/);
  });
});

describe.skipIf(!mcpAvailable)("BNB-focus sprint — MCP server (skipped when mcp-server/ is absent)", () => {
  it("chains.ts exports BNB_FOCUS_MODE set to true", () => {
    expect(mcpChainsSource).toMatch(
      /export\s+const\s+BNB_FOCUS_MODE\s*=\s*true/,
    );
  });

  it("chains.ts post-config block zeros every non-bnb supportedTokens", () => {
    expect(mcpChainsSource).toMatch(
      /if\s*\(\s*BNB_FOCUS_MODE\s*\)\s*\{[\s\S]*?key\s*!==\s*["']bnb["'][\s\S]*?supportedTokens\s*=\s*\[\]/,
    );
  });

  it("chains.ts tokenFor() throws BNB_FOCUS_REJECTION_MESSAGE when flag is on and token not allowed", () => {
    expect(mcpChainsSource).toMatch(/BNB_FOCUS_REJECTION_MESSAGE/);
    expect(mcpChainsSource).toMatch(/throw\s+new\s+Error\(\s*BNB_FOCUS_REJECTION_MESSAGE\s*\)/);
  });

  it("PAY_TOOL description mentions the sprint so the model surfaces it to the user", () => {
    expect(mcpPayToolSource).toMatch(/BNB-FOCUS SPRINT/i);
  });
});
