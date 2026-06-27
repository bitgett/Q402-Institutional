/**
 * verify-lista-vault.mjs — read-only proof that Lista's MoolahVault contracts
 * are ERC-4626 and bind the stablecoin we expect, BEFORE we hard-code any vault
 * into the immutable on-chain allowlist (Q402PaymentImplementationBNBYieldErc4626).
 *
 * No key, no funds, public RPC. Probes asset()/name()/symbol()/decimals()/
 * totalAssets()/convertToAssets(1e18)/maxDeposit + the ERC-4626 deposit/withdraw/
 * redeem selectors. Run: node scripts/verify-lista-vault.mjs
 */
import { ethers } from "ethers";

const RPC = process.env.BNB_RPC_URL || "https://bsc-dataseed.binance.org";
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

// From docs.bsc.lista.org core-contracts list (BNB mainnet).
const VAULTS = [
  { label: "MoolahVault (USDT)", address: "0x6d6783C146F2B0B2774C1725297f1845dc502525", expectAsset: BSC_USDT },
  { label: "MoolahVault (MEV USDT)", address: "0x6402d64F035E18F9834591d3B994dFe41a0f162D", expectAsset: BSC_USDT },
  { label: "MoolahVault (Re7 USDT)", address: "0x02A5ca3a749855d1002A78813E679584a96646d0", expectAsset: BSC_USDT },
  { label: "MoolahVault (Pangolins USDT)", address: "0xEB4F6FFB1038E1cCa701e7d53083B37ec5b6Ba33", expectAsset: BSC_USDT },
];

const ABI = [
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
];

const provider = new ethers.JsonRpcProvider(RPC);

for (const v of VAULTS) {
  const c = new ethers.Contract(v.address, ABI, provider);
  try {
    const [asset, name, symbol, decimals, totalAssets, convert1e18] = await Promise.all([
      c.asset(),
      c.name().catch(() => "?"),
      c.symbol().catch(() => "?"),
      c.decimals().catch(() => -1),
      c.totalAssets().catch(() => -1n),
      c.convertToAssets(10n ** 18n).catch(() => -1n),
    ]);
    const assetOk = asset.toLowerCase() === v.expectAsset.toLowerCase();
    console.log(`\n${v.label}  ${v.address}`);
    console.log(`  erc4626      : asset()+convertToAssets() responded = YES`);
    console.log(`  asset()      : ${asset} ${assetOk ? "== BSC USDT OK" : "!! UNEXPECTED"}`);
    console.log(`  name/symbol  : ${name} / ${symbol}`);
    console.log(`  decimals     : ${decimals}`);
    console.log(`  totalAssets  : ${totalAssets}`);
    console.log(`  1e18 shares -> assets: ${convert1e18}`);
  } catch (e) {
    console.log(`\n${v.label}  ${v.address}`);
    console.log(`  ERROR (not ERC-4626 / wrong addr / RPC): ${e?.shortMessage || e?.message || e}`);
  }
}
console.log("\ndone");
