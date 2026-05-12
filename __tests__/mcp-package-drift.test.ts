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
 * To prove the *currently published* package matches this repo (not just the
 * GitHub main branch — those can drift in either direction), we resolve the
 * latest npm version first, then fetch `src/chains.ts` at the matching git
 * tag (e.g. v0.1.3). That ties the assertion to the artifact users actually
 * install via `npx -y @quackai/q402-mcp`.
 *
 * For every supported chain we verify:
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

const NPM_LATEST_URL = "https://registry.npmjs.org/@quackai/q402-mcp/latest";
function rawUrlFor(version: string): string {
  return `https://raw.githubusercontent.com/bitgett/q402-mcp/v${version}/src/chains.ts`;
}

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
let mcpVersion: string | null = null;
let fetchError: string | null = null;

// One-shot fetch shared across test cases. Network calls happen inside the
// describe.beforeAll so every assertion below has the same source string.
// Retry network fetches up to 3 times with 500ms / 1500ms / 4500ms backoff —
// transient npm registry or raw.githubusercontent.com hiccups shouldn't
// downgrade a real drift detection to a warn-and-pass.
async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url);
      // 2xx → return; 5xx → retry (transient); 4xx → return (real failure, no retry)
      if (resp.ok || (resp.status >= 400 && resp.status < 500)) return resp;
      lastErr = new Error(`HTTP ${resp.status} on ${url}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(3, i)));
    }
  }
  throw lastErr ?? new Error(`fetch failed after ${attempts} attempts: ${url}`);
}

async function loadMcpChainsSource(): Promise<void> {
  if (mcpSource !== null || fetchError !== null) return;
  try {
    // Step 1: ask npm for the currently published version.
    const npmResp = await fetchWithRetry(NPM_LATEST_URL);
    if (!npmResp.ok) {
      fetchError = `HTTP ${npmResp.status} fetching ${NPM_LATEST_URL}`;
      return;
    }
    const npmJson = (await npmResp.json()) as { version?: string };
    if (!npmJson.version) {
      fetchError = "npm 'latest' record had no version field";
      return;
    }
    mcpVersion = npmJson.version;

    // Step 2: fetch chains.ts at that exact git tag.
    const rawUrl = rawUrlFor(mcpVersion);
    const resp = await fetchWithRetry(rawUrl);
    if (!resp.ok) {
      fetchError = `HTTP ${resp.status} fetching ${rawUrl} (no git tag for v${mcpVersion}?)`;
      return;
    }
    mcpSource = await resp.text();
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }
}

// On CI we want a real drift to surface as a red build, not a warning. Local
// dev keeps the soft-skip so developers without network access (planes,
// internal-only environments) aren't blocked. The CI / local split is what
// closes the previous "environment problem looks identical to a real drift"
// trapdoor that the external reviewer flagged.
function skipIfOffline(): boolean {
  if (mcpSource) return false;
  const message = `[mcp-package-drift] could not fetch chains.ts (${fetchError ?? "unknown"})`;
  if (process.env.CI === "true") {
    throw new Error(
      `${message} — CI=true requires the drift guard to fetch successfully. ` +
      "Retried 3 times with backoff. If npm or raw.githubusercontent.com is " +
      "down, re-run the workflow; do not bypass the check.",
    );
  }
  console.warn(`${message} (skipping — set CI=true to hard-fail)`);
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

function extractTokenAddress(src: string, chain: string, token: "usdc" | "usdt" | "rlusd"): string | null {
  const blockRe = new RegExp(
    `${chain}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*,?`,
  );
  const block = src.match(blockRe)?.[1];
  if (!block) return null;
  const addrRe = new RegExp(`${token}:\\s*\\{[\\s\\S]*?address:\\s*"(0x[0-9a-fA-F]+)"`);
  return block.match(addrRe)?.[1] ?? null;
}

function extractTokenDecimals(src: string, chain: string, token: "usdc" | "usdt" | "rlusd"): number | null {
  const blockRe = new RegExp(
    `${chain}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*,?`,
  );
  const block = src.match(blockRe)?.[1];
  if (!block) return null;
  const decRe = new RegExp(`${token}:\\s*\\{[\\s\\S]*?decimals:\\s*(\\d+)`);
  const m = block.match(decRe);
  return m ? Number(m[1]) : null;
}

describe("@quackai/q402-mcp drift guard (chains.ts ↔ contracts.manifest.json)", () => {
  it("resolves the npm-published version and fetches its tagged source", async () => {
    await loadMcpChainsSource();
    if (!mcpSource) {
      // soft-skip on offline CI — the rest of the cases will warn-and-pass
      console.warn(`[mcp-package-drift] offline — ${fetchError}`);
      return;
    }
    expect(mcpVersion, "npm latest must report a version").toBeTruthy();
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

  // ── RLUSD Ethereum-only invariant (cross-repo drift guard) ──────────────
  // RLUSD is the third stablecoin Q402 supports, listed only on Ethereum.
  // The previously published MCP version must keep its eth.rlusd entry in
  // sync with this repo's manifest, or the SDK / MCP gates diverge for
  // RLUSD callers. Each assertion is a separate it() so the failure tells
  // you exactly which dimension drifted.
  it("eth.rlusd.address matches manifest.chains.eth.tokens.RLUSD.address", async () => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    const manifestRlusd = manifest.chains.eth.tokens.RLUSD;
    expect(manifestRlusd, "manifest.chains.eth.tokens.RLUSD must exist").toBeDefined();
    const observed = extractTokenAddress(mcpSource!, "eth", "rlusd");
    expect(observed, "rlusd.address must be extractable from mcp-server chains.ts").not.toBeNull();
    expect(observed!.toLowerCase()).toBe(manifestRlusd.address.toLowerCase());
  });

  it("eth.rlusd.decimals is 18", async () => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    const observed = extractTokenDecimals(mcpSource!, "eth", "rlusd");
    expect(observed, "rlusd.decimals must be extractable from mcp-server chains.ts").not.toBeNull();
    expect(observed).toBe(18);
    expect(manifest.chains.eth.tokens.RLUSD.decimals).toBe(18);
  });

  it('eth supportedTokens === ["USDC","USDT","RLUSD"] in chains.ts', async () => {
    await loadMcpChainsSource();
    if (skipIfOffline()) return;
    // Source-level grep — keep in step with the manifest + SDK + relay route
    // allowlist. If RLUSD is ever removed here without removing it from the
    // manifest's eth.tokens entry, this test catches the asymmetry.
    expect(mcpSource).toMatch(/eth:\s*\{[\s\S]*?supportedTokens:\s*\[\s*"USDC"\s*,\s*"USDT"\s*,\s*"RLUSD"\s*\][\s\S]*?\}/);
  });
});
