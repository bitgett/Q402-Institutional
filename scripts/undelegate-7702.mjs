#!/usr/bin/env node
/**
 * undelegate-7702.mjs — Reset EIP-7702 delegation on an EOA.
 *
 * Q402 settles gasless payments by installing an EIP-7702 delegation on
 * the payer's EOA — the impl contract runs in the EOA's context for the
 * transfer. Per spec the delegation persists after each TX (visible as
 * `0xef0100 + <impl address>` from eth_getCode) so subsequent Q402
 * payments are cheaper. This script lets the EOA reset that delegation
 * when the user wants their wallet back to a plain EOA (e.g. before
 * receiving a native gas token directly to the same address).
 *
 * Signs an EIP-7702 authorization with address = 0x0 and submits a
 * type-0x04 TX that writes empty code back. After confirmation,
 * eth_getCode returns "0x" again. The next q402_pay on that chain
 * recreates a fresh delegation automatically.
 *
 * Two modes:
 *
 *   ─── Self-paid (default) ──────────────────────────────────────────
 *   Target EOA submits its own TX. Needs ~0.0002 BNB / 0.05 MON / etc.
 *
 *     PRIVATE_KEY=0x... node scripts/undelegate-7702.mjs --chain bnb
 *
 *   ─── Sponsored ────────────────────────────────────────────────────
 *   Target EOA SIGNS the authorization tuple, but a SPONSOR wallet
 *   submits the TX and pays gas. Resolves the chicken-and-egg case
 *   where the target EOA has 0 native balance AND can't receive native
 *   because of the delegation.
 *
 *     PRIVATE_KEY=0x<target>... SPONSOR_PRIVATE_KEY=0x<gas payer>... \
 *       node scripts/undelegate-7702.mjs --chain bnb --sponsor
 */

import { ethers } from "ethers";

