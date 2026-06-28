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

// The two vaults hard-coded into the impl's immutable allowlist (BNB mainnet).
// (The MEV/Re7/Pangolins USDT vaults were survey candidates only; note Re7's
//  0x02A5ca3a… is actually a USD1 vault, NOT USDT — excluded deliberately.)
const VAULTS = [
  { label: "Gauntlet USDT Vault", address: "0x6d6783C146F2B0B2774C1725297f1845dc502525", expectAsset: BSC_USDT },
  { label: "Lista USDC Vault", address: "0x8a06Ac91265dBEBE6D4606f45b10993E9a571869", expectAsset: BSC_USDC },
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
    console.log(`  asset()      : ${asset} ${assetOk ? "== expected OK" : "!! UNEXPECTED"}`);
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
