/**
 * agent-example.mjs
 * Q402 Node.js Agent SDK — 모든 5개 체인 완전한 워크플로 예제
 *
 * 사용 사례: AI 에이전트, 백엔드 서버, 자동화 시스템에서
 * 가스 없이 USDC/USDT 결제를 처리하는 방법
 *
 * 실행: node scripts/agent-example.mjs
 * 필요: .env.local에 Q402_API_KEY, AGENT_WALLET_KEY
 */

import { ethers } from "ethers";
import { createWalletClient, createPublicClient, http, encodeFunctionData } from "viem";
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
const API_KEY    = envVars.Q402_API_KEY;          // your q402_live_... key
const AGENT_KEY  = envVars.TEST_PAYER_KEY;         // agent wallet private key
const API_BASE   = envVars.Q402_API_BASE ?? "https://q402-institutional.vercel.app";

// Chain configurations
const CHAINS = {
  avax: {
    id: 43114,
    name: "Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    impl: envVars.AVAX_IMPLEMENTATION_CONTRACT ?? "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdcDec: 6,
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    explorerBase: "https://snowtrace.io/tx/",
    domainName: "Q402 Avalanche",
  },
  bnb: {
    id: 56,
    name: "BNB Chain",
    rpc: "https://bsc-dataseed.binance.org",
    impl: envVars.BNB_IMPLEMENTATION_CONTRACT ?? "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdcDec: 18,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    explorerBase: "https://bscscan.com/tx/",
    domainName: "Q402 BNB Chain",
  },
  eth: {
    id: 1,
    name: "Ethereum",
    rpc: envVars.ETH_RPC_URL ?? "https://eth.llamarpc.com",
    impl: envVars.ETH_IMPLEMENTATION_CONTRACT ?? "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDec: 6,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerBase: "https://etherscan.io/tx/",
    domainName: "Q402 Ethereum",
  },
  xlayer: {
    id: 196,
    name: "X Layer",
    rpc: "https://rpc.xlayer.tech",
    impl: envVars.XLAYER_IMPLEMENTATION_CONTRACT ?? "0x31E9D105df96b5294298cFaffB7f106994CD0d0f",
    usdc: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
    usdcDec: 6,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    explorerBase: "https://www.oklink.com/xlayer/tx/",
    domainName: "Q402 XLayer",
    isXLayer: true,  // uses TransferAuthorization with EOA as verifyingContract
  },
  stable: {
    id: 988,
    name: "Stable",
    rpc: "https://rpc.stablechain.io",
    impl: envVars.STABLE_IMPLEMENTATION_CONTRACT ?? "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    usdc: "0x5FD84259d66Cd46123540766Be93DFE6D43130D7", // USDT0
    usdcDec: 6,
    nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 6 },
    explorerBase: "https://explorer.stablechain.io/tx/",
    domainName: "Q402 Stable",
  },
};

const PAY_ABI = [{
  type: "function", name: "pay", stateMutability: "nonpayable",
  inputs: [
    { name: "owner",      type: "address" },
    { name: "token",      type: "address" },
    { name: "amount",     type: "uint256" },
    { name: "to",         type: "address" },
    { name: "deadline",   type: "uint256" },
    { name: "nonce",      type: "uint256" },
    { name: "witnessSig", type: "bytes"   },
  ],
  outputs: [],
}];

const TRANSFER_AUTH_ABI = [{
  type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable",
  inputs: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
    { name: "signature",   type: "bytes"   },
  ],
  outputs: [],
}];