const CHAINS = {
  bnb:    { id: 56,    rpc: "https://bsc-dataseed1.binance.org/", explorer: "https://bscscan.com/tx/" },
  eth:    { id: 1,     rpc: "https://ethereum.publicnode.com",     explorer: "https://etherscan.io/tx/" },
  avax:   { id: 43114, rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io/tx/" },
  xlayer: { id: 196,   rpc: "https://rpc.xlayer.tech",              explorer: "https://www.oklink.com/xlayer/tx/" },
  mantle: { id: 5000,  rpc: "https://rpc.mantle.xyz",               explorer: "https://explorer.mantle.xyz/tx/" },
  injective: { id: 1776, rpc: "https://sentry.evm-rpc.injective.network/", explorer: "https://blockscout.injective.network/tx/" },
  stable: { id: 988,   rpc: "https://rpc.stable.xyz",               explorer: "https://stablescan.xyz/tx/" },
  monad:  { id: 143,   rpc: "https://rpc.monad.xyz",                explorer: "https://monadscan.com/tx/" },
  scroll: { id: 534352, rpc: "https://rpc.scroll.io",                explorer: "https://scrollscan.com/tx/" },
  arbitrum: { id: 42161, rpc: "https://arb1.arbitrum.io/rpc",         explorer: "https://arbiscan.io/tx/" },
  base:   { id: 8453,  rpc: "https://mainnet.base.org",             explorer: "https://basescan.org/tx/" },
  robinhood: { id: 4663, rpc: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com/tx/" },
};

const args = process.argv.slice(2);
let chainKey = null;
let sponsored = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chain") chainKey = args[i + 1];
  if (args[i] === "--sponsor") sponsored = true;
}
if (!chainKey || !CHAINS[chainKey]) {
  console.error(`Usage:`);
  console.error(`  PRIVATE_KEY=0x... node scripts/undelegate-7702.mjs --chain <${Object.keys(CHAINS).join("|")}>`);
  console.error(`  PRIVATE_KEY=0x... SPONSOR_PRIVATE_KEY=0x... node scripts/undelegate-7702.mjs --chain <chain> --sponsor`);
  process.exit(1);
}

const cfg = CHAINS[chainKey];
const targetPk = process.env.PRIVATE_KEY;
if (!targetPk) {
  console.error("Missing PRIVATE_KEY env (target EOA's key — the one to undelegate).");
  process.exit(1);
}

const sponsorPk = sponsored ? process.env.SPONSOR_PRIVATE_KEY : null;
if (sponsored && !sponsorPk) {
  console.error("--sponsor mode requires SPONSOR_PRIVATE_KEY env (gas payer's key).");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(cfg.rpc);
const target   = new ethers.Wallet(targetPk, provider);
const sponsor  = sponsorPk ? new ethers.Wallet(sponsorPk, provider) : target;

console.log(`Chain   : ${chainKey} (id ${cfg.id})`);
console.log(`Target  : ${target.address}`);
if (sponsored) console.log(`Sponsor : ${sponsor.address} (pays gas)`);

const beforeCode = await provider.getCode(target.address);
console.log(`Code    : ${beforeCode === "0x" ? "0x (no delegation — nothing to clear)" : beforeCode}`);
if (beforeCode === "0x") {
  console.log("Nothing to do — wallet is already a normal EOA on this chain.");
  process.exit(0);
}
if (!beforeCode.startsWith("0xef0100")) {
  console.error("This wallet has non-EIP-7702 code (not a delegated EOA). Aborting.");
  process.exit(1);
}

const targetNonce = await provider.getTransactionCount(target.address);
const sponsorBal  = await provider.getBalance(sponsor.address);
console.log(`Sponsor balance : ${ethers.formatEther(sponsorBal)} (gas needed ~21–50k)`);
if (sponsorBal === 0n) {
  console.error("Sponsor has 0 native balance — cannot pay gas.");
  process.exit(1);
}

// Authorization nonce handling:
//   - Self-paid: target EOA submits the TX itself, so its on-chain nonce
//     bumps by 1 between authorization use and TX inclusion → authorization
//     nonce must be `current + 1`.
//   - Sponsored: target EOA does NOT submit a TX, so its on-chain nonce is
//     unchanged when the authorization is processed → authorization nonce
//     must be the current value.
const authNonce = sponsored ? targetNonce : targetNonce + 1;
const authorization = await target.authorize({
  address: "0x0000000000000000000000000000000000000000",
  nonce:   authNonce,
  chainId: cfg.id,
});

// BSC requires a minimum gas tip cap of 0.05 gwei on type-4 TXs.
// Other chains' fee data is usually picked up correctly by ethers, but
// passing explicit EIP-1559 fees keeps the call portable.
const feeData = await provider.getFeeData();
const priorityFee = (feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas > 0n)
  ? feeData.maxPriorityFeePerGas
  : ethers.parseUnits("1", "gwei");
// Low-base-fee chains (e.g. Arbitrum Orbit / Robinhood) report maxFeePerGas below
// the 1 gwei priority fallback; raise the cap so priority <= maxFee stays valid and
// there is headroom above the current base fee.
let maxFee = (feeData.maxFeePerGas && feeData.maxFeePerGas > 0n)
  ? feeData.maxFeePerGas
  : ethers.parseUnits("5", "gwei");
if (maxFee < priorityFee) maxFee = priorityFee * 2n;

console.log(`\nSubmitting type-0x04 TX (authorization signed by target, address=0x0)...`);
const tx = await sponsor.sendTransaction({
  type: 4,
  to: sponsor.address,
  data: "0x",
  authorizationList: [authorization],
  maxPriorityFeePerGas: priorityFee,
  maxFeePerGas: maxFee,
});
console.log(`TX      : ${tx.hash}`);
console.log(`Explorer: ${cfg.explorer}${tx.hash}`);

const rcpt = await tx.wait();
console.log(`\nMined in block ${rcpt.blockNumber}, gas used: ${rcpt.gasUsed}`);

const afterCode = await provider.getCode(target.address);
console.log(`\nFinal code on chain: ${afterCode === "0x" ? "0x ✅ undelegated" : afterCode + " ⚠ still delegated"}`);
