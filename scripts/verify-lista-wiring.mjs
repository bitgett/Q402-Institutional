/**
 * verify-lista-wiring.mjs — PRE-FLIP ops guard for the Lista (BNB ERC-4626) yield
 * venue. Run this BEFORE setting LISTA_YIELD_ENABLED=true.
 *
 * The footgun (spec MED-2): if LISTA_YIELD_ENABLED is flipped while YIELD_IMPL_BNB_LISTA
 * is unset or still points at the Aave impl (which has no supplyToErc4626), every BNB
 * Lista deposit signs an ERC-4626 witness, delegates to a non-ERC-4626 impl, and reverts
 * AFTER the relayer paid gas. In the coexistence design YIELD_IMPL_BNB stays the Aave
 * impl and the Lista ERC-4626 impl lives in its OWN env var YIELD_IMPL_BNB_LISTA (see
 * app/lib/yield/sign.ts yieldImplFor — lista resolves YIELD_IMPL_BNB_LISTA and never
 * falls back). This script asserts the wired YIELD_IMPL_BNB_LISTA IS the Lista ERC-4626
 * impl with the right domain + allowlist, via eth_call (free).
 *
 * Reads YIELD_IMPL_BNB_LISTA from .env.local. Read-only. Exit 0 = safe to flip.
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const IMPL = (env.match(/^YIELD_IMPL_BNB_LISTA=(0x[0-9a-fA-F]{40})/m)?.[1] || "").trim();

const GAUNTLET_USDT_VAULT = "0x6d6783C146F2B0B2774C1725297f1845dc502525";
const LISTA_USDC_VAULT = "0x8a06ac91265dbebe6d4606f45b10993e9a571869";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const PROBE = "0x000000000000000000000000000000000000dEaD";
const EXPECT_NAME = "Q402 BNB Chain";
const EXPECT_IMPL_VERSION = "4-yield-bnb-erc4626-lista-slippage-measured";

if (!IMPL) {
  console.error("YIELD_IMPL_BNB_LISTA is not set in .env.local — deploy the Lista ERC-4626 impl first (scripts/deploy-yield-impl.mjs --chain bnb), then set it. DO NOT flip LISTA_YIELD_ENABLED yet.");
  process.exit(1);
}

const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });
const c = new ethers.Contract(IMPL, [
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function IMPL_VERSION() view returns (string)",
  "function isAllowedVault(address) view returns (bool)",
  "function isAllowedAsset(address) view returns (bool)",
], p);

const checks = {};
try {
  const [name, version, implVersion, usdtVaultOk, usdcVaultOk, vaultNo, usdtAssetOk, usdcAssetOk, assetNo] = await Promise.all([
    c.NAME().catch(() => "?"),
    c.VERSION().catch(() => "?"),
    c.IMPL_VERSION().catch(() => "?"),
    c.isAllowedVault(GAUNTLET_USDT_VAULT).catch(() => false),
    c.isAllowedVault(LISTA_USDC_VAULT).catch(() => false),
    c.isAllowedVault(PROBE).catch(() => true),
    c.isAllowedAsset(BSC_USDT).catch(() => false),
    c.isAllowedAsset(BSC_USDC).catch(() => false),
    c.isAllowedAsset(PROBE).catch(() => true),
  ]);
  checks.impl = IMPL;
  checks.nameOk = name === EXPECT_NAME;
  checks.versionOk = version === "1";
  checks.implVersionOk = implVersion === EXPECT_IMPL_VERSION;
  checks.gauntletUsdtAllowed = usdtVaultOk === true;
  checks.listaUsdcAllowed = usdcVaultOk === true;
  checks.randomVaultDenied = vaultNo === false;
  checks.usdtAssetAllowed = usdtAssetOk === true;
  checks.usdcAssetAllowed = usdcAssetOk === true;
  checks.randomAssetDenied = assetNo === false;
  checks.values = { name, version, implVersion };
} catch (e) {
  console.error("could not read the impl — is YIELD_IMPL_BNB_LISTA a deployed contract on BSC?", e?.shortMessage || e?.message);
  process.exit(1);
}

console.log(JSON.stringify(checks, null, 2));
const ok = checks.nameOk && checks.versionOk && checks.implVersionOk &&
  checks.gauntletUsdtAllowed && checks.listaUsdcAllowed && checks.randomVaultDenied &&
  checks.usdtAssetAllowed && checks.usdcAssetAllowed && checks.randomAssetDenied;

if (!ok) {
  console.error("\n! WIRING MISMATCH — YIELD_IMPL_BNB_LISTA is NOT the Lista ERC-4626 impl (or its allowlist is wrong). DO NOT set LISTA_YIELD_ENABLED=true; deposits would revert after paying gas.");
  process.exit(1);
}
console.error("\nOK — YIELD_IMPL_BNB_LISTA is the Lista ERC-4626 impl with the Gauntlet USDT + Lista USDC allowlist. Safe to set LISTA_YIELD_ENABLED=true.");
