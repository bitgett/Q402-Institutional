/**
 * mcp-package-drift.test.ts
 *
 * @quackai/q402-mcp ships from a separate repo (github.com/bitgett/q402-mcp)
 * and a separate npm package, so neither this repo's CI nor a normal lockfile
 * bump catches the case where the MCP server's chain registry drifts from
 * contracts.manifest.json. That happened during the Mantle rollout (we caught
 * it manually) and would happen again the next time we add a chain, rotate an
 * impl, or change a token alias.
 *
 * This test fetches the published mcp-server's `src/chains.ts` straight from
 * GitHub raw and verifies, for every supported chain, that:
 *   - chainId matches the manifest
 *   - implContract matches the manifest (case-insensitive)
 *   - USDC + USDT token addresses match (case-insensitive)
 *   - the EIP-712 domain name matches
 *   - chain-level token gates (e.g. injective: USDT-only) are preserved
 *
 * If the network is unreachable the test soft-fails with a console.warn rather
 * than a red CI run — the goal is to catch real drift, not flap on flaky
 * connectivity. A future run on a healthy network will surface the issue.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RAW_URL = "https://raw.githubusercontent.com/bitgett/q402-mcp/main/src/chains.ts";

interface ManifestToken { address: string; decimals: number }
interface ManifestChain {
  chainId: number;
  implContract: string;
  witness: { domainName: string };
  tokens: Record<string, ManifestToken>;
  supportedApiTokens?: string[];
}
interface Manifest { chains: Record<string, ManifestChain> }

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "contracts.manifest.json"), "utf8"),
) as Manifest;

const CHAINS = ["avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective"] as const;

let mcpSource: string | null = null;
let fetchError: string | null = null;

// One-shot fetch shared across test cases. Network calls happen inside the
// describe.beforeAll so every assertion below has the same source string.
async function loadMcpChainsSource(): Promise<void> {
  if (mcpSource !== null || fetchError !== null) return;
  try {
    const resp = await fetch(RAW_URL);
    if (!resp.ok) {
      fetchError = `HTTP ${resp.status} fetching ${RAW_URL}`;
      return;
    }
    mcpSource = await resp.text();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }
}

function skipIfOffline(): boolean {
  if (mcpSource) return false;
  console.warn(`[mcp-package-drift] skipping — could not fetch chains.ts (${fetchError ?? "unknown"})`);
  return true;
}

/**
 * Pulls the value of `<field>: "<value>"` (or `<field>: <number>`) from inside
 * the chains.ts entry for `<chain>`. The published source is hand-written so
 * a tolerant regex is enough — no AST parser dependency.
 */
function extractField(src: string, chain: string, field: string): string | null {
  // Match `<chain>: { ... <field>: <value>, ... }` non-greedily.
  const blockRe = new RegExp(
    `${chain}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*,?`,
  );
  const block = src.match(blockRe)?.[1];
  if (!block) return null;
  // value can be a quoted string or a bare number — capture both forms.
  const valRe = new RegExp(`${field}:\\s*(?:"([^"]+)"|(\\d+))`);
  const m = block.match(valRe);
  return m?.[1] ?? m?.[2] ?? null;
}

function extractTokenAddress(src: string, chain: string, token: "usdc" | "usdt"): string | null {
  const blockRe = new RegExp(
    `${chain}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*,?`,
  );
  const block = src.match(blockRe)?.[1];
  if (!block) return null;
  const addrRe = new RegExp(`${token}:\\s*\\{[\\s\\S]*?address:\\s*"(0x[0-9a-fA-F]+)"`);
  return block.match(addrRe)?.[1] ?? null;
}

describe("@quackai/q402-mcp drift guard (chains.ts ↔ contracts.manifest.json)", () => {
  it("fetches the published mcp-server source", async () => {
    await loadMcpChainsSource();
    if (!mcpSource) {
      // soft-skip on offline CI — the rest of the cases will warn-and-pass
      console.warn(`[mcp-package-drift] offline — ${fetchError}`);
      return;
    }
    expect(mcpSource.length).toBeGreaterThan(500);
    expect(mcpSource).toContain("export const CHAIN_CONFIG");
  });

  it.each(CHAINS)("%s: chainId matches manifest", async chain => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    const m = manifest.chains[chain];
    const observed = extractField(mcpSource!, chain, "chainId");
    expect(observed, `chainId not extractable from mcp-server chains.ts for ${chain}`).not.toBeNull();
    expect(Number(observed)).toBe(m.chainId);
  });

  it.each(CHAINS)("%s: implContract matches manifest", async chain => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    const m = manifest.chains[chain];
    const observed = extractField(mcpSource!, chain, "implContract");
    expect(observed, `implContract not extractable for ${chain}`).not.toBeNull();
    expect(observed!.toLowerCase()).toBe(m.implContract.toLowerCase());
  });

  it.each(CHAINS)("%s: domainName matches manifest", async chain => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    const m = manifest.chains[chain];
    const observed = extractField(mcpSource!, chain, "domainName");
    expect(observed, `domainName not extractable for ${chain}`).not.toBeNull();
    expect(observed).toBe(m.witness.domainName);
  });

  it.each(CHAINS)("%s: USDC + USDT token addresses match manifest", async chain => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    const m = manifest.chains[chain];
    const usdc = extractTokenAddress(mcpSource!, chain, "usdc");
    const usdt = extractTokenAddress(mcpSource!, chain, "usdt");
    expect(usdc, `usdc.address missing for ${chain}`).not.toBeNull();
    expect(usdt, `usdt.address missing for ${chain}`).not.toBeNull();
    expect(usdc!.toLowerCase()).toBe(m.tokens.USDC.address.toLowerCase());
    expect(usdt!.toLowerCase()).toBe(m.tokens.USDT.address.toLowerCase());
  });

  it("Injective declares supportedTokens: [\"USDT\"] in chains.ts", async () => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    // The supportedTokens whitelist is the SDK + MCP gate that mirrors the
    // manifest's supportedApiTokens. Easier to grep than to extract structurally.
    expect(mcpSource).toMatch(/injective:\s*\{[\s\S]*?supportedTokens:\s*\[\s*"USDT"\s*\][\s\S]*?\}/);
  });
});
