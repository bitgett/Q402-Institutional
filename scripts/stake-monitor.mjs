// Read-only QuackAiStake position monitor — watch a live stake test unfold.
// usage: node scripts/stake-monitor.mjs <0xaddress>
import { ethers } from "ethers";

const RPC = "https://bsc-dataseed.binance.org";
const STAKE = "0x8f5aF1E069Cf63118bdD018203F5228343cc4f94";
const Q = "0xc07e1300dc138601FA6B0b59f8D0FA477e690589";
const addr = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(addr || "")) { console.error("usage: node stake-monitor.mjs <0xaddr>"); process.exit(1); }

const p = new ethers.JsonRpcProvider(RPC);
const stake = new ethers.Contract(STAKE, [
  "function getStakeData(address) view returns (uint256[])",
  "function stakeNum(address) view returns (uint256)",
  "function getNowTIme() view returns (uint256)",
], p);
const q = new ethers.Contract(Q, ["function balanceOf(address) view returns (uint256)"], p);

const fmt = (raw) => ethers.formatUnits(raw, 18);
const ts = (s) => new Date(Number(s) * 1000).toISOString().replace("T", " ").slice(0, 19);

const now = Number(await stake.getNowTIme().catch(() => Math.floor(Date.now() / 1000)));
const qbal = await q.balanceOf(addr).catch(() => 0n);
const num = await stake.stakeNum(addr).catch(() => 0n);
console.log(`=== ${addr} ===`);
console.log(`chain now: ${ts(now)}  |  Q balance: ${fmt(qbal)}  |  stakeNum: ${num}`);

const sd = await stake.getStakeData(addr).catch((e) => { console.log("getStakeData ERR", e.message); return []; });
if (!sd.length) { console.log("(no stake records)"); process.exit(0); }

// 8 fields/stake: [stakeTime, amount, stakeType, flag, id, maturity, aprRaw, reward]
const F = 8;
console.log(`\n  #  type   amount       APR     staked              unlock              status`);
for (let i = 0; i + F <= sd.length; i += F) {
  const stakeTime = Number(sd[i]);
  const amount = fmt(sd[i + 1]);
  const type = Number(sd[i + 2]);
  const id = Number(sd[i + 4]);
  const maturity = Number(sd[i + 5]);
  const apr = Number(sd[i + 6]) / 100;
  const lockS = maturity - stakeTime;
  const matured = now >= maturity;
  const left = matured ? "UNLOCKED" : `${maturity - now}s left`;
  console.log(`  ${id}  t${type}   ${amount.padEnd(11)}  ${String(apr).padStart(4)}%  ${ts(stakeTime)}  ${ts(maturity)}  lock=${lockS}s ${matured ? "✓ " + left : "⏳ " + left}`);
}
