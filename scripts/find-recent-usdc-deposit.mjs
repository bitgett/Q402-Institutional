#!/usr/bin/env node
/**
 * find-recent-usdc-deposit.mjs — Find recent USDC deposits to any Agentic
 * Wallet on Ethereum.
 *
 * 1. Pulls every active Agentic Wallet record from KV (aw:*).
 * 2. For each Ethereum mainnet (since the wallet address is the same on
 *    every chain, we use a single eth_getLogs sweep keyed on the USDC
 *    Transfer topic + a padded recipient set).
 * 3. Filters for USDC Transfer events whose `to` falls in the Agentic
 *    Wallet set and (optionally) whose `value` matches the target amount.
 *
 * Read-only. Hits public Ethereum RPC for one getLogs window.
 *
 * Usage
 *   node --env-file=.env.local scripts/find-recent-usdc-deposit.mjs [amount-usdc] [block-window]
 *
 * Examples
 *   node --env-file=.env.local scripts/find-recent-usdc-deposit.mjs 1.5 5000
 *   node --env-file=.env.local scripts/find-recent-usdc-deposit.mjs                     # any amount
 */

import { kv } from "@vercel/kv";
import { JsonRpcProvider, Interface } from "ethers";

const ETH_RPC = "https://ethereum.publicnode.com";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // canonical USDC on eth mainnet (6-dec)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ── Args ──────────────────────────────────────────────────────────────
const targetAmountHuman = process.argv[2] ? parseFloat(process.argv[2]) : null;
const blockWindow = parseInt(process.argv[3] ?? "8000", 10); // ~27h on eth (12s blocks)

const targetRaw = targetAmountHuman != null ? BigInt(Math.round(targetAmountHuman * 1_000_000)) : null;

// ── 1. Pull every Agentic Wallet address from KV ──────────────────────
console.log("[1/3] Scanning KV for Agentic Wallet records (aw:*) …");
const walletAddrs = new Set(); // lowercased "0x..." addresses
const walletByAddr = new Map(); // addr → { owner, walletId }
let cursor = 0;
let iters = 0;
do {
  const [next, batch] = await kv.scan(cursor, { match: "aw:*", count: 500 });
  cursor = next;
  for (const key of batch) {
    // Schema v2: aw:{owner}:{walletId}.  Skip dedup / lock / claim keys.
    const parts = key.split(":");
    if (parts.length !== 3) continue;
    const owner = parts[1];
    const walletId = parts[2];
    try {
      const rec = await kv.get(key);
      const addr = rec?.address;
      if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
      if (rec.deletedAt) continue; // skip soft-deleted
      const lc = addr.toLowerCase();
      walletAddrs.add(lc);
      walletByAddr.set(lc, { owner, walletId, address: addr });
    } catch {}
  }
  iters++;
  if (iters > 200) break;
} while (String(cursor) !== "0");
console.log(`  → ${walletAddrs.size} active Agentic Wallet addresses.`);

if (walletAddrs.size === 0) {
  console.log("No active wallets — nothing to scan.");
  process.exit(0);
}

// ── 2. Build padded-recipient topic[2] filter set ────────────────────
//
// eth_getLogs `topics` accepts an array-of-arrays: topic[2] = [pad(addr1),
// pad(addr2), …]. Public RPCs cap this at ~50–100 OR addresses; if there
// are more wallets than that, we chunk.
function pad(addr) {
  return "0x" + addr.replace(/^0x/, "").padStart(64, "0").toLowerCase();
}

const allRecipients = [...walletAddrs].map(pad);
const CHUNK = 50;
const recipientChunks = [];
for (let i = 0; i < allRecipients.length; i += CHUNK) {
  recipientChunks.push(allRecipients.slice(i, i + CHUNK));
}
console.log(`[2/3] Scanning Ethereum mainnet for USDC Transfer to any wallet (window: ${blockWindow} blocks ≈ ${Math.round(blockWindow * 12 / 3600)}h)`);

const provider = new JsonRpcProvider(ETH_RPC);
const current = await provider.getBlockNumber();
const fromBlock = current - blockWindow;
console.log(`  → blocks ${fromBlock} … ${current}`);

const matches = [];
for (let i = 0; i < recipientChunks.length; i++) {
  const chunk = recipientChunks[i];
  try {
    const logs = await provider.getLogs({
      address: USDC_ETH,
      fromBlock,
      toBlock: current,
      topics: [TRANSFER_TOPIC, null, chunk],
    });
    for (const log of logs) {
      const fromTopic = log.topics[1];
      const toTopic = log.topics[2];
      const fromAddr = "0x" + fromTopic.slice(26);
      const toAddr = "0x" + toTopic.slice(26);
      const valueRaw = BigInt(log.data);
      if (targetRaw && valueRaw !== targetRaw) continue;
      matches.push({
        from: fromAddr,
        to: toAddr.toLowerCase(),
        valueRaw,
        valueHuman: Number(valueRaw) / 1_000_000,
        txHash: log.transactionHash,
        block: log.blockNumber,
      });
    }
    process.stdout.write(`  chunk ${i + 1}/${recipientChunks.length} · ${logs.length} logs, ${matches.length} matches so far\r`);
  } catch (e) {
    console.log(`\n  ⚠ chunk ${i + 1} failed: ${e.message?.slice(0, 100)}`);
  }
}
console.log();

// ── 3. Report ─────────────────────────────────────────────────────────
console.log(`[3/3] Found ${matches.length} matching transfer(s)${targetRaw ? ` for amount = ${targetAmountHuman} USDC` : ""}.`);
if (matches.length === 0) {
  process.exit(0);
}
matches.sort((a, b) => b.block - a.block);
for (const m of matches) {
  const wallet = walletByAddr.get(m.to);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Block         ${m.block}`);
  console.log(`  Amount        ${m.valueHuman} USDC (raw ${m.valueRaw})`);
  console.log(`  From          ${m.from}`);
  console.log(`  To (Wallet)   ${wallet?.address ?? m.to}`);
  console.log(`  Owner         ${wallet?.owner ?? "(unknown)"}`);
  console.log(`  walletId      ${wallet?.walletId ?? "(unknown)"}`);
  console.log(`  Etherscan     https://etherscan.io/tx/${m.txHash}`);
}
