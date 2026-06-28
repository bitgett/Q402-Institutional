import { ethers } from "ethers";
const A = "0x8a06ac91265dbebe6d4606f45b10993e9a571869";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d".toLowerCase();
const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });
const c = new ethers.Contract(A, [
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
], p);
try {
  const [asset, name, sym, ta, conv] = await Promise.all([
    c.asset(), c.name(), c.symbol(), c.totalAssets(), c.convertToAssets(10n ** 18n),
  ]);
  console.log("address    :", A);
  console.log("asset()    :", asset, asset.toLowerCase() === USDC ? "== BSC USDC  ✓ MATCH" : "!! NOT USDC");
  console.log("name/symbol:", name, "/", sym);
  console.log("erc4626    : asset()+convertToAssets() responded = YES");
  console.log("totalAssets:", ethers.formatUnits(ta, 18), "USDC");
  console.log("1e18 shares -> assets:", conv.toString());
} catch (e) {
  console.log("ERR (not ERC-4626 / wrong addr):", e?.shortMessage || e?.message);
}
