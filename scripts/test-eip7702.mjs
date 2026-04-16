/**
 * test-eip7702.mjs — Unified EIP-7702 on-chain test for all 5 Q402 chains.
 *
 *   node scripts/test-eip7702.mjs --chain <avax|bnb|eth|xlayer|stable> [--amount 0.05] [--to 0x...]
 *
 * Flow (identical for every chain — all 5 impl contracts share the same
 * TransferAuthorization witness + _domainSeparator(address(this)) scheme):
 *
 *   1. Payer signs TransferAuthorization EIP-712 (verifyingContract = payer EOA,
 *      domain name per-chain).
 *   2. Payer signs EIP-7702 authorization delegating the chain's impl contract.
 *   3. Relayer submits a Type-4 TX calling transferWithAuthorization() on the
 *      payer's EOA, which runs the impl bytecode and moves tokens.
 *
 * Requires .env.local with:
 *   TEST_PAYER_KEY         — payer (token owner) private key
 *   RELAYER_PRIVATE_KEY    — facilitator/relayer private key (pays gas)
 */

import { ethers } from "ethers";
import { createWalletClient, createPublicClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envVars = Object.fromEntries(
  readFileSync(resolve(__dir, "../.env.local"), "utf-8")
    .split("\n").filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    .filter(p => p[0])
);

const PAYER_KEY   = envVars.TEST_PAYER_KEY;
const RELAYER_KEY = envVars.RELAYER_PRIVATE_KEY;
if (!PAYER_KEY || !RELAYER_KEY) {
  console.error("Missing TEST_PAYER_KEY or RELAYER_PRIVATE_KEY in .env.local");
  process.exit(1);
}

// ── CLI args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith("--") ? [[a.slice(2), arr[i + 1]]] : []
  )
);
const chainKey = args.chain;
const amountIn = args.amount ?? "0.05";
const toArg    = args.to;

// ── Chain config (mirrors contracts.manifest.json) ──────────────────────────────
const CHAINS = {
  avax: {
    id: 43114, name: "Avalanche", domainName: "Q402 Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    impl: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, symbol: "USDC",
    explorer: "https://snowtrace.io/tx/",
  },
  bnb: {
    id: 56, name: "BNB Chain", domainName: "Q402 BNB Chain",
    rpc: "https://bsc-dataseed1.binance.org/",
    impl: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, symbol: "USDC",
    explorer: "https://bscscan.com/tx/",
  },
  eth: {
    id: 1, name: "Ethereum", domainName: "Q402 Ethereum",
    rpc: "https://ethereum.publicnode.com",
    impl: "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC",
    explorer: "https://etherscan.io/tx/",
  },
  xlayer: {
    id: 196, name: "X Layer", domainName: "Q402 X Layer",
    rpc: "https://rpc.xlayer.tech",
    impl: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    token: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6, symbol: "USDC",
    explorer: "https://www.oklink.com/xlayer/tx/",
  },
  stable: {
    id: 988, name: "Stable", domainName: "Q402 Stable",
    rpc: "https://rpc.stable.xyz",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // USDT0 is both the gas token and the transfer token on Stable (18 decimals).
    token: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18, symbol: "USDT0",
    explorer: "https://stablescan.org/tx/",
  },
};

if (!chainKey || !CHAINS[chainKey]) {
  console.error(`Usage: node scripts/test-eip7702.mjs --chain <${Object.keys(CHAINS).join("|")}> [--amount N] [--to 0x...]`);
  process.exit(1);
}
const cfg = CHAINS[chainKey];

const IMPL_ABI = [{
  type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable",
  inputs: [
    { name: "owner",            type: "address" },
    { name: "facilitator",      type: "address" },
    { name: "token",            type: "address" },
    { name: "recipient",        type: "address" },
    { name: "amount",           type: "uint256" },
    { name: "nonce",            type: "uint256" },
    { name: "deadline",         type: "uint256" },
    { name: "witnessSignature", type: "bytes"   },
  ],
  outputs: [],
}];

