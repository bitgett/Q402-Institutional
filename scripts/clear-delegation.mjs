#!/usr/bin/env node
/**
 * clear-delegation.mjs — one-shot CLI clear of an EIP-7702 delegation.
 *
 * Use case: your wallet (OKX, older MetaMask, …) doesn't expose
 * `wallet_signAuthorization` so the dashboard's Clear button can't
 * fire the in-browser sign. ethers' local `Wallet` class DOES
 * implement `.authorize()`, so we sign locally with the user's PK and
 * POST the resulting authorization to /api/wallet/clear-delegation.
 * Q402 sponsors the on-chain broadcast — the PK never leaves this
 * process, the relayer pays the gas.
 *
 * Usage (PowerShell):
 *   $env:CLEAR_PRIVATE_KEY="0x<64 hex>"      # the delegated EOA's PK
 *   $env:CLEAR_CHAIN="bnb"                   # or eth, avax, ...
 *   $env:CLEAR_API_BASE="https://q402.quackai.ai"
 *      # ↑ optional. For a feature-branch preview, pass the
 *      #   *-bitgett-7677s-projects.vercel.app URL.
 *   node scripts/clear-delegation.mjs --dry-run
 *   node scripts/clear-delegation.mjs
 *
 * After running successfully:
 *   - Clear the env var: Remove-Item Env:CLEAR_PRIVATE_KEY
 *   - The delegation is gone on that chain. MetaMask drops the
 *     "Smart account" badge, native gas top-ups stop reverting.
 *
 * The script writes nothing to disk and never sends the PK anywhere
 * over the wire. The authorization signature is what travels.
 */

import { parseArgs } from "node:util";
import { Wallet, JsonRpcProvider } from "ethers";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
  },
});
const DRY_RUN = !!values["dry-run"];

function die(msg) {
  process.stderr.write(`[clear-delegation] ERROR: ${msg}\n`);
  printCleanupReminder();
  process.exit(1);
}

/**
 * Print the env-var-cleanup nag every time the process is about to
 * exit (success, expected fail, or unhandled crash) so the operator
 * doesn't end up with the registrar PK lingering in the shell session.
 * Previously this only printed on the happy path → a script error
 * between the PK read at the top and the success line at the bottom
 * left the env var alive forever.
 */
function printCleanupReminder() {
  if (!process.env.CLEAR_PRIVATE_KEY) return;
  process.stderr.write(
    "\n[clear-delegation] CLEANUP — clear the PK from your shell now:\n" +
      "  PowerShell:  Remove-Item Env:CLEAR_PRIVATE_KEY\n" +
      "  bash/zsh:    unset CLEAR_PRIVATE_KEY\n",
  );
}
process.on("uncaughtException", (e) => {
  process.stderr.write(`[clear-delegation] uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  printCleanupReminder();
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[clear-delegation] unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  printCleanupReminder();
  process.exit(1);
});

const PK = process.env.CLEAR_PRIVATE_KEY;
if (!PK) die("CLEAR_PRIVATE_KEY env var required (0x-prefixed 32-byte hex of the delegated EOA).");
if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) die("CLEAR_PRIVATE_KEY must be a valid 0x-prefixed 32-byte hex.");

const CHAIN = process.env.CLEAR_CHAIN ?? "bnb";
const API_BASE = (process.env.CLEAR_API_BASE ?? "https://q402.quackai.ai").replace(/\/$/, "");

const CHAINS = {
  bnb:       { id: 56,     rpc: "https://bsc-dataseed.binance.org" },
  eth:       { id: 1,      rpc: "https://ethereum.publicnode.com" },
  avax:      { id: 43114,  rpc: "https://api.avax.network/ext/bc/C/rpc" },
  xlayer:    { id: 196,    rpc: "https://rpc.xlayer.tech" },
  stable:    { id: 988,    rpc: "https://rpc.stablecoin.network" },
  mantle:    { id: 5000,   rpc: "https://rpc.mantle.xyz" },
  injective: { id: 1776,   rpc: "https://sentry.evm-rpc.injective.network/" },
  monad:     { id: 143,    rpc: "https://rpc.monad.xyz" },
  scroll:    { id: 534352, rpc: "https://rpc.scroll.io" },
};
const cfg = CHAINS[CHAIN];
if (!cfg) die(`unsupported CLEAR_CHAIN "${CHAIN}". One of: ${Object.keys(CHAINS).join(", ")}`);

async function main() {
  const provider = new JsonRpcProvider(cfg.rpc, cfg.id);
  const wallet = new Wallet(PK, provider);
  const owner = wallet.address;

  process.stderr.write(`[clear-delegation] chain=${CHAIN} (id ${cfg.id})\n`);
  process.stderr.write(`[clear-delegation] owner=${owner}\n`);
  process.stderr.write(`[clear-delegation] api=${API_BASE}\n`);

  const code = await provider.getCode(owner);
  if (code === "0x") {
    process.stderr.write("[clear-delegation] EOA has no code — not delegated. Nothing to clear.\n");
    return;
  }
  if (!code.startsWith("0xef0100")) {
    die(`EOA code does not look like EIP-7702 (got prefix ${code.slice(0, 8)}…). Refusing to clear.`);
  }
  process.stderr.write(`[clear-delegation] current delegation: ${code}\n`);

  const nonce = await provider.getTransactionCount(owner, "pending");
  process.stderr.write(`[clear-delegation] nonce=${nonce}\n`);

  const auth = await wallet.authorize({
    chainId: cfg.id,
    address: "0x0000000000000000000000000000000000000000",
    nonce,
  });

  const body = {
    chain: CHAIN,
    address: owner,
    authorization: {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce: Number(auth.nonce),
      yParity: auth.signature.yParity,
      r: auth.signature.r,
      s: auth.signature.s,
    },
  };

  if (DRY_RUN) {
    process.stderr.write("[clear-delegation] DRY RUN — skipping POST\n");
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  process.stderr.write("[clear-delegation] POSTing to Q402…\n");
  const res = await fetch(`${API_BASE}/api/wallet/clear-delegation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`Q402 ${res.status}: ${JSON.stringify(data)}`);
  }
  process.stderr.write(`[clear-delegation] OK — txHash: ${data.txHash ?? "(no hash returned)"}\n`);
  if (data.txHash) {
    const explorer = CHAIN === "bnb" ? "bscscan.com" : "etherscan.io";
    process.stderr.write(`[clear-delegation] view: https://${explorer}/tx/${data.txHash}\n`);
  }
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

try {
  await main();
} catch (e) {
  process.stderr.write(`[clear-delegation] FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  printCleanupReminder();
  process.exit(1);
}
printCleanupReminder();
