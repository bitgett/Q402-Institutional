/**
 * find-lista-usdc-vault.mjs — locate the Lista (Moolah) USDC vault on BNB by
 * enumerating MoolahVaultFactory creation logs via the Etherscan V2 API
 * (chainid 56 = BSC), then reading asset() on each created vault via RPC.
 * Free public RPCs block wide eth_getLogs, so the explorer API does the logs.
 * Key: ETHERSCAN_API_KEY in .env.local. Read-only.
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const KEY = (env.match(/^ETHERSCAN_API_KEY=(.+)$/m)?.[1] || "").trim();
if (!KEY) throw new Error("ETHERSCAN_API_KEY missing in .env.local");

const FACTORY = "0x2a0Cb6401FD3c6196750dc6b46702040761D9671"; // MoolahVaultFactory
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d".toLowerCase();
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955".toLowerCase();

async function factoryLogs() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.etherscan.io/v2/api?chainid=56&module=logs&action=getLogs&address=${FACTORY}&fromBlock=0&toBlock=latest&page=${page}&offset=1000&apikey=${KEY}`;
    const j = await (await fetch(url)).json();
    if (j.status !== "1" || !Array.isArray(j.result)) {
      if (page === 1) console.log("getLogs:", JSON.stringify(j).slice(0, 240));
      break;
    }
    out.push(...j.result);
    if (j.result.length < 1000) break;
  }
  return out;
}

const logs = await factoryLogs();
console.log(`factory logs: ${logs.length}`);

const candidates = new Set();
for (const log of logs) {
  for (const t of (log.topics || []).slice(1)) {
    if (/^0x0{24}[0-9a-fA-F]{40}$/.test(t)) candidates.add("0x" + t.slice(26).toLowerCase());
  }
  const d = (log.data || "0x").slice(2);
  for (let i = 0; i + 64 <= d.length; i += 64) {
    const w = d.slice(i, i + 64);
    if (/^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{64}$/.test(w)) candidates.add("0x" + w.slice(24).toLowerCase());
  }
}
console.log(`unique address candidates: ${candidates.size}`);

const ABI = [
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
];
const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });

const usdc = [], usdt = [];
for (const addr of candidates) {
  try {
    const c = new ethers.Contract(addr, ABI, p);
    const asset = (await c.asset()).toLowerCase();
    if (asset !== BSC_USDC && asset !== BSC_USDT) continue;
    const [name, symbol, ta] = await Promise.all([
      c.name().catch(() => "?"), c.symbol().catch(() => "?"), c.totalAssets().catch(() => -1n),
    ]);
    const row = { addr, name, symbol, tvl: ta === -1n ? "?" : ethers.formatUnits(ta, 18) };
    (asset === BSC_USDC ? usdc : usdt).push(row);
  } catch { /* not an ERC-4626 vault */ }
}

console.log("\n== USDT vaults ==");
usdt.forEach((u) => console.log(`${u.addr}  ${u.name} / ${u.symbol}  TVL=${u.tvl}`));
console.log("\n== USDC vaults ==");
if (!usdc.length) console.log("none found");
usdc.forEach((u) => console.log(`${u.addr}  ${u.name} / ${u.symbol}  TVL=${u.tvl}`));
console.log("\ndone");
