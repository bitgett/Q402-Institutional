/**
 * test-relay.mjs — Q402 가스리스 페이먼트 End-to-End 테스트
 *
 * 실행: node scripts/test-relay.mjs
 * 사전 조건: npm run dev 실행 중
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── .env.local 로드 ────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
const envVars = Object.fromEntries(
  readFileSync(envPath, "utf-8")
    .split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => l.split("=").map(s => s.trim()))
    .filter(p => p.length === 2)
);

// ── 설정 ───────────────────────────────────────────────────────────────────────
const PAYER_KEY      = envVars.TEST_PAYER_KEY;
const RELAY_URL      = "http://localhost:3003/api/relay";
const API_KEY        = "q402_live_test_masterkey";
const CHAIN          = "avax";
const CHAIN_ID       = 43114;
const RPC            = "https://api.avax.network/ext/bc/C/rpc";
const IMPL_CONTRACT  = "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699";
const USDC_ADDRESS   = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const USDC_DECIMALS  = 6;
const RECIPIENT      = "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28";
const AMOUNT_USDC    = "1.00"; // 테스트: 1 USDC

if (!PAYER_KEY) {
  console.error("❌ TEST_PAYER_KEY not set in .env.local");
  process.exit(1);
}

// ── EIP-712 타입 (SDK와 동일) ──────────────────────────────────────────────────
const WITNESS_TYPES = {
  PaymentWitness: [
    { name: "owner",     type: "address" },
    { name: "token",     type: "address" },
    { name: "amount",    type: "uint256" },
    { name: "to",        type: "address" },
    { name: "deadline",  type: "uint256" },
    { name: "paymentId", type: "bytes32" },
  ],
};

async function main() {
  console.log("=".repeat(60));
  console.log("Q402 가스리스 페이먼트 테스트 — X Layer");
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(RPC);
  const payer = new ethers.Wallet(PAYER_KEY, provider);

  console.log(`\nPayer  : ${payer.address}`);
  console.log(`To     : ${RECIPIENT}`);
  console.log(`Amount : ${AMOUNT_USDC} USDC`);
  console.log(`Chain  : X Layer (${CHAIN_ID})`);

  // ── USDC 잔고 확인 ────────────────────────────────────────────────────────────
  const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
  const usdc = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);
  const bal = await usdc.balanceOf(payer.address);
  console.log(`\nUSDC 잔고: ${ethers.formatUnits(bal, USDC_DECIMALS)} USDC`);

  if (bal === 0n) {
    console.error("❌ USDC 잔고 없음. 테스트 중단.");
    process.exit(1);
  }

  // ── 파라미터 세팅 ─────────────────────────────────────────────────────────────
  const amountRaw = BigInt(Math.round(parseFloat(AMOUNT_USDC) * 10 ** USDC_DECIMALS));
  const deadline  = Math.floor(Date.now() / 1000) + 600; // 10분
  const paymentId = ethers.hexlify(ethers.randomBytes(32));
  const nonce     = await provider.getTransactionCount(payer.address);

  console.log(`\nNonce     : ${nonce}`);
  console.log(`Deadline  : ${deadline}`);
  console.log(`PaymentID : ${paymentId}`);

  // ── 1. EIP-712 witness 서명 ───────────────────────────────────────────────────
  console.log("\n[1/3] EIP-712 witness 서명 중...");
  const domain = {
    name: "Q402PaymentImplementation",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: IMPL_CONTRACT,
  };
  const witnessSig = await payer.signTypedData(domain, WITNESS_TYPES, {
    owner:     payer.address,
    token:     USDC_ADDRESS,
    amount:    amountRaw,
    to:        RECIPIENT,
    deadline:  BigInt(deadline),
    paymentId,
  });
  console.log(`   witnessSig: ${witnessSig.slice(0, 20)}...`);

  // ── 2. EIP-7702 authorization 서명 (SDK 방식과 동일) ──────────────────────────
  console.log("\n[2/3] EIP-7702 authorization 서명 중...");
  const authDomain = { name: "EIP7702Authorization", version: "1", chainId: CHAIN_ID };
  const authTypes  = {
    Authorization: [
      { name: "address", type: "address" },
      { name: "nonce",   type: "uint256" },
    ],
  };
  const authSig = await payer.signTypedData(authDomain, authTypes, {
    address: IMPL_CONTRACT,
    nonce,
  });

  const r = authSig.slice(0, 66);
  const s = "0x" + authSig.slice(66, 130);
  const v = parseInt(authSig.slice(130, 132), 16);
  const yParity = v === 27 ? 0 : 1;

  const authorization = { chainId: CHAIN_ID, address: IMPL_CONTRACT, nonce, yParity, r, s };
  console.log(`   authorization.r: ${r.slice(0, 20)}...`);

  // ── 3. /api/relay 호출 ────────────────────────────────────────────────────────
  console.log("\n[3/3] /api/relay 호출 중...");
  const body = {
    apiKey: API_KEY,
    chain:  CHAIN,
    token:  "USDC",
    from:   payer.address,
    to:     RECIPIENT,
    amount: amountRaw.toString(),
    deadline,
    paymentId,
    witnessSig,
    authorization,
  };

  const res  = await fetch(RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  console.log("\n" + "=".repeat(60));
  if (res.ok && data.success) {
    console.log("✅ 성공!");
    console.log(`   txHash     : ${data.txHash}`);
    console.log(`   blockNumber: ${data.blockNumber}`);
    console.log(`   Explorer   : https://web3.okx.com/explorer/x-layer/tx/${data.txHash}`);
  } else {
    console.log("❌ 실패:");
    console.log(`   Status : ${res.status}`);
    console.log(`   Error  : ${data.error}`);
  }
  console.log("=".repeat(60));
}

main().catch(e => {
  console.error("❌ 예외:", e.message);
  process.exit(1);
});
