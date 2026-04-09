/**
 * test-eth-eip7702.mjs
 * Ethereum Mainnet — Q402PaymentImplementation EIP-7702 테스트
 *
 * 흐름:
 *  1. Payer가 PaymentWitness EIP-712 서명 (verifyingContract = ETH impl)
 *  2. Payer가 EIP-7702 authorization 서명
 *  3. Relayer가 Type 4 TX 전송 → payer EOA에서 pay() 실행
 *  4. USDC (6 dec on ETH) payer → recipient 이동
 *
 * 실행: node scripts/test-eth-eip7702.mjs
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

// ── Config ─────────────────────────────────────────────────────────────────────
const PAYER_KEY   = envVars.TEST_PAYER_KEY;
const RELAYER_KEY = envVars.RELAYER_PRIVATE_KEY;
const RPC         = envVars.ETH_RPC_URL ?? "https://eth.llamarpc.com";
const CHAIN_ID    = 1;
const IMPL        = envVars.ETH_IMPLEMENTATION_CONTRACT ?? "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD";
// Ethereum USDC: 6 decimals (native Circle USDC)
const USDC        = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_DEC    = 6;
const RECIPIENT   = "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28";
const AMOUNT_USDC = "0.05"; // 0.05 USDC

if (!PAYER_KEY || !RELAYER_KEY) {
  console.error("❌ .env.local에 TEST_PAYER_KEY, RELAYER_PRIVATE_KEY 필요");
  process.exit(1);
}

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

async function main() {
  const payerAcc   = privateKeyToAccount(PAYER_KEY.startsWith("0x") ? PAYER_KEY : `0x${PAYER_KEY}`);
  const relayerAcc = privateKeyToAccount(RELAYER_KEY.startsWith("0x") ? RELAYER_KEY : `0x${RELAYER_KEY}`);

  const ethChain = {
    id: CHAIN_ID,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  const payerClient   = createWalletClient({ account: payerAcc,   chain: ethChain, transport: http(RPC) });
  const relayerClient = createWalletClient({ account: relayerAcc, chain: ethChain, transport: http(RPC) });
  const publicClient  = createPublicClient({ chain: ethChain, transport: http(RPC) });

  console.log("Payer:   ", payerAcc.address);
  console.log("Relayer: ", relayerAcc.address);
  console.log("Impl:    ", IMPL);

  // Check payer USDC balance
  const balRaw = await publicClient.readContract({
    address: USDC,
    abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [payerAcc.address],
  });
  console.log(`Payer USDC balance: ${(Number(balRaw) / 10 ** USDC_DEC).toFixed(6)} USDC`);

  const amount   = BigInt(Math.round(parseFloat(AMOUNT_USDC) * 10 ** USDC_DEC));
  const nonce    = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // ── Step 1: EIP-712 PaymentWitness 서명 ────────────────────────────────────
  console.log("\n[1/3] EIP-712 witnessSig...");
  const domain = {
    name: "Q402 Ethereum",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: IMPL,
  };
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
  const message = {
    owner:       payerAcc.address,
    facilitator: relayerAcc.address,
    token:       USDC,
    recipient:   RECIPIENT,
    amount,
    nonce,
    deadline,
  };
  const witnessSig = await payerClient.signTypedData({ domain, types, primaryType: "TransferAuthorization", message });
  console.log("witnessSig:", witnessSig.slice(0, 20) + "...");

  // ── Step 2: EIP-7702 authorization ─────────────────────────────────────────
  console.log("\n[2/3] EIP-7702 authorization...");
  const payerNonce = await publicClient.getTransactionCount({ address: payerAcc.address });
  const auth = await payerClient.experimental_signAuthorization({
    contractAddress: IMPL,
    nonce: payerNonce,
  });
  console.log("auth.yParity:", auth.yParity, "nonce:", auth.nonce);

  // ── Step 3: Relayer가 Type 4 TX 전송 ───────────────────────────────────────
  console.log("\n[3/3] Relayer sending Type 4 TX...");
  const callData = encodeFunctionData({
    abi: PAY_ABI,
    functionName: "pay",
    args: [payerAcc.address, USDC, amount, RECIPIENT, deadline, nonce, witnessSig],
  });

  const txHash = await relayerClient.sendTransaction({
    to: payerAcc.address,  // EIP-7702: 콜 대상이 payer EOA
    data: callData,
    gas: BigInt(300_000),
    authorizationList: [auth],
  });

  console.log("\n✅ TX sent:", txHash);
  console.log("   Etherscan: https://etherscan.io/tx/" + txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("   Status:", receipt.status, "Block:", receipt.blockNumber.toString());
  console.log("   Gas used:", receipt.gasUsed.toString());
  console.log("   Gas cost (ETH):", (Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice ?? 0n) / 1e18).toFixed(8), "ETH");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
