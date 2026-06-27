/**
 * trace-usdc-vault.mjs — find the Lista USDC vault from a recent tx by the
 * given wallet. Recent txs touched the vault (deposit) and/or USDC.approve(vault).
 * Reads candidate addresses (tx `to` + addresses in calldata), checks asset()==USDC.
 * Free: Routescan API for the tx list (fallback: RPC newest-first block scan).
 */
import { ethers } from "ethers";

const WALLET = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466".toLowerCase();
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d".toLowerCase();
const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });
const ABI = ["function asset() view returns (address)", "function name() view returns (string)", "function symbol() view returns (string)", "function totalAssets() view returns (uint256)"];

const seen = new Set();
const hits = [];
async function checkCandidate(addr) {
  addr = addr.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr) || addr === WALLET || addr === BSC_USDC || seen.has(addr)) return;
  seen.add(addr);
  try {
    const c = new ethers.Contract(addr, ABI, p);
    const asset = (await c.asset()).toLowerCase();
    if (asset !== BSC_USDC) return;
    const [name, symbol, ta] = await Promise.all([c.name().catch(()=>"?"), c.symbol().catch(()=>"?"), c.totalAssets().catch(()=>-1n)]);
    hits.push({ addr, name, symbol, tvl: ta===-1n?"?":ethers.formatUnits(ta,18) });
    console.log(`>>> USDC VAULT  ${addr}  ${name} / ${symbol}  TVL=${hits[hits.length-1].tvl}`);
  } catch {}
}
function candidatesFromTx(tx) {
  const out = [];
  if (tx.to) out.push(tx.to);
  const d = (tx.input || tx.data || "0x").slice(2);
  for (let i = 0; i + 64 <= d.length; i += 64) {
    const w = d.slice(i, i + 64);
    if (/^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{64}$/.test(w)) out.push("0x" + w.slice(24));
  }
  return out;
}

// 1) Routescan (free BSC indexer)
let traced = 0;
try {
  const url = `https://api.routescan.io/v2/network/mainnet/evm/56/address/${WALLET}/transactions?sort=desc&limit=25`;
  const j = await (await fetch(url)).json();
  const items = j.items || j.data || [];
  console.log(`routescan txs: ${items.length}`);
  for (const t of items.slice(0, 25)) {
    traced++;
    const to = (t.to?.id || t.to || t.toAddress || "").toString();
    for (const c of candidatesFromTx({ to, input: t.input || t.data })) await checkCandidate(c);
  }
} catch (e) { console.log("routescan failed:", e?.message); }

// 2) Fallback: scan recent blocks newest-first for txs from WALLET
if (!hits.length) {
  console.log("scanning recent blocks via RPC...");
  const latest = await p.getBlockNumber();
  for (let b = latest; b > latest - 800 && hits.length === 0; b--) {
    let block;
    try { block = await p.getBlock(b, true); } catch { continue; }
    if (!block?.prefetchedTransactions) continue;
    for (const tx of block.prefetchedTransactions) {
      if ((tx.from || "").toLowerCase() !== WALLET) continue;
      traced++;
      for (const c of candidatesFromTx(tx)) await checkCandidate(c);
    }
  }
}

console.log(`\ntraced ${traced} txs; USDC vaults found: ${hits.length}`);
hits.forEach((h) => console.log(`${h.addr}  ${h.name} / ${h.symbol}  TVL=${h.tvl}`));
console.log("done");
