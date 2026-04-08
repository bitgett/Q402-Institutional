/**
 * test-xlayer-eip7702.mjs
 * X Layer — Q402PaymentImplementationXLayer EIP-7702 테스트
 *
 * 흐름:
 *  1. Payer가 TransferAuthorization EIP-712 서명 (domain.verifyingContract = payer EOA)
 *  2. Payer가 EIP-7702 authorization 서명 (implContract에 코드 위임)
 *  3. Relayer(facilitator)가 Type 4 TX 전송 → payer EOA에서 transferWithAuthorization() 실행
 *  4. USDC가 Payer → Recipient로 이동 (relayer는 OKB만 냄)
 *
 * 실행: node scripts/test-xlayer-eip7702.mjs
 */

import { ethers } from "ethers";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    .filter(p => p[0])
);

// ── 설정 ───────────────────────────────────────────────────────────────────────
const PAYER_KEY   = envVars.TEST_PAYER_KEY;
const RELAYER_KEY = envVars.RELAYER_PRIVATE_KEY;
const RPC         = "https://rpc.xlayer.tech";
const CHAIN_ID    = 196;
const USDC        = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const USDC_DEC    = 6;
const XLAYER_IMPL = "0x31E9D105df96b5294298cFaffB7f106994CD0d0f";
const RECIPIENT   = "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28";
const AMOUNT_USDC = "0.05";

if (!PAYER_KEY || !RELAYER_KEY) {
  console.error("❌ .env.local에 TEST_PAYER_KEY, RELAYER_PRIVATE_KEY 필요");
  process.exit(1);
}

// ── ABI ────────────────────────────────────────────────────────────────────────
const XLAYER_EIP7702_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
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
  },
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function usedNonces(address owner, uint256 nonce) view returns (bool)",
];