const TRANSFER_AUTH_TYPES = {
  TransferAuthorization: [
    { name: "owner",       type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token",       type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "uint256" },
    { name: "deadline",    type: "uint256" },
  ],
};

async function main() {
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const payer    = new ethers.Wallet(PAYER_KEY.startsWith("0x") ? PAYER_KEY : `0x${PAYER_KEY}`, provider);
  const relayer  = new ethers.Wallet(RELAYER_KEY.startsWith("0x") ? RELAYER_KEY : `0x${RELAYER_KEY}`, provider);
  const relayerAcc = privateKeyToAccount(
    RELAYER_KEY.startsWith("0x") ? RELAYER_KEY : `0x${RELAYER_KEY}`
  );

  const recipient = toArg ?? relayer.address;
  const amountRaw = BigInt(Math.round(parseFloat(amountIn) * 10 ** cfg.decimals));
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce     = ethers.toBigInt(ethers.randomBytes(32));

  console.log("=".repeat(60));
  console.log(`Q402 ${cfg.name} — EIP-7702 TransferAuthorization test`);
  console.log("=".repeat(60));
  console.log(`Payer (owner)   : ${payer.address}`);
  console.log(`Relayer (facil.): ${relayer.address}`);
  console.log(`Recipient       : ${recipient}`);
  console.log(`Impl            : ${cfg.impl}`);
  console.log(`Amount          : ${amountIn} ${cfg.symbol}`);

  // [1/3] TransferAuthorization EIP-712 signature (verifyingContract = payer EOA)
  console.log("\n[1/3] Signing TransferAuthorization (verifyingContract = payer EOA)...");
  const domain = {
    name:              cfg.domainName,
    version:           "1",
    chainId:           cfg.id,
    verifyingContract: payer.address,
  };
  const witnessSig = await payer.signTypedData(domain, TRANSFER_AUTH_TYPES, {
    owner:       payer.address,
    facilitator: relayer.address,
    token:       cfg.token,
    recipient,
    amount:      amountRaw,
    nonce,
    deadline,
  });
  console.log(`   witnessSig: ${witnessSig.slice(0, 30)}...`);

  // [2/3] EIP-7702 authorization signature
  console.log("\n[2/3] Signing EIP-7702 authorization...");
  const payerTxNonce = await provider.getTransactionCount(payer.address);
  const authDomain = { name: "EIP7702Authorization", version: "1", chainId: cfg.id };
  const authTypes  = {
    Authorization: [
      { name: "address", type: "address" },
      { name: "nonce",   type: "uint256" },
    ],
  };
  const authSig = await payer.signTypedData(authDomain, authTypes, {
    address: cfg.impl,
    nonce:   payerTxNonce,
  });
  const authR   = authSig.slice(0, 66);
  const authS   = "0x" + authSig.slice(66, 130);
  const authV   = parseInt(authSig.slice(130, 132), 16);
  const yParity = authV === 27 ? 0 : 1;
  console.log(`   payerTxNonce: ${payerTxNonce}, yParity: ${yParity}`);

  // [3/3] Submit Type-4 TX via viem
  console.log("\n[3/3] Sending EIP-7702 Type-4 TX (relayer pays gas)...");
  const walletClient = createWalletClient({ account: relayerAcc, transport: http(cfg.rpc) });
  const publicClient = createPublicClient({ transport: http(cfg.rpc) });

  const callData = encodeFunctionData({
    abi:          IMPL_ABI,
    functionName: "transferWithAuthorization",
    args:         [payer.address, relayer.address, cfg.token, recipient, amountRaw, nonce, deadline, witnessSig],
  });

  const txHash = await walletClient.sendTransaction({
    chain: null,
    to:    payer.address,
    data:  callData,
    gas:   300_000n,
    authorizationList: [{
      chainId: cfg.id,
      address: cfg.impl,
      nonce:   payerTxNonce,
      yParity,
      r: authR,
      s: authS,
    }],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const success = receipt.status === "success";

  console.log("\n" + "=".repeat(60));
  console.log(`${success ? "SUCCESS" : "REVERTED"} — block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  console.log(`${cfg.explorer}${txHash}`);
  console.log("=".repeat(60));

  if (!success) process.exit(1);
}

main().catch(e => { console.error("Error:", e.message ?? e); process.exit(1); });