// ── Core: Sign EIP-712 PaymentWitness ──────────────────────────────────────────
async function signPaymentWitness({ chain, agentAcc, facilitator, token, recipient, amount, nonce, deadline }) {
  const cfg = CHAINS[chain];
  const viemChain = {
    id: cfg.id, name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [cfg.rpc] } },
  };
  const walletClient = createWalletClient({ account: agentAcc, chain: viemChain, transport: http(cfg.rpc) });

  // XLayer: verifyingContract = agentAcc.address (EOA), not impl
  const verifyingContract = cfg.isXLayer ? agentAcc.address : cfg.impl;

  const domain = {
    name: cfg.domainName,
    version: "1",
    chainId: cfg.id,
    verifyingContract,
  };

  if (cfg.isXLayer) {
    // XLayer uses TransferAuthorization (EIP-3009 style)
    const types = {
      TransferAuthorization: [
        { name: "from",        type: "address" },
        { name: "to",          type: "address" },
        { name: "value",       type: "uint256" },
        { name: "validAfter",  type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce",       type: "bytes32" },
      ],
    };
    const message = {
      from:        agentAcc.address,
      to:          recipient,
      value:       amount,
      validAfter:  0n,
      validBefore: deadline,
      nonce:       ethers.zeroPadValue(ethers.toBeHex(nonce), 32),
    };
    return walletClient.signTypedData({ domain, types, primaryType: "TransferAuthorization", message });
  } else {
    // AVAX / BNB / ETH / Stable use same TransferAuthorization with facilitator
    const types = {
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
    const message = { owner: agentAcc.address, facilitator, token, recipient, amount, nonce, deadline };
    return walletClient.signTypedData({ domain, types, primaryType: "TransferAuthorization", message });
  }
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
async function submitToRelay({ chain, token, agentAddress, recipient, amount, deadline, nonce, witnessSig, auth, xlayerNonce }) {
  const payload = {
    apiKey: API_KEY,
    chain,
    token,
    from: agentAddress,
    to: recipient,
    amount: amount.toString(),
    deadline: deadline.toString(),
    nonce: nonce.toString(),
    witnessSig,
    authorization: auth,
    ...(xlayerNonce !== undefined ? { xlayerNonce: xlayerNonce.toString() } : {}),
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
  if (!API_KEY)  throw new Error("Q402_API_KEY not set in .env.local");
  if (!AGENT_KEY) throw new Error("TEST_PAYER_KEY not set in .env.local");

  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}. Valid: ${Object.keys(CHAINS).join(", ")}`);

  const agentAcc = privateKeyToAccount(AGENT_KEY.startsWith("0x") ? AGENT_KEY : `0x${AGENT_KEY}`);
  const amount   = BigInt(Math.round(amountUSD * 10 ** cfg.usdcDec));
  const nonce    = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log(`\n[${chain.toUpperCase()}] Sending ${amountUSD} USDC → ${recipient.slice(0,10)}...`);
  console.log(`  Agent:   ${agentAcc.address}`);
  console.log(`  Amount:  ${amount.toString()} (${cfg.usdcDec} dec)`);

  // 1. Get facilitator address (needed for non-XLayer witness signature)
  let facilitator = agentAcc.address; // fallback
  try {
    const infoRes = await fetch(`${API_BASE}/api/relay/info`);
    if (infoRes.ok) {
      const info = await infoRes.json();
      facilitator = info.facilitator ?? facilitator;
    }
  } catch { /* use fallback */ }
  console.log(`  Facilitator: ${facilitator.slice(0,10)}...`);

  // 2. Sign EIP-712 payment witness
  console.log("  [1/3] Signing EIP-712 witness...");
  const witnessSig = await signPaymentWitness({
    chain, agentAcc, facilitator,
    token: cfg.usdc, recipient, amount, nonce, deadline,
  });
  console.log(`  witnessSig: ${witnessSig.slice(0, 20)}...`);

  // 3. Sign EIP-7702 authorization
  console.log("  [2/3] Signing EIP-7702 auth...");
  const auth = await signEIP7702Auth({ chain, agentAcc });
  console.log(`  auth.yParity: ${auth.yParity}, nonce: ${auth.nonce}`);

  // 4. Submit to relay
  console.log("  [3/3] Submitting to Q402 relay...");
  const result = await submitToRelay({
    chain,
    token: cfg.usdc,
    agentAddress: agentAcc.address,
    recipient,
    amount,
    deadline,
    nonce,
    witnessSig,
    auth,
    xlayerNonce: cfg.isXLayer ? nonce : undefined,
  });

  console.log(`  ✅ TX hash: ${result.txHash}`);
  console.log(`  Explorer: ${cfg.explorerBase}${result.txHash}`);
  console.log(`  Method: ${result.method}`);
  return result;
}

// ── Demo ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Q402 Agent SDK Example ===");
  console.log(`API Base: ${API_BASE}`);
  console.log(`API Key: ${API_KEY ? API_KEY.slice(0, 15) + "..." : "NOT SET"}`);

  const RECIPIENT = "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28";
  const AMOUNT    = 0.05; // 0.05 USDC per chain

  // Example 1: Single chain payment
  // const result = await sendGaslessPayment({ chain: "avax", recipient: RECIPIENT, amountUSD: AMOUNT });

  // Example 2: Multi-chain sequential payments
  const chains = ["avax", "bnb"]; // add "eth", "xlayer", "stable" as needed
  for (const chain of chains) {
    try {
      await sendGaslessPayment({ chain, recipient: RECIPIENT, amountUSD: AMOUNT });
    } catch (e) {
      console.error(`  ❌ ${chain}: ${e.message}`);
    }
  }

  console.log("\n=== Done ===");
}

// ── Export for use as a module ─────────────────────────────────────────────────
export { sendGaslessPayment, signPaymentWitness, signEIP7702Auth, submitToRelay, CHAINS };

// Run if executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => { console.error("❌", e.message); process.exit(1); });
}