// ── EIP-712 타입 정의 ──────────────────────────────────────────────────────────
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
  const provider  = new ethers.JsonRpcProvider(RPC);
  const payer     = new ethers.Wallet(PAYER_KEY, provider);
  const relayer   = new ethers.Wallet(RELAYER_KEY, provider);
  const relayerViem = privateKeyToAccount(
    RELAYER_KEY.startsWith("0x") ? RELAYER_KEY : `0x${RELAYER_KEY}`
  );

  console.log("=".repeat(60));
  console.log("Q402 X Layer — EIP-7702 TransferAuthorization 테스트");
  console.log("=".repeat(60));
  console.log(`Payer (owner)      : ${payer.address}`);
  console.log(`Relayer (facilitator): ${relayer.address}`);
  console.log(`Recipient          : ${RECIPIENT}`);
  console.log(`Impl Contract      : ${XLAYER_IMPL}`);
  console.log(`Amount             : ${AMOUNT_USDC} USDC`);

  // ── 잔고 확인 ─────────────────────────────────────────────────────────────────
  const usdcContract = new ethers.Contract(USDC, USDC_ABI, provider);
  const [payerBal, relayerOKB] = await Promise.all([
    usdcContract.balanceOf(payer.address),
    provider.getBalance(relayer.address),
  ]);

  console.log(`\nPayer USDC     : ${ethers.formatUnits(payerBal, USDC_DEC)} USDC`);
  console.log(`Relayer OKB    : ${ethers.formatEther(relayerOKB)} OKB`);

  if (payerBal === 0n) { console.error("❌ Payer USDC 잔고 없음"); process.exit(1); }
  if (relayerOKB === 0n) { console.error("❌ Relayer OKB 없음 (가스 필요)"); process.exit(1); }

  // ── 파라미터 생성 ──────────────────────────────────────────────────────────────
  const amountRaw  = BigInt(Math.round(parseFloat(AMOUNT_USDC) * 10 ** USDC_DEC));
  const deadline   = BigInt(Math.floor(Date.now() / 1000) + 600); // +10분
  // 랜덤 uint256 nonce (usedNonces[owner][nonce] bool 매핑)
  const xlayerNonce = ethers.toBigInt(ethers.randomBytes(32));

  console.log(`\ndeadline     : ${deadline}`);
  console.log(`xlayerNonce  : ${xlayerNonce.toString().slice(0, 20)}...`);

  // ── [1/4] TransferAuthorization EIP-712 서명 ──────────────────────────────────
  // verifyingContract = payer's EOA (address(this) under EIP-7702 delegation)
  console.log("\n[1/4] TransferAuthorization 서명 중...");
  console.log("      (domain.verifyingContract = payer EOA)");

  const witnessDomain = {
    name:              "Q402 X Layer",
    version:           "1",
    chainId:           CHAIN_ID,
    verifyingContract: payer.address,  // ← payer EOA
  };

  const witnessSig = await payer.signTypedData(witnessDomain, TRANSFER_AUTH_TYPES, {
    owner:       payer.address,
    facilitator: relayer.address,
    token:       USDC,
    recipient:   RECIPIENT,
    amount:      amountRaw,
    nonce:       xlayerNonce,
    deadline,
  });
  console.log(`   witnessSig: ${witnessSig.slice(0, 30)}...`);

  // ── [2/4] EIP-7702 authorization 서명 ─────────────────────────────────────────
  // payer가 implContract에 코드 위임
  console.log("\n[2/4] EIP-7702 authorization 서명 중 (implContract 위임)...");

  const payerNonce = await provider.getTransactionCount(payer.address);
  const authDomain = { name: "EIP7702Authorization", version: "1", chainId: CHAIN_ID };
  const authTypes  = {
    Authorization: [
      { name: "address", type: "address" },
      { name: "nonce",   type: "uint256" },
    ],
  };
  const authSig   = await payer.signTypedData(authDomain, authTypes, {
    address: XLAYER_IMPL,
    nonce:   payerNonce,
  });
  const authR     = authSig.slice(0, 66);
  const authS     = "0x" + authSig.slice(66, 130);
  const authV     = parseInt(authSig.slice(130, 132), 16);
  const yParity   = authV === 27 ? 0 : 1;

  console.log(`   payerNonce: ${payerNonce}, yParity: ${yParity}`);
  console.log(`   r: ${authR.slice(0, 14)}..., s: ${authS.slice(0, 14)}...`);

  // ── [3/4] staticCall로 리버트 확인 ────────────────────────────────────────────
  // Note: staticCall은 EIP-7702 delegation 없이 실행되므로 transfer()가 실패할 수 있음
  // 서명 검증만 확인하는 용도
  console.log("\n[3/4] 서명 검증 확인 (on-chain staticCall)...");
  const implContract = new ethers.Contract(
    XLAYER_IMPL,
    [
      "function transferWithAuthorization(address owner, address facilitator, address token, address recipient, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature) external",
    ],
    relayer
  );

  try {
    await implContract.transferWithAuthorization.staticCall(
      payer.address, relayer.address, USDC, RECIPIENT,
      amountRaw, xlayerNonce, deadline, witnessSig
    );
    console.log("   staticCall 통과 ✅");
  } catch (e) {
    const msg = e.reason ?? e.message?.slice(0, 200);
    // "Transfer failed" = 서명은 통과했으나 EIP-7702 delegation 없어서 transfer() 실패 → OK
    // 다른 에러 = 서명 검증 실패 → 중단
    if (msg && (msg.includes("TransferFailed") || msg.includes("Transfer failed") || msg.includes("0x"))) {
      console.log(`   staticCall revert: "${msg}" ← 서명 OK, EIP-7702 위임 없어서 transfer 실패 (정상)`);
    } else {
      console.error(`\n❌ staticCall 서명 검증 실패: ${msg}`);
      process.exit(1);
    }
  }

  // ── [4/4] Type 4 TX 전송 (viem) ───────────────────────────────────────────────
  console.log("\n[4/4] EIP-7702 Type 4 TX 전송 중 (relayer가 OKB 가스 냄)...");

  const walletClient = createWalletClient({
    account:   relayerViem,
    transport: http(RPC),
  });
  const publicClient = createPublicClient({
    transport: http(RPC),
  });

  const callData = encodeFunctionData({
    abi:          XLAYER_EIP7702_ABI,
    functionName: "transferWithAuthorization",
    args: [
      payer.address,
      relayer.address,
      USDC,
      RECIPIENT,
      amountRaw,
      xlayerNonce,
      deadline,
      witnessSig,
    ],
  });

  let txHash;
  try {
    txHash = await walletClient.sendTransaction({
      chain: null,
      to:    payer.address,   // call the owner's EOA
      data:  callData,
      gas:   300000n,
      authorizationList: [
        {
          chainId: CHAIN_ID,
          address: XLAYER_IMPL,
          nonce:   payerNonce,
          yParity,
          r: authR,
          s: authS,
        },
      ],
    });
    console.log(`   TX 전송: ${txHash}`);
  } catch (e) {
    console.error(`\n❌ TX 전송 실패: ${e.message?.slice(0, 300)}`);
    process.exit(1);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const success = receipt.status === "success";
  console.log(`   블록: ${receipt.blockNumber}, status: ${success ? "✅ success" : "❌ revert"}`);

  if (!success) {
    console.error("❌ TX reverted");
    process.exit(1);
  }

  // ── 결과 확인 ─────────────────────────────────────────────────────────────────
  const [payerAfter, recipientAfter] = await Promise.all([
    usdcContract.balanceOf(payer.address),
    usdcContract.balanceOf(RECIPIENT),
  ]);

  console.log("\n" + "=".repeat(60));
  console.log(`Payer 잔고    : ${ethers.formatUnits(payerAfter, USDC_DEC)} USDC`);
  console.log(`Recipient 잔고: ${ethers.formatUnits(recipientAfter, USDC_DEC)} USDC`);
  console.log(`Explorer: https://web3.okx.com/explorer/x-layer/tx/${txHash}`);
  console.log("=".repeat(60));
}

main().catch(e => {
  console.error("❌ 예외:", e.message);
  process.exit(1);
});
