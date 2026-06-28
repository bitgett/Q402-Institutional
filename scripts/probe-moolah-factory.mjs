/** Probe MoolahVaultFactory (+ Manager) for an enumeration getter via eth_call
 *  (free RPCs allow eth_call; only getLogs is blocked). If found, read asset()
 *  on each vault and flag the USDC one. Read-only. */
import { ethers } from "ethers";

const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d".toLowerCase();
const FACTORY = "0x2a0Cb6401FD3c6196750dc6b46702040761D9671";
const MANAGER = "0x5021319C1B8245e0680F19b7aA84a0F0F3d91AA9";
const ALLOCATOR = "0x9ECF66f016FCaA853FdA24d223bdb4276E5b524a";
const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });

const arrayGetters = [
  "function getVaults() view returns (address[])",
  "function allVaults() view returns (address[])",
  "function vaults() view returns (address[])",
  "function getMoolahVaults() view returns (address[])",
  "function listVaults() view returns (address[])",
];
const idxGetters = [
  "function allVaults(uint256) view returns (address)",
  "function vaults(uint256) view returns (address)",
  "function moolahVaults(uint256) view returns (address)",
  "function vaultList(uint256) view returns (address)",
];
const lenGetters = [
  "function allVaultsLength() view returns (uint256)",
  "function vaultsLength() view returns (uint256)",
  "function getVaultsLength() view returns (uint256)",
];

async function tryArray(addr) {
  for (const sig of arrayGetters) {
    try {
      const c = new ethers.Contract(addr, [sig], p);
      const fn = sig.match(/function (\w+)/)[1];
      const r = await c[fn]();
      if (Array.isArray(r) && r.length) return { fn, vaults: r };
    } catch {}
  }
  return null;
}
async function tryIndexed(addr) {
  for (const sig of idxGetters) {
    const fn = sig.match(/function (\w+)/)[1];
    const c = new ethers.Contract(addr, [sig], p);
    const out = [];
    try {
      for (let i = 0; i < 60; i++) out.push(await c[fn](i));
    } catch {}
    if (out.length) return { fn, vaults: out };
  }
  return null;
}

let found = null;
for (const [label, addr] of [["FACTORY", FACTORY], ["MANAGER", MANAGER], ["ALLOCATOR", ALLOCATOR]]) {
  for (const sig of lenGetters) {
    try {
      const fn = sig.match(/function (\w+)/)[1];
      const n = await new ethers.Contract(addr, [sig], p)[fn]();
      console.log(`${label}.${fn}() = ${n}`);
    } catch {}
  }
  const a = await tryArray(addr);
  if (a) { console.log(`${label}.${a.fn}() returned ${a.vaults.length} vaults`); found = a.vaults; break; }
  const ix = await tryIndexed(addr);
  if (ix) { console.log(`${label}.${ix.fn}(i) enumerated ${ix.vaults.length} vaults`); found = ix.vaults; break; }
}

if (!found) { console.log("no enumeration getter found on factory/manager/allocator"); process.exit(0); }

const ABI = ["function asset() view returns (address)", "function name() view returns (string)", "function symbol() view returns (string)", "function totalAssets() view returns (uint256)"];
for (const addr of [...new Set(found.map((a) => a.toLowerCase()))]) {
  try {
    const c = new ethers.Contract(addr, ABI, p);
    const asset = (await c.asset()).toLowerCase();
    if (asset !== BSC_USDC) continue;
    const [name, symbol, ta] = await Promise.all([c.name(), c.symbol(), c.totalAssets()]);
    console.log(`USDC VAULT  ${addr}  ${name} / ${symbol}  TVL=${ethers.formatUnits(ta, 18)}`);
  } catch {}
}
console.log("done");
