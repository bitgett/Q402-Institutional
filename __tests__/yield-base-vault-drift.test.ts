/**
 * yield-base-vault-drift.test.ts
 *
 * Base yield settles into a SINGLE curated Morpho vault whose address + the
 * underlying USDC are HARD-CODED into the on-chain impl's allowlist
 * (isAllowedVault / isAllowedAsset in Q402PaymentImplementationBASEv2.sol).
 * The off-chain path resolves the same vault from morpho.ts and the same USDC
 * from contracts.manifest.json. If either drifts from the immutable on-chain
 * allowlist, every Base deposit reverts (VaultNotAllowed / AssetNotAllowed)
 * AFTER the relayer already paid gas. This test pins them together.
 *
 * It ALSO pins the ERC-4626 witness typehash strings byte-for-byte between the
 * off-chain signer (sign.ts) and the contract. A single reordered/renamed field
 * on either side would make every Base yield witness fail to recover on-chain
 * and revert. That parity is the fund-safety invariant for the whole feature.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
// CRLF -> LF so the source-grep regexes work on fresh Windows checkouts too.
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const contractSrc = read("contracts/yield/Q402PaymentImplementationBASEv2.sol");
const morphoSrc = read("app/lib/yield/morpho.ts");
const signSrc = read("app/lib/yield/sign.ts");
const manifestSrc = read("contracts.manifest.json");

function grab(re: RegExp, src: string, label: string): string {
  const m = src.match(re);
  if (!m || !m[1]) throw new Error(`drift test could not locate ${label}`);
  return m[1];
}

/** Canonical EIP-712 type string from a viem-style `{ TypeName: [{name,type}...] }` block. */
function eip712TypeString(src: string, typeName: string): string {
  const block = grab(new RegExp(`${typeName}:\\s*\\[([\\s\\S]*?)\\]`), src, `${typeName} field list`);
  const fields = [...block.matchAll(/\{\s*name:\s*"(\w+)",\s*type:\s*"(\w+)"\s*\}/g)].map((mm) => `${mm[2]} ${mm[1]}`);
  return `${typeName}(${fields.join(",")})`;
}

const cVault = grab(/BASE_USDC_VAULT\s*=\s*(0x[0-9a-fA-F]{40})/, contractSrc, "contract BASE_USDC_VAULT").toLowerCase();
const cUsdc = grab(/constant\s+USDC\s*=\s*(0x[0-9a-fA-F]{40})/, contractSrc, "contract USDC").toLowerCase();

describe("Base Morpho yield: off-chain <-> on-chain drift guard", () => {
  it("contract BASE_USDC_VAULT equals the off-chain default Morpho base vault", () => {
    const offVault = grab(/base:\s*"(0x[0-9a-fA-F]{40})"/, morphoSrc, "MORPHO_DEFAULT_VAULT.base").toLowerCase();
    expect(offVault).toBe(cVault);
  });

  it("contract USDC is the manifest's native Base USDC (not bridged USDbC)", () => {
    expect(manifestSrc.toLowerCase()).toContain(cUsdc);
    expect(cUsdc).not.toBe("0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"); // legacy USDbC
  });

  it("ERC-4626 supply witness typehash is byte-identical off-chain and on-chain", () => {
    const expected =
      "Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 minSharesOut,uint256 nonce,uint256 deadline)";
    expect(eip712TypeString(signSrc, "Erc4626SupplyAuthorization")).toBe(expected);
    expect(contractSrc).toContain(expected);
  });

  it("ERC-4626 withdraw witness typehash is byte-identical off-chain and on-chain", () => {
    const expected =
      "Erc4626WithdrawAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 minAssetsOut,uint256 maxSharesBurned,uint256 nonce,uint256 deadline)";
    expect(eip712TypeString(signSrc, "Erc4626WithdrawAuthorization")).toBe(expected);
    expect(contractSrc).toContain(expected);
  });
});
