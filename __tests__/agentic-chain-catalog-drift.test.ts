/**
 * agentic-chain-catalog-drift.test.ts
 *
 * Drift guard between the 4 places that mirror the chain catalog:
 *
 *   1. contracts.manifest.json — declared source of truth (per the
 *      file's own header).
 *   2. app/lib/relayer.ts::CHAIN_CONFIG — used by the canonical relay
 *      route (`/api/relay`) for landing-side settlement.
 *   3. app/lib/agentic-wallet-sign.ts::AGENTIC_CHAINS — used by the
 *      Mode A/B/C agent-wallet signer when /api/wallet/agentic/send
 *      delegates into the relay.
 *   4. mcp-server/src/chains.ts — read-side catalog the MCP tools
 *      use (q402_quote, q402_balance, q402_wallet_status, …).
 *
 * The existing `contracts-manifest.test.ts` validates 1 ↔ 2 + 1 ↔ SDK.
 * This file extends the guard to 1 ↔ 3 (so a manifest impl-address
 * rotation can't leave the Mode C signer behind, silently producing
 * authorisations the relay then rejects with `AUTHORIZATION_GUARD`).
 * The MCP catalog (4) is checked when present — sibling-repo mode.
 *
 * Drift here is hard to catch otherwise because Mode C calls live
 * server-side, only get exercised when MCP holders settle, and the
 * relay route's own authorisation guard converts the drift into an
 * opaque 400 rather than naming the offending file.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import manifest from "../contracts.manifest.json";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";

// ── Type narrowing for the manifest JSON (it's a JSON literal so all
//    fields are typed open) ─────────────────────────────────────────────
interface ManifestChain {
  name: string;
  chainId: number;
  implContract: string;
  witness?: { domainName?: string; domainVersion?: string };
  tokens: Record<string, { address: string; decimals: number }>;
}
const manifestChains = manifest.chains as Record<string, ManifestChain>;

describe("manifest ↔ agentic-wallet-sign drift", () => {
  it("AGENTIC_CHAINS covers every manifest chain", () => {
    for (const key of Object.keys(manifestChains)) {
      expect(AGENTIC_CHAINS).toHaveProperty(key);
    }
  });

  it.each(Object.keys(manifestChains))(
    "%s: chainId / impl / domainName / token addresses match manifest",
    (key) => {
      const m = manifestChains[key];
      const a = AGENTIC_CHAINS[key as keyof typeof AGENTIC_CHAINS];
      expect(a.id, `chainId mismatch on ${key}`).toBe(m.chainId);
      expect(a.impl.toLowerCase(), `impl contract mismatch on ${key}`).toBe(
        m.implContract.toLowerCase(),
      );
      // Domain name is signing-critical — a mismatch produces a valid
      // signature against the wrong EIP-712 domain, silently invalid
      // at relay verify time.
      if (m.witness?.domainName) {
        expect(a.domainName, `domain name mismatch on ${key}`).toBe(m.witness.domainName);
      }
      if (m.witness?.domainVersion) {
        expect(a.domainVersion, `domain version mismatch on ${key}`).toBe(
          m.witness.domainVersion,
        );
      }
      // Token addresses + decimals. A decimals drift on Stable's
      // 18-dec USDT0 vs Mantle's 6-dec USDT would silently scale a
      // user's amount by 10^12 in either direction.
      for (const [tok, t] of Object.entries(m.tokens)) {
        const aTok = (a.tokens as Record<string, { address: string; decimals: number }>)[tok];
        if (!aTok) continue; // chain×token allowlist enforced server-side
        expect(aTok.address.toLowerCase(), `${key}/${tok} address mismatch`).toBe(
          t.address.toLowerCase(),
        );
        expect(aTok.decimals, `${key}/${tok} decimals mismatch`).toBe(t.decimals);
      }
    },
  );
});

// MCP-side catalog lives in a sibling repo (`mcp-server/`) that is
// gitignored in the landing repo. Skip cleanly when it's not present.
function readMcpChainsOrNull(): string | null {
  const p = resolve(__dirname, "..", "mcp-server", "src", "chains.ts");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

describe("manifest ↔ mcp-server chains drift (sibling repo)", () => {
  const mcpSrc = readMcpChainsOrNull();

  it.skipIf(mcpSrc === null)(
    "every manifest chain's impl address + chainId appears in mcp-server/src/chains.ts",
    () => {
      if (!mcpSrc) return; // appease TS; skipIf handles the runtime side
      for (const [key, m] of Object.entries(manifestChains)) {
        // Loose check: the address (case-insensitive) shows up
        // somewhere in the MCP catalog. Tight per-field comparison
        // would require importing the MCP source as TS which the
        // landing tsconfig doesn't currently include.
        const addrRe = new RegExp(m.implContract.slice(2), "i");
        expect(
          addrRe.test(mcpSrc),
          `MCP catalog missing impl address for ${key} (${m.implContract})`,
        ).toBe(true);
        expect(
          new RegExp(`\\b${m.chainId}\\b`).test(mcpSrc),
          `MCP catalog missing chainId ${m.chainId} for ${key}`,
        ).toBe(true);
      }
    },
  );
});
