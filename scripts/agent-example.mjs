/**
 * agent-example.mjs
 * Q402 Node.js Agent SDK — unified example for all 5 Q402 chains.
 *
 * Signing scheme (identical for every chain):
 *   - Witness type: TransferAuthorization(owner, facilitator, token, recipient,
 *                   amount, nonce, deadline).
 *   - verifyingContract = the payer's own EOA (the impl contract's
 *     _domainSeparator() uses address(this), which resolves to the EOA under
 *     EIP-7702 delegation).
 *   - Per-chain domain name matches the contract's NAME constant.
 *
 * Relay API request shape (mirrors app/api/relay/route.ts POST body):
 *   - `token` is ALWAYS the ERC-20 symbol string "USDC" or "USDT" — never an
 *     address. The server looks up the address from CHAIN_CONFIG[chain][token].
 *   - `amount` is an atomic uint256 string (e.g. "50000" for 0.05 USDC @ 6dp).
 *   - avax / bnb / eth → send `nonce` (uint256 string) + `authorization`.
 *   - xlayer          → send `xlayerNonce` (uint256 string) + `authorization`.
 *   - stable          → send `stableNonce` (uint256 string) + `authorization`.
 *   - X Layer's EIP-3009 fallback uses `eip3009Nonce` (bytes32 hex) and omits
 *     `authorization`; not shown here because EIP-7702 is the primary path.
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
const API_BASE  = envVars.Q402_API_BASE ?? "https://q402.quackai.ai";

// Chain configurations — mirrors contracts.manifest.json and app/lib/relayer.ts.
// Each chain lists both tokens with their on-chain address and decimals; the
// example passes the SYMBOL to the relay API, and uses the address+decimals
// only to build the EIP-712 witness message and compute atomic amounts.
const CHAINS = {
  avax: {
    id: 43114, name: "Avalanche", domainName: "Q402 Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    impl: envVars.AVAX_IMPLEMENTATION_CONTRACT ?? "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    tokens: {
      USDC: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
      USDT: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    },
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    explorerBase: "https://snowtrace.io/tx/",
    nonceField: "nonce",
  },
  bnb: {
    id: 56, name: "BNB Chain", domainName: "Q402 BNB Chain",
    rpc: "https://bsc-dataseed.binance.org",
    impl: envVars.BNB_IMPLEMENTATION_CONTRACT ?? "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    tokens: {
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    },
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    explorerBase: "https://bscscan.com/tx/",
    nonceField: "nonce",
  },
  eth: {
    id: 1, name: "Ethereum", domainName: "Q402 Ethereum",
    rpc: envVars.ETH_RPC_URL ?? "https://ethereum.publicnode.com",
    impl: envVars.ETH_IMPLEMENTATION_CONTRACT ?? "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    tokens: {
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    },
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorerBase: "https://etherscan.io/tx/",
    nonceField: "nonce",
  },
  xlayer: {
    id: 196, name: "X Layer", domainName: "Q402 X Layer",
    rpc: "https://rpc.xlayer.tech",
    impl: envVars.XLAYER_IMPLEMENTATION_CONTRACT ?? "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    tokens: {
      USDC: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
      USDT: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
    },
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    explorerBase: "https://www.oklink.com/xlayer/tx/",
    nonceField: "xlayerNonce",
  },
  stable: {
    id: 988, name: "Stable", domainName: "Q402 Stable",
    rpc: "https://rpc.stable.xyz",
    impl: envVars.STABLE_IMPLEMENTATION_CONTRACT ?? "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // On Stable, "USDC" and "USDT" are both API aliases for USDT0 (18 dec).
    tokens: {
      USDC: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
      USDT: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    },
    nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
    explorerBase: "https://stablescan.org/tx/",
    nonceField: "stableNonce",
  },
  mantle: {
    id: 5000, name: "Mantle", domainName: "Q402 Mantle",
    rpc: envVars.MANTLE_RPC_URL ?? "https://rpc.mantle.xyz",
    impl: envVars.MANTLE_IMPLEMENTATION_CONTRACT ?? "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    tokens: {
      USDC: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
      USDT: { address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", decimals: 6 },
    },
    nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
    explorerBase: "https://explorer.mantle.xyz/tx/",
    nonceField: "nonce",
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
async function signTransferAuthorization({
  chain, agentAcc, facilitator, tokenAddress, recipient, amount, nonce, deadline,
}) {
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
    token:       tokenAddress,
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

// Human-readable amount → atomic bigint. String-only by design —
// matches public/q402-sdk.js::toRawAmount so the two execution paths share one
// policy. Accepting JS Number here (even with toFixed clamping) would silently
// preserve IEEE-754-corrupted values on 18-decimal tokens, which is the entire
// bug the browser SDK rewrite was there to kill. Callers pass "10" / "5.00" /
// "0.123456" — partners migrating from a numeric field just wrap it in quotes.
function toAtomicAmount(amount, decimals) {
  if (typeof amount !== "string" || amount.trim() === "") {
    throw new Error('amount must be a non-empty decimal string (e.g. "5.00"); JS Number is rejected to avoid IEEE-754 precision loss');
  }
  const str = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`invalid amount "${amount}" — use a positive decimal string (no sign, no scientific notation, no whitespace)`);
  }
  let raw;
  try {
    raw = ethers.parseUnits(str, decimals);
  } catch {
    throw new Error(`amount "${amount}" has more than ${decimals} decimal places for this token`);
  }
  if (raw <= 0n) throw new Error(`amount must be greater than zero (got "${amount}")`);
  return raw;
}

// ── Core: Submit via Q402 Relay API ───────────────────────────────────────────
// Body shape MUST match app/api/relay/route.ts:
//   - `token` is the symbol string ("USDC" | "USDT"), never an address.
//   - The nonce field name is chain-specific (nonce | xlayerNonce | stableNonce).
async function submitToRelay({
  chain, tokenSymbol, agentAddress, recipient, amount, deadline, nonceStr, witnessSig, auth,
}) {
  const cfg = CHAINS[chain];
  const payload = {
    apiKey:   API_KEY,
    chain,
    token:    tokenSymbol,
    from:     agentAddress,
    to:       recipient,
    amount:   amount.toString(),
    deadline: Number(deadline),
    witnessSig,
    authorization: auth,
    [cfg.nonceField]: nonceStr,
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
async function sendGaslessPayment({ chain, token = "USDC", recipient, amount }) {
  if (!API_KEY)   throw new Error("Q402_API_KEY not set in .env.local");
  if (!AGENT_KEY) throw new Error("TEST_PAYER_KEY not set in .env.local");

  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}. Valid: ${Object.keys(CHAINS).join(", ")}`);

  const tokenSymbol = token.toUpperCase();
  if (tokenSymbol !== "USDC" && tokenSymbol !== "USDT") {
    throw new Error(`token must be "USDC" or "USDT" (received: ${token})`);
  }
  const tokenCfg = cfg.tokens[tokenSymbol];

  const agentAcc  = privateKeyToAccount(AGENT_KEY.startsWith("0x") ? AGENT_KEY : `0x${AGENT_KEY}`);
  const amountRaw = toAtomicAmount(amount, tokenCfg.decimals);
  const nonce     = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log(`\n[${chain.toUpperCase()}] Sending ${amount} ${tokenSymbol} → ${recipient.slice(0, 10)}...`);
  console.log(`  Agent:    ${agentAcc.address}`);
  console.log(`  Amount:   ${amountRaw.toString()} atomic (${tokenCfg.decimals} dec)`);
  console.log(`  Nonce fld:${cfg.nonceField}`);

  // 1. Get facilitator address (required — part of the signed witness message)
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
  console.log(`  Faciltr:  ${facilitator.slice(0, 10)}...`);

  // 2. Sign EIP-712 TransferAuthorization
  console.log("  [1/3] Signing TransferAuthorization...");
  const witnessSig = await signTransferAuthorization({
    chain, agentAcc, facilitator,
    tokenAddress: tokenCfg.address,
    recipient, amount: amountRaw, nonce, deadline,
  });
  console.log(`  witnessSig: ${witnessSig.slice(0, 20)}...`);

  // 3. Sign EIP-7702 authorization
  console.log("  [2/3] Signing EIP-7702 authorization...");
  const auth = await signEIP7702Auth({ chain, agentAcc });
  console.log(`  auth.yParity: ${auth.yParity}, auth.nonce: ${auth.nonce}`);

  // 4. Submit to relay
  console.log("  [3/3] Submitting to Q402 relay...");
  const result = await submitToRelay({
    chain,
    tokenSymbol,
    agentAddress: agentAcc.address,
    recipient,
    amount: amountRaw,
    deadline,
    nonceStr: nonce.toString(),
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
  const AMOUNT    = "0.05"; // MUST be a decimal string — Number is rejected (IEEE-754).

  // Multi-chain sequential payments — add "eth", "xlayer", "stable", "mantle" as needed.
  const chains = ["avax", "bnb"];
  for (const chain of chains) {
    try {
      await sendGaslessPayment({ chain, token: "USDC", recipient: RECIPIENT, amount: AMOUNT });
    } catch (e) {
      console.error(`  FAILED — ${chain}: ${e.message}`);
    }
  }

  console.log("\n=== Done ===");
}

// ── Export for use as a module ─────────────────────────────────────────────────
export {
  sendGaslessPayment,
  signTransferAuthorization,
  signEIP7702Auth,
  submitToRelay,
  CHAINS,
};

// Run if executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
}
