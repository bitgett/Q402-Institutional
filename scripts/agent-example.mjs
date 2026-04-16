/**
 * agent-example.mjs
 * Q402 Node.js Agent SDK — unified example for all 5 Q402 chains.
 *
 * All chains (avax, bnb, eth, xlayer, stable) share the same on-chain scheme:
 *   - Witness type: TransferAuthorization(owner, facilitator, token, recipient,
 *                   amount, nonce, deadline).
 *   - verifyingContract = the payer's own EOA (under EIP-7702 delegation,
 *     _domainSeparator() uses address(this)).
 *   - Per-chain domain name matches the NAME constant in the impl contract.
 *
 * Use case: AI agents, backend servers, and automation pipelines paying in
 * USDC/USDT (or USDT0 on Stable) without holding gas on the source chain.
 *
 * Run:     node scripts/agent-example.mjs
 * Needs:   .env.local with Q402_API_KEY and TEST_PAYER_KEY (agent wallet key).
 */

import { ethers } from "ethers";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envVars = Object.fromEntries(
  readFileSync(resolve(__dir, "../.env.local"), "utf-8")
    .split("\n").filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    .filter(p => p[0])
);

// ── Configuration ───────────────────────────────────────────────────────────────
const API_KEY   = envVars.Q402_API_KEY;
const AGENT_KEY = envVars.TEST_PAYER_KEY;
const API_BASE  = envVars.Q402_API_BASE ?? "https://q402-institutional.vercel.app";

// Chain configurations — mirrors contracts.manifest.json
const CHAINS = {
  avax: {
    id: 43114, name: "Avalanche", domainName: "Q402 Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    impl: envVars.AVAX_IMPLEMENTATION_CONTRACT ?? "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, symbol: "USDC",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    explorerBase: "https://snowtrace.io/tx/",
  },
  bnb: {
    id: 56, name: "BNB Chain", domainName: "Q402 BNB Chain",
    rpc: "https://bsc-dataseed.binance.org",
    impl: envVars.BNB_IMPLEMENTATION_CONTRACT ?? "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, symbol: "USDC",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    explorerBase: "https://bscscan.com/tx/",
  },
  eth: {
    id: 1, name: "Ethereum", domainName: "Q402 Ethereum",
    rpc: envVars.ETH_RPC_URL ?? "https://ethereum.publicnode.com",
    impl: envVars.ETH_IMPLEMENTATION_CONTRACT ?? "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerBase: "https://etherscan.io/tx/",
  },
  xlayer: {
    id: 196, name: "X Layer", domainName: "Q402 X Layer",
    rpc: "https://rpc.xlayer.tech",
    impl: envVars.XLAYER_IMPLEMENTATION_CONTRACT ?? "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    token: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6, symbol: "USDC",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    explorerBase: "https://www.oklink.com/xlayer/tx/",
  },
  stable: {
    id: 988, name: "Stable", domainName: "Q402 Stable",
    rpc: "https://rpc.stable.xyz",
    impl: envVars.STABLE_IMPLEMENTATION_CONTRACT ?? "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // USDT0 is both the gas token and the transfer token on Stable (18 decimals).
    token: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18, symbol: "USDT0",
    nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
    explorerBase: "https://stablescan.org/tx/",
  },
};

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

// ── Core: Sign EIP-712 TransferAuthorization (verifyingContract = agent EOA) ───
async function signTransferAuthorization({ chain, agentAcc, facilitator, recipient, amount, nonce, deadline }) {
  const cfg = CHAINS[chain];
  const viemChain = {
    id: cfg.id, name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [cfg.rpc] } },
  };
  const walletClient = createWalletClient({ account: agentAcc, chain: viemChain, transport: http(cfg.rpc) });

  const domain = {
    name:              cfg.domainName,
    version:           "1",
    chainId:           cfg.id,
    verifyingContract: agentAcc.address,
  };
  const message = {
    owner:       agentAcc.address,
    facilitator,
    token:       cfg.token,
    recipient,
    amount,
    nonce,
    deadline,
  };
  return walletClient.signTypedData({
    domain, types: TRANSFER_AUTH_TYPES,
    primaryType: "TransferAuthorization", message,
  });
}

// ── Core: Sign EIP-7702 Authorization ─────────────────────────────────────────
async function signEIP7702Auth({ chain, agentAcc }) {
  const cfg = CHAINS[chain];
  const viemChain = {
    id: cfg.id, name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [cfg.rpc] } },
  };
  const walletClient = createWalletClient({ account: agentAcc, chain: viemChain, transport: http(cfg.rpc) });
  const publicClient = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });

  const agentNonce = await publicClient.getTransactionCount({ address: agentAcc.address });
  return walletClient.experimental_signAuthorization({
    contractAddress: cfg.impl,
    nonce: agentNonce,
  });
}

