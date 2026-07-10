/**
 * yield-bnb-lista-vault-drift.test.ts
 *
 * BNB yield (Lista Lending) settles into a curated Moolah ERC-4626 vault whose
 * address + the underlying stablecoin are HARD-CODED into the on-chain impl's
 * immutable allowlist (isAllowedVault / isAllowedAsset in
 * Q402PaymentImplementationBNBYieldErc4626.sol). The off-chain write path resolves
 * the SAME vault from lista.ts (listaVaultFor / LISTA_DEFAULT_VAULT). If either
 * drifts from the immutable on-chain allowlist, every BNB deposit reverts
 * (VaultNotAllowed / AssetNotAllowed) AFTER the relayer already paid gas. This test
 * pins them together.
 *
 * It also pins the ERC-4626 witness typehash strings byte-for-byte between the
 * off-chain signer (sign.ts) and the BNB contract — the fund-safety invariant: a
 * reordered/renamed field on either side makes every BNB yield witness fail to
 * recover on-chain and revert.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
// CRLF -> LF so the source-grep regexes work on fresh Windows checkouts too.
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const contractSrc = read("contracts/yield/Q402PaymentImplementationBNBYieldErc4626.sol");
const listaSrc = read("app/lib/yield/lista.ts");
const signSrc = read("app/lib/yield/sign.ts");

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

// BSC USDT/USDC, both 18-dec (USDT has no EIP-2612 permit).
const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
const BSC_USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";

const cVault = grab(/LISTA_USDT_VAULT\s*=\s*(0x[0-9a-fA-F]{40})/, contractSrc, "contract LISTA_USDT_VAULT").toLowerCase();
const cVaultUsdc = grab(/LISTA_USDC_VAULT\s*=\s*(0x[0-9a-fA-F]{40})/, contractSrc, "contract LISTA_USDC_VAULT").toLowerCase();
const cUsdt = grab(/constant\s+USDT\s*=\s*(0x[0-9a-fA-F]{40})/, contractSrc, "contract USDT").toLowerCase();
const cUsdc = grab(/constant\s+USDC\s*=\s*(0x[0-9a-fA-F]{40})/, contractSrc, "contract USDC").toLowerCase();

describe("BNB Lista yield: off-chain <-> on-chain drift guard", () => {
  it("contract LISTA_USDT_VAULT equals the off-chain default Lista USDT vault", () => {
    // First 0x address after a `USDT:` key in lista.ts is the LISTA_DEFAULT_VAULT
    // bnb USDT entry (the LISTA_ENV value is an env-var NAME, not a 0x address).
    const offVault = grab(/USDT:\s*"(0x[0-9a-fA-F]{40})"/, listaSrc, "LISTA_DEFAULT_VAULT.bnb.USDT").toLowerCase();
    expect(offVault).toBe(cVault);
  });

  it("contract USDT is BSC USDT (0x55d398…, 18-dec)", () => {
    expect(cUsdt).toBe(BSC_USDT);
  });

  it("contract LISTA_USDC_VAULT equals the off-chain default Lista USDC vault", () => {
    const offVault = grab(/USDC:\s*"(0x[0-9a-fA-F]{40})"/, listaSrc, "LISTA_DEFAULT_VAULT.bnb.USDC").toLowerCase();
    expect(offVault).toBe(cVaultUsdc);
  });

  it("contract USDC is BSC USDC (0x8AC76a…, 18-dec)", () => {
    expect(cUsdc).toBe(BSC_USDC);
  });

  it("contract domain name is the deployed BNB payment domain", () => {
    expect(contractSrc).toContain('"Q402 BNB Chain"');
  });

  it("ERC-4626 supply witness typehash is byte-identical off-chain and on the BNB impl", () => {
    const expected =
      "Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 minSharesOut,uint256 nonce,uint256 deadline)";
    expect(eip712TypeString(signSrc, "Erc4626SupplyAuthorization")).toBe(expected);
    expect(contractSrc).toContain(expected);
  });

  it("ERC-4626 withdraw witness typehash is byte-identical off-chain and on the BNB impl", () => {
    const expected =
      "Erc4626WithdrawAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 minAssetsOut,uint256 maxSharesBurned,uint256 nonce,uint256 deadline)";
    expect(eip712TypeString(signSrc, "Erc4626WithdrawAuthorization")).toBe(expected);
    expect(contractSrc).toContain(expected);
  });
});
