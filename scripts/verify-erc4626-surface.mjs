/** Decisive on-chain check: do both Lista vaults expose the FULL ERC-4626
 *  surface (so deposit/withdraw/redeem/mint are mandated to exist), and are
 *  the BSC stablecoins 18-decimals as the contract assumes? Read-only. */
import { ethers } from "ethers";

const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });
const VAULTS = {
  "Gauntlet USDT": "0x6d6783C146F2B0B2774C1725297f1845dc502525",
  "Lista USDC": "0x8a06Ac91265dBEBE6D4606f45b10993E9a571869",
};
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const DEAD = "0x000000000000000000000000000000000000dEaD";

const VAULT_ABI = [
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewMint(uint256) view returns (uint256)",
  "function previewWithdraw(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxMint(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
];

for (const [label, addr] of Object.entries(VAULTS)) {
  console.log(`\n== ${label}  ${addr} ==`);
  const c = new ethers.Contract(addr, VAULT_ABI, p);
  const probes = [
    ["asset", () => c.asset()],
    ["decimals", () => c.decimals()],
    ["totalAssets", () => c.totalAssets()],
    ["convertToShares(1e18)", () => c.convertToShares(10n ** 18n)],
    ["convertToAssets(1e18)", () => c.convertToAssets(10n ** 18n)],
    ["previewDeposit(1e18)", () => c.previewDeposit(10n ** 18n)],
    ["previewMint(1e18)", () => c.previewMint(10n ** 18n)],
    ["previewWithdraw(1e18)", () => c.previewWithdraw(10n ** 18n)],
    ["previewRedeem(1e18)", () => c.previewRedeem(10n ** 18n)],
    ["maxDeposit(dead)", () => c.maxDeposit(DEAD)],
    ["maxWithdraw(dead)", () => c.maxWithdraw(DEAD)],
    ["maxRedeem(dead)", () => c.maxRedeem(DEAD)],
  ];
  let ok = 0;
  for (const [name, fn] of probes) {
    try { const v = await fn(); console.log(`  OK  ${name} = ${v}`); ok++; }
    catch (e) { console.log(`  !!  ${name} MISSING/REVERT (${e?.shortMessage || e?.code || "err"})`); }
  }
  console.log(`  -> ${ok}/${probes.length} ERC-4626 view fns respond ${ok === probes.length ? "(full ERC-4626 surface = deposit/withdraw/redeem/mint mandated to exist)" : "(INCOMPLETE — investigate)"}`);
}

console.log("\n== BSC stablecoin decimals (contract assumes 18 for both) ==");
for (const [label, addr] of [["USDT", BSC_USDT], ["USDC", BSC_USDC]]) {
  const t = new ethers.Contract(addr, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], p);
  const [d, s] = await Promise.all([t.decimals(), t.symbol().catch(() => "?")]);
  console.log(`  ${label} ${addr}  symbol=${s}  decimals=${d} ${Number(d) === 18 ? "OK (18)" : "!! NOT 18 — amount conversion bug risk"}`);
}
console.log("\ndone");
