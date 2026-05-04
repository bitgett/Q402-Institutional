/**
 * migrate-split-wallets.mjs — PLAN ONLY (no signing, no broadcasting).
 *
 * HISTORICAL — written for the v1.16 three-role split. The SUBSCRIPTION
 * address shown below (`0x700a873215edb1e1a2a401a2e0cec022f6b5bd71`) was
 * retired in v1.25 when SUBSCRIPTION moved to a 2-of-3 Safe multisig at
 * `0x2ffdFD41E461DdE8bE5a28A392dA511084d23faE`. The current source of
 * truth for all three constants is `app/lib/wallets.ts`, NOT this script.
 * Kept in-tree as a record of the original split-wallets migration plan.
 *
 * Prints the cold-wallet transfers required to split the legacy single-wallet
 *   0xfc77ff29178b7286a8ba703d7a70895ca74ff466
 * into the v1.16 three-role architecture:
 *
 *   SUBSCRIPTION_ADDRESS  0x700a873215edb1e1a2a401a2e0cec022f6b5bd71  (revenue, retired in v1.25 → multisig)
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
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                       PRODUCTION SAFETY WARNING                            ║
 * ║                                                                            ║
 * ║  This script reads KV liability from the LOCAL data/db.json snapshot      ║
 * ║  which is a DEV FIXTURE. In production, the live ledger lives in Vercel   ║
 * ║  KV (Upstash Redis) and is NOT mirrored to data/db.json.                  ║
 * ║                                                                            ║
 * ║  Before running for a real cold-wallet split, you MUST EITHER:            ║
 * ║   (a) Pass --kv-snapshot=<path> with a fresh export of `gas:*` keys, OR    ║
 * ║   (b) Pass --i-accept-empty-ledger to acknowledge that you're running     ║
 * ║       on a known-empty deployment (e.g., pre-launch).                     ║
 * ║                                                                            ║
 * ║  Without either flag, the script REFUSES TO RUN if data/db.json is        ║
 * ║  missing. Do not bypass this check by `touch data/db.json`.               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * USAGE:
 *   node scripts/migrate-split-wallets.mjs                          (dev / local)
 *   node scripts/migrate-split-wallets.mjs --kv-snapshot=./prod.json (prod)
 *   node scripts/migrate-split-wallets.mjs --i-accept-empty-ledger   (pre-launch)
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

// ── Retired-script guard ─────────────────────────────────────────────────────
// This script was written for the v1.16 single-wallet→three-role split. The
// SUBSCR address it sweeps to is the v1.16 EOA, retired in v1.25 when
// SUBSCRIPTION moved to a 2-of-3 Safe multisig. Re-running this without
// updating SUBSCR would generate sweep instructions to a wallet that no
// longer receives revenue.
//
// To run anyway (e.g. recovering historical context): pass
// --acknowledge-retired and the script will continue. Otherwise it exits 1.
if (!process.argv.includes("--acknowledge-retired")) {
  console.error("\nmigrate-split-wallets.mjs is RETIRED.\n");
  console.error("This script was written for the v1.16 single-wallet split. The");
  console.error("SUBSCRIPTION_ADDRESS it targets (0x700a87...d71) was retired in");
  console.error("v1.25 when subscription revenue moved to a 2-of-3 Safe multisig");
  console.error("at 0x2ffdFD41E461DdE8bE5a28A392dA511084d23faE (BNB + Ethereum).");
  console.error("");
  console.error("The current source of truth for all three constants is");
  console.error("app/lib/wallets.ts — read from there, do not from this file.");
  console.error("");
  console.error("If you really need to run this for historical context, pass");
  console.error("--acknowledge-retired. Do not, however, follow the printed");
  console.error("instructions: they sweep to the retired EOA.\n");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEGACY  = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466"; // ← also the future RELAYER
const GASTANK = "0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a";
// HISTORICAL — retired v1.25, see the guard above.
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

function parseFlags(argv) {
  const flags = { kvSnapshot: null, acceptEmpty: false };
  for (const arg of argv) {
    if (arg.startsWith("--kv-snapshot=")) flags.kvSnapshot = arg.slice("--kv-snapshot=".length);
    else if (arg === "--i-accept-empty-ledger") flags.acceptEmpty = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/migrate-split-wallets.mjs [--kv-snapshot=PATH | --i-accept-empty-ledger]");
      process.exit(0);
    }
  }
  return flags;
}

/** Read total GASTANK liability per chain.
 *
 *  Resolution order:
 *    1. --kv-snapshot=<path>  → read user-supplied production export
 *    2. data/db.json          → local dev fixture (NOT production)
 *    3. --i-accept-empty-ledger → assume zero (pre-launch / empty deployment)
 *    4. (none of the above)   → ABORT with explicit error
 *
 *  Returns { totals, source } so the caller can label the plan output.
 */
function readKvLiabilities(flags) {
  let dbPath;
  let source;
  if (flags.kvSnapshot) {
    dbPath = resolve(flags.kvSnapshot);
    source = `KV snapshot (${dbPath})`;
  } else {
    dbPath = resolve(__dirname, "..", "data", "db.json");
    source = `local dev fixture (${dbPath})`;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(dbPath, "utf8"));
  } catch (e) {
    if (flags.acceptEmpty) {
      console.warn("");
      console.warn("⚠️  --i-accept-empty-ledger acknowledged. Treating KV liability as ZERO.");
      console.warn("⚠️  This is ONLY safe if you have verified out-of-band that no users have");
      console.warn("⚠️  ever deposited gas to the legacy wallet. If unsure, abort and re-run");
      console.warn("⚠️  with --kv-snapshot=<path> pointing to a fresh `gas:*` KV export.");
      console.warn("");
      return { totals: Object.fromEntries(CHAINS.map(c => [c.key, 0])), source: "EMPTY (acknowledged)" };
    }
    console.error("");
    console.error("❌ Cannot read KV liability source:");
    console.error(`   ${dbPath}`);
    console.error(`   ${e?.message ?? e}`);
    console.error("");
    console.error("This script REFUSES to print a migration plan without a known KV liability.");
    console.error("Splitting funds based on a wrong (e.g., zero) liability would either:");
    console.error("   - Under-fund GASTANK → users see their balance vanish");
    console.error("   - Over-sweep SUBSCRIPTION → revenue commingled with user deposits");
    console.error("");
    console.error("To proceed, choose ONE:");
    console.error("   (a) Export the production KV `gas:*` keys to a JSON file:");
    console.error("       node scripts/migrate-split-wallets.mjs --kv-snapshot=./prod-kv.json");
    console.error("");
    console.error("   (b) If this is a known-empty pre-launch deployment, acknowledge:");
    console.error("       node scripts/migrate-split-wallets.mjs --i-accept-empty-ledger");
    console.error("");
    process.exit(1);
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
  return { totals, source };
}

async function getNativeBalance(rpc, address) {
  const provider = new ethers.JsonRpcProvider(rpc);
  const bal = await provider.getBalance(address);
  return parseFloat(ethers.formatEther(bal));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const { totals: liabilities, source: liabSource } = readKvLiabilities(flags);
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(" Q402 v1.16 wallet-split migration plan (READ-ONLY)");
  console.log("══════════════════════════════════════════════════════════════════\n");
  console.log(`KV liability source:  ${liabSource}`);
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
