import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Drift guard: the MCP escrow witness (EIP-712 type sets in
 * `mcp-server/src/tools/escrow.ts`) MUST stay byte-identical to the typehash
 * strings hard-coded in the DEPLOYED Q402EscrowVault / Q402EscrowLockImpl. A
 * signature is verified by recovering the signer over `keccak256("\x19\x01" ||
 * domainSeparator || structHash)`, and structHash begins with the typehash — so
 * if a field is added / reordered / renamed in the MCP without an identical
 * contract redeploy, the recovered signer diverges and EVERY lock / release /
 * dispute silently fails on-chain (bad-signature revert). This test fails first.
 *
 * GOLDEN below is verified byte-for-byte against the on-chain source on BNB
 * mainnet (2026-07-02): vault `0x56c2A0B1...1256`, lockImpl `0x1da993Ac...8a56`.
 *
 * The mcp-server package is a separate (gitignored) repo and the contract .sol
 * lives outside this repo, so we read the LOCAL mcp source when present
 * (developer machine, before an npm publish — exactly where drift is introduced)
 * and soft-skip on CI where it is absent. `escrow-contracts.ts` IS in this repo,
 * so its domain-name check always runs.
 */

// Verified against the deployed contracts (concatenated Solidity typehash strings).
const GOLDEN_TYPES: Record<string, string> = {
  EscrowLock:
    "EscrowLock(address buyer,address seller,address vault,address token,uint256 amount,bytes32 salt,uint256 releaseDeadline,address arbiter,address facilitator,uint256 nonce,uint256 deadline)",
  EscrowRelease: "EscrowRelease(bytes32 escrowId,uint256 nonce,uint256 deadline)",
  EscrowDispute: "EscrowDispute(bytes32 escrowId,uint256 nonce,uint256 deadline)",
};
const GOLDEN_DOMAINS = { vault: "Q402 Escrow", lock: "Q402 Escrow Lock" };

const MCP_ESCROW = resolve(__dirname, "../mcp-server/src/tools/escrow.ts");
const CONTRACTS = resolve(__dirname, "../app/lib/escrow-contracts.ts");

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Reconstruct the EIP-712 type string from an MCP `{ name, type }[]` block —
 * this is exactly the string ethers hashes for the typehash, so matching it to
 * GOLDEN proves the on-the-wire signature will verify on-chain.
 */
function typeStringFrom(src: string, typeName: string): string | null {
  const block = src.match(new RegExp(`${typeName}:\\s*\\[([\\s\\S]*?)\\]`))?.[1];
  if (!block) return null;
  const fields = [...block.matchAll(/\{\s*name:\s*"(\w+)",\s*type:\s*"(\w+)"\s*\}/g)].map(
    m => `${m[2]} ${m[1]}`,
  );
  if (fields.length === 0) return null;
  return `${typeName}(${fields.join(",")})`;
}

describe("escrow MCP witness <-> deployed contract typehash drift guard", () => {
  const src = readIfPresent(MCP_ESCROW);

  it("mcp escrow source present, or soft-skip on CI (gitignored package)", () => {
    if (!src) {
      console.warn(
        "[escrow-witness-drift] mcp-server/src/tools/escrow.ts absent (separate gitignored repo) — witness checks skip on CI; they run locally before publish.",
      );
    }
    expect(true).toBe(true);
  });

  for (const [typeName, golden] of Object.entries(GOLDEN_TYPES)) {
    it(`${typeName} MCP type string == deployed typehash`, () => {
      if (!src) return; // soft-skip on CI
      const got = typeStringFrom(src, typeName);
      expect(got, `could not extract ${typeName} from mcp escrow.ts`).not.toBeNull();
      expect(got).toBe(golden);
    });
  }

  it("escrow-contracts.ts domain names == deployed NAME constants", () => {
    const c = readIfPresent(CONTRACTS);
    // this file is in-repo; if it moved the drift itself is the finding
    expect(c, "escrow-contracts.ts must exist").not.toBeNull();
    expect(c).toContain(`vaultDomainName: "${GOLDEN_DOMAINS.vault}"`);
    expect(c).toContain(`lockDomainName: "${GOLDEN_DOMAINS.lock}"`);
  });
});
