/**
 * migrate-split-wallets.mjs — PLAN ONLY (no signing, no broadcasting).
 *
 * Prints the cold-wallet transfers required to split the legacy single-wallet
 *   0xfc77ff29178b7286a8ba703d7a70895ca74ff466
 * into the v1.16 three-role architecture:
 *
 *   SUBSCRIPTION_ADDRESS  0x700a873215edb1e1a2a401a2e0cec022f6b5bd71  (revenue)
 *   GASTANK_ADDRESS       0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a  (user deposits)
 *   RELAYER_ADDRESS       0xfc77ff29178b7286a8ba703d7a70895ca74ff466  (operational hot)
 *
 * Allocation logic (per chain):
 *   1. GASTANK gets exactly the sum of all KV-recorded user gas balances.
 *      This preserves the invariant: on-chain GASTANK == sum(KV gas balance).
 *   2. RELAYER keeps a small operational reserve for hot signing.
 *   3. SUBSCRIPTION receives the remainder (revenue accumulated in the legacy
 *      wallet from past subscription payments + leftover float).
 *
 * USAGE:
 *   node scripts/migrate-split-wallets.mjs
 *
 * The script ONLY READS — it never holds a private key and never broadcasts.
 * The operator signs and broadcasts each printed transfer manually from a
 * cold device (Ledger / hardware wallet). After all transfers confirm,
 * verify the invariant by re-running this script — it should report zero
 * pending action on every chain.
 */

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEGACY  = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466"; // ← also the future RELAYER
const GASTANK = "0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a";
const SUBSCR  = "0x700a873215edb1e1a2a401a2e0cec022f6b5bd71";

// Operational reserves to keep in RELAYER per chain (in native token units).
// Tune these to match your cron-alert thresholds + ~30 days of expected relay volume.
const RELAYER_RESERVE = {
  bnb:    0.30,    // ~$200 @ BNB $660
  eth:    0.30,    // ~$1000 @ ETH $3300
  avax:   3.00,    // ~$100 @ AVAX $33
  xlayer: 1.50,    // ~$50  @ OKB $33
  stable: 50.00,   // ~$50  USDT0 (Stable's gas token)
};

const CHAINS = [
  { key: "bnb",    name: "BNB Chain",  token: "BNB",   rpc: "https://bsc-dataseed1.binance.org/"    },
  { key: "eth",    name: "Ethereum",   token: "ETH",   rpc: "https://ethereum.publicnode.com"        },
  { key: "avax",   name: "Avalanche",  token: "AVAX",  rpc: "https://api.avax.network/ext/bc/C/rpc"  },
  { key: "xlayer", name: "X Layer",    token: "OKB",   rpc: "https://rpc.xlayer.tech"                },
  { key: "stable", name: "Stable",     token: "USDT0", rpc: "https://rpc.stable.xyz"                 },
];

/** Read total GASTANK liability per chain from the local KV snapshot at data/db.json.
 *  In production, replace this with a live Vercel KV scan (see comment below). */
function readKvLiabilities() {
  const dbPath = resolve(__dirname, "..", "data", "db.json");
  let raw;
  try {
    raw = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch {
    console.warn("[warn] data/db.json not readable — assuming zero KV liability.");
    console.warn("[warn] In production, query Vercel KV: SCAN gas:* and sum each user's per-chain balance.");
    return Object.fromEntries(CHAINS.map(c => [c.key, 0]));
  }
  const totals = Object.fromEntries(CHAINS.map(c => [c.key, 0]));
  const gas = raw.gasDeposits ?? raw.gas_deposits ?? {};
  for (const userAddr of Object.keys(gas)) {
    for (const entry of gas[userAddr] ?? []) {
      if (totals[entry.chain] !== undefined) {
        totals[entry.chain] += Number(entry.amount) || 0;
      }
    }
  }
  return totals;
}

async function getNativeBalance(rpc, address) {
  const provider = new ethers.JsonRpcProvider(rpc);
  const bal = await provider.getBalance(address);
  return parseFloat(ethers.formatEther(bal));
}

async function main() {
  const liabilities = readKvLiabilities();
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(" Q402 v1.16 wallet-split migration plan (READ-ONLY)");
  console.log("══════════════════════════════════════════════════════════════════\n");
  console.log(`Legacy wallet:        ${LEGACY}`);
  console.log(`→ Future RELAYER:     ${LEGACY} (same key, narrower role)`);
  console.log(`→ New GASTANK:        ${GASTANK}`);
  console.log(`→ New SUBSCRIPTION:   ${SUBSCR}\n`);

  for (const chain of CHAINS) {
    const bal = await getNativeBalance(chain.rpc, LEGACY).catch(() => null);
    const liab = liabilities[chain.key] ?? 0;
    const reserve = RELAYER_RESERVE[chain.key] ?? 0;

    console.log(`─── ${chain.name} (${chain.token}) ───────────────────────`);
    if (bal === null) {
      console.log("  RPC unreachable — skip and re-run when network is healthy.\n");
      continue;
    }
    console.log(`  Legacy wallet on-chain balance:  ${bal.toFixed(6)} ${chain.token}`);
    console.log(`  KV gas liability (sum users):    ${liab.toFixed(6)} ${chain.token}`);
    console.log(`  Operational reserve (RELAYER):   ${reserve.toFixed(6)} ${chain.token}`);

    const toGastank = liab;
    const toRelayerKeep = reserve;
    const toSubscr = bal - toGastank - toRelayerKeep;

    if (bal < toGastank + toRelayerKeep) {
      console.log(`  ⚠️  Legacy balance is LESS than (liability + reserve).`);
      console.log(`      Top up legacy wallet by ${(toGastank + toRelayerKeep - bal).toFixed(6)} ${chain.token} before splitting.`);
      console.log("");
      continue;
    }

    console.log("  Recommended cold-wallet transfers (sign offline, broadcast manually):");
    if (toGastank > 0) {
      console.log(`    1. ${LEGACY} → ${GASTANK}  ${toGastank.toFixed(6)} ${chain.token}`);
    } else {
      console.log("    1. (no GASTANK transfer — zero KV liability)");
    }
    if (toSubscr > 0.0001) {
      console.log(`    2. ${LEGACY} → ${SUBSCR}   ${toSubscr.toFixed(6)} ${chain.token}`);
    } else {
      console.log("    2. (no SUBSCRIPTION sweep — nothing left after gastank + reserve)");
    }
    console.log(`    3. KEEP ${toRelayerKeep.toFixed(6)} ${chain.token} in ${LEGACY} as operational reserve.\n`);
  }

  console.log("══════════════════════════════════════════════════════════════════");
  console.log(" After signing + broadcasting all printed transfers, re-run this");
  console.log(" script. The expected steady state is:");
  console.log("   • GASTANK on-chain balance == KV liability (per chain)");
  console.log("   • RELAYER on-chain balance ~= operational reserve");
  console.log("   • SUBSCRIPTION holds the swept revenue (cold storage)");
  console.log("══════════════════════════════════════════════════════════════════\n");
}

main().catch(e => {
  console.error("[fatal]", e?.message ?? e);
  process.exit(1);
});