// ── Core: Submit via Q402 Relay API ───────────────────────────────────────────
async function submitToRelay({ chain, token, agentAddress, recipient, amount, deadline, nonce, witnessSig, auth }) {
  const payload = {
    apiKey: API_KEY,
    chain,
    token,
    from:     agentAddress,
    to:       recipient,
    amount:   amount.toString(),
    deadline: deadline.toString(),
    nonce:    nonce.toString(),
    witnessSig,
    authorization: auth,
  };

  const res = await fetch(`${API_BASE}/api/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Relay failed (${res.status}): ${data.error ?? JSON.stringify(data)}`);
  return data;
}

// ── High-level: Send gasless payment on any chain ─────────────────────────────
async function sendGaslessPayment({ chain, recipient, amountUSD }) {
  if (!API_KEY)   throw new Error("Q402_API_KEY not set in .env.local");
  if (!AGENT_KEY) throw new Error("TEST_PAYER_KEY not set in .env.local");

  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}. Valid: ${Object.keys(CHAINS).join(", ")}`);

  const agentAcc = privateKeyToAccount(AGENT_KEY.startsWith("0x") ? AGENT_KEY : `0x${AGENT_KEY}`);
  const amount   = BigInt(Math.round(amountUSD * 10 ** cfg.decimals));
  const nonce    = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log(`\n[${chain.toUpperCase()}] Sending ${amountUSD} ${cfg.symbol} → ${recipient.slice(0, 10)}...`);
  console.log(`  Agent:   ${agentAcc.address}`);
  console.log(`  Amount:  ${amount.toString()} (${cfg.decimals} dec)`);

  // 1. Get facilitator address (required — it is part of the witness message)
  let facilitator;
  try {
    const infoRes = await fetch(`${API_BASE}/api/relay/info`);
    if (!infoRes.ok) throw new Error(`/api/relay/info returned ${infoRes.status}`);
    const info = await infoRes.json();
    facilitator = info.facilitator;
    if (!facilitator) throw new Error("/api/relay/info did not return a facilitator address");
  } catch (e) {
    throw new Error(`Unable to resolve facilitator: ${e.message}`);
  }
  console.log(`  Facilitator: ${facilitator.slice(0, 10)}...`);

  // 2. Sign EIP-712 TransferAuthorization
  console.log("  [1/3] Signing TransferAuthorization...");
  const witnessSig = await signTransferAuthorization({
    chain, agentAcc, facilitator, recipient, amount, nonce, deadline,
  });
  console.log(`  witnessSig: ${witnessSig.slice(0, 20)}...`);

  // 3. Sign EIP-7702 authorization
  console.log("  [2/3] Signing EIP-7702 authorization...");
  const auth = await signEIP7702Auth({ chain, agentAcc });
  console.log(`  auth.yParity: ${auth.yParity}, nonce: ${auth.nonce}`);

  // 4. Submit to relay
  console.log("  [3/3] Submitting to Q402 relay...");
  const result = await submitToRelay({
    chain,
    token: cfg.token,
    agentAddress: agentAcc.address,
    recipient,
    amount,
    deadline,
    nonce,
    witnessSig,
    auth,
  });

  console.log(`  SUCCESS — txHash: ${result.txHash}`);
  console.log(`  Explorer: ${cfg.explorerBase}${result.txHash}`);
  console.log(`  Method:   ${result.method}`);
  return result;
}

// ── Demo ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Q402 Agent SDK Example ===");
  console.log(`API Base: ${API_BASE}`);
  console.log(`API Key:  ${API_KEY ? API_KEY.slice(0, 15) + "..." : "NOT SET"}`);

  const RECIPIENT = "0xd4e81234567890abcdef1234567890abcdef0a3f"; // replace with your recipient
  const AMOUNT    = 0.05;

  // Multi-chain sequential payments — add "eth", "xlayer", "stable" as needed.
  const chains = ["avax", "bnb"];
  for (const chain of chains) {
    try {
      await sendGaslessPayment({ chain, recipient: RECIPIENT, amountUSD: AMOUNT });
    } catch (e) {
      console.error(`  FAILED — ${chain}: ${e.message}`);
    }
  }

  console.log("\n=== Done ===");
}

// ── Export for use as a module ─────────────────────────────────────────────────
export { sendGaslessPayment, signTransferAuthorization, signEIP7702Auth, submitToRelay, CHAINS };

// Run if executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
}
