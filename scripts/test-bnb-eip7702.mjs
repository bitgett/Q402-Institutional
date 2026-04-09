/**
 * test-bnb-eip7702.mjs
 * BNB Chain — Q402PaymentImplementationBNB EIP-7702 테스트
 *
 * 흐름:
 *  1. Payer가 PaymentWitness EIP-712 서명 (verifyingContract = BNB impl)
 *  2. Payer가 EIP-7702 authorization 서명
 *  3. Relayer가 Type 4 TX 전송 → payer EOA에서 pay() 실행
 *  4. USDC (18 dec on BNB) payer → recipient 이동
 *
 * 실행: node scripts/test-bnb-eip7702.mjs
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
const RPC         = "https://bsc-dataseed.binance.org";
const CHAIN_ID    = 56;
const IMPL        = envVars.BNB_IMPLEMENTATION_CONTRACT ?? "0x6cF4aD62C208b6494a55a1494D497713ba013dFa";
// BNB USDC: 18 decimals (Binance-pegged)
const USDC        = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const USDC_DEC    = 18;
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

const ERC20_APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}];

async function main() {
  const payerAcc   = privateKeyToAccount(PAYER_KEY.startsWith("0x") ? PAYER_KEY : `0x${PAYER_KEY}`);
  const relayerAcc = privateKeyToAccount(RELAYER_KEY.startsWith("0x") ? RELAYER_KEY : `0x${RELAYER_KEY}`);

  const bnbChain = { id: CHAIN_ID, name: "BNB Chain", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const payerClient   = createWalletClient({ account: payerAcc,   chain: bnbChain, transport: http(RPC) });
  const relayerClient = createWalletClient({ account: relayerAcc, chain: bnbChain, transport: http(RPC) });
  const publicClient  = createPublicClient({ chain: bnbChain, transport: http(RPC) });

  console.log("Payer:   ", payerAcc.address);
  console.log("Relayer: ", relayerAcc.address);
  console.log("Impl:    ", IMPL);

  const amount   = BigInt(parseFloat(AMOUNT_USDC) * 10 ** USDC_DEC);
  const nonce    = BigInt(ethers.hexlify(ethers.randomBytes(32)));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // ── Step 1: EIP-712 PaymentWitness 서명 ────────────────────────────────────
  console.log("\n[1/3] EIP-712 witnessSig...");
  const domain = {
    name: "Q402 BNB Chain",
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

  // ── Step 3: USDC approve (if needed) ───────────────────────────────────────
  // EIP-7702 방식에서는 payer EOA가 impl 코드를 위임받아 실행됨 →
  // USDC allowance는 payer → payer (self-approval from impl context) 필요 없음
  // pay() 함수 내부에서 transferFrom(owner, to, amount) 호출 → owner가 address(this)
  // 따라서 approve 불필요

  // ── Step 4: Relayer가 Type 4 TX 전송 ───────────────────────────────────────
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
  console.log("   BscScan: https://bscscan.com/tx/" + txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("   Status:", receipt.status, "Block:", receipt.blockNumber.toString());
  console.log("   Gas used:", receipt.gasUsed.toString());
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
