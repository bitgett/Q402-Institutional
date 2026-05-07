/**
 * test-direct-xlayer.mjs
 * X Layer — EIP-3009 transferWithAuthorization 방식으로 가스리스 테스트
 * (Avalanche 성공 TX와 동일한 방식)
 *
 * 실행: node scripts/test-direct-xlayer.mjs
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
    .map(l => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
    .filter(p => p[0])
);

// ── 설정 ───────────────────────────────────────────────────────────────────────
const PAYER_KEY     = envVars.TEST_PAYER_KEY;
const RELAYER_KEY   = envVars.RELAYER_PRIVATE_KEY;
const RPC           = "https://rpc.xlayer.tech";
const CHAIN_ID      = 196;
const CONTRACT      = "0x2fb2B2D110b6c5664e701666B3741240242bf350";
const USDC          = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const USDC_DECIMALS = 6;
const RECIPIENT     = (envVars.Q402_TEST_RECIPIENT ?? process.env.Q402_TEST_RECIPIENT ?? "").trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(RECIPIENT)) {
  console.error("Set Q402_TEST_RECIPIENT (40-hex 0x address) in your env file.");
  process.exit(1);
}
const AMOUNT_USDC   = "0.05";

// ── EIP-3009 타입 ──────────────────────────────────────────────────────────────
const TRANSFER_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
};

// ── 컨트랙트 ABI (Avalanche TX에서 역추적) ─────────────────────────────────────
const PAY_ABI = [
  "function pay(address owner, address facilitator, address token, address to, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata sig) external",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const payer   = new ethers.Wallet(PAYER_KEY, provider);
  const relayer = new ethers.Wallet(RELAYER_KEY, provider);

  console.log("=".repeat(60));
  console.log("Q402 X Layer 가스리스 테스트 (EIP-3009 방식)");
  console.log("=".repeat(60));
  console.log(`Payer    : ${payer.address}`);
  console.log(`Relayer  : ${relayer.address}`);
  console.log(`Recipient: ${RECIPIENT}`);
  console.log(`Amount   : ${AMOUNT_USDC} USDC`);

  // ── USDC 잔고 확인 ────────────────────────────────────────────────────────────
  const usdcContract = new ethers.Contract(USDC, [
    "function balanceOf(address) view returns (uint256)",
    "function name() view returns (string)",
    "function version() view returns (string)",
  ], provider);

  const [bal, usdcName, usdcVersion] = await Promise.all([
    usdcContract.balanceOf(payer.address),
    usdcContract.name().catch(() => "USD Coin"),
    usdcContract.version().catch(() => "2"),
  ]);

  console.log(`\nUSDC 잔고 : ${ethers.formatUnits(bal, USDC_DECIMALS)} USDC`);
  console.log(`USDC name : ${usdcName} / version: ${usdcVersion}`);

  if (bal === 0n) {
    console.error("❌ USDC 잔고 없음");
    process.exit(1);
  }

  // ── 파라미터 ──────────────────────────────────────────────────────────────────
  const amountRaw   = ethers.parseUnits(AMOUNT_USDC, USDC_DECIMALS);
  const deadline    = Math.floor(Date.now() / 1000) + 600;
  const randomNonce = ethers.hexlify(ethers.randomBytes(32)); // bytes32 random nonce

  // uint256 버전의 nonce (컨트랙트 pay() 파라미터)
  const nonceUint = BigInt(randomNonce);

  console.log(`\ndeadline   : ${deadline}`);
  console.log(`nonce      : ${randomNonce.slice(0, 20)}...`);

  // ── EIP-3009 서명 ─────────────────────────────────────────────────────────────
  console.log("\n[1/2] EIP-3009 TransferWithAuthorization 서명 중...");

  const usdcDomain = {
    name: usdcName,
    version: usdcVersion,
    chainId: CHAIN_ID,
    verifyingContract: USDC,
  };

  const sig = await payer.signTypedData(usdcDomain, TRANSFER_AUTH_TYPES, {
    from:        payer.address,
    to:          RECIPIENT,
    value:       amountRaw,
    validAfter:  0n,
    validBefore: BigInt(deadline),
    nonce:       randomNonce,
  });

  console.log(`   sig: ${sig.slice(0, 20)}...`);

  // ── contract.pay() 직접 호출 ──────────────────────────────────────────────────
  console.log("\n[2/2] contract.pay() 직접 호출 중 (릴레이어가 가스 냄)...");

  const q402 = new ethers.Contract(CONTRACT, PAY_ABI, relayer);

  // staticCall로 먼저 리버트 이유 확인
  console.log("\n[2/2] staticCall로 리버트 이유 확인 중...");
  try {
    await q402.pay.staticCall(
      payer.address, relayer.address, USDC, RECIPIENT,
      amountRaw, nonceUint, BigInt(deadline), sig
    );
    console.log("   staticCall 통과 — TX 전송 진행");
  } catch (e) {
    console.error(`\n❌ 리버트 이유: ${e.reason ?? e.message?.slice(0, 400)}`);
    if (e.data) console.error(`   revert data: ${e.data}`);
    process.exit(1);
  }

  let txHash;
  try {
    const tx = await q402.pay(
      payer.address, relayer.address, USDC, RECIPIENT,
      amountRaw, nonceUint, BigInt(deadline), sig,
      { gasLimit: 300000 }
    );
    console.log(`   TX 전송: ${tx.hash}`);
    const receipt = await tx.wait();
    txHash = tx.hash;
    console.log(`   블록: ${receipt.blockNumber}, status: ${receipt.status === 1 ? "✅ success" : "❌ revert"}`);
  } catch (e) {
    console.error(`\n❌ TX 실패: ${e.message?.slice(0, 200)}`);
    process.exit(1);
  }

  // ── 결과 확인 ─────────────────────────────────────────────────────────────────
  const [payerAfter, recipientAfter] = await Promise.all([
    usdcContract.balanceOf(payer.address),
    usdcContract.balanceOf(RECIPIENT),
  ]);

  console.log("\n" + "=".repeat(60));
  console.log(`Payer 잔고    : ${ethers.formatUnits(payerAfter, USDC_DECIMALS)} USDC`);
  console.log(`Recipient 잔고: ${ethers.formatUnits(recipientAfter, USDC_DECIMALS)} USDC`);
  console.log(`Explorer: https://web3.okx.com/explorer/x-layer/tx/${txHash}`);
  console.log("=".repeat(60));
}

main().catch(e => {
  console.error("❌ 예외:", e.message);
  process.exit(1);
});
