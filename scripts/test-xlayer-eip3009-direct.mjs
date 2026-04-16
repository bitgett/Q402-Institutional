/**
 * test-xlayer-eip3009-direct.mjs
 * X Layer — USDC EIP-3009 transferWithAuthorization 직접 호출
 *
 * Q402 컨트랙트 불필요. USDC 자체의 EIP-3009를 릴레이어가 직접 호출.
 * 흐름:
 *  1. Payer가 USDC EIP-3009 서명 (TransferWithAuthorization)
 *  2. Relayer가 USDC.transferWithAuthorization() 직접 호출 (OKB 가스 냄)
 *  3. USDC가 Payer → Recipient로 이동
 *
 * 실행: node scripts/test-xlayer-eip3009-direct.mjs
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
const USDC          = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const USDC_DECIMALS = 6;
const RECIPIENT     = "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28";
const AMOUNT_USDC   = "0.05";

// ── USDC EIP-3009 ABI ─────────────────────────────────────────────────────────
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
];

// ── EIP-3009 타입 (USDC 자체 도메인) ──────────────────────────────────────────
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

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const payer   = new ethers.Wallet(PAYER_KEY, provider);
  const relayer = new ethers.Wallet(RELAYER_KEY, provider);
  const usdcContract = new ethers.Contract(USDC, USDC_ABI, provider);

  console.log("=".repeat(60));
  console.log("Q402 X Layer — USDC EIP-3009 직접 릴레이 테스트");
  console.log("=".repeat(60));
  console.log(`Payer    : ${payer.address}`);
  console.log(`Relayer  : ${relayer.address}`);
  console.log(`Recipient: ${RECIPIENT}`);
  console.log(`Amount   : ${AMOUNT_USDC} USDC`);

  // ── 잔고 및 USDC 메타데이터 확인 ──────────────────────────────────────────────
  const [payerBal, relayerOKB, usdcName, usdcVersion] = await Promise.all([
    usdcContract.balanceOf(payer.address),
    provider.getBalance(relayer.address),
    usdcContract.name().catch(() => "USD Coin"),
    usdcContract.version().catch(() => "2"),
  ]);

  console.log(`\nPayer USDC    : ${ethers.formatUnits(payerBal, USDC_DECIMALS)} USDC`);
  console.log(`Relayer OKB   : ${ethers.formatEther(relayerOKB)} OKB`);
  console.log(`USDC name     : ${usdcName} / version: ${usdcVersion}`);

  if (payerBal === 0n) {
    console.error("❌ Payer USDC 잔고 없음");
    process.exit(1);
  }
  if (relayerOKB === 0n) {
    console.error("❌ Relayer OKB 없음 (가스 필요)");
    process.exit(1);
  }

  // ── 파라미터 ──────────────────────────────────────────────────────────────────
  const amountRaw   = ethers.parseUnits(AMOUNT_USDC, USDC_DECIMALS);
  const validAfter  = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600); // +10분
  const nonce       = ethers.hexlify(ethers.randomBytes(32)); // bytes32

  console.log(`\nvalidBefore: ${validBefore}`);
  console.log(`nonce      : ${nonce.slice(0, 20)}...`);

  // ── EIP-3009 서명 (USDC 도메인 사용) ──────────────────────────────────────────
  console.log("\n[1/3] USDC EIP-3009 TransferWithAuthorization 서명 중...");

  const usdcDomain = {
    name:              usdcName,
    version:           usdcVersion,
    chainId:           CHAIN_ID,
    verifyingContract: USDC,
  };

  const sig = await payer.signTypedData(usdcDomain, TRANSFER_AUTH_TYPES, {
    from:        payer.address,
    to:          RECIPIENT,
    value:       amountRaw,
    validAfter,
    validBefore,
    nonce,
  });

  const { v, r, s } = ethers.Signature.from(sig);
  console.log(`   sig: ${sig.slice(0, 20)}...`);
  console.log(`   v=${v}, r=${r.slice(0,10)}..., s=${s.slice(0,10)}...`);

  // ── authorizationState 확인 (nonce 미사용 확인) ───────────────────────────────
  console.log("\n[2/3] authorizationState 확인 (nonce 미사용 여부)...");
  const used = await usdcContract.authorizationState(payer.address, nonce);
  if (used) {
    console.error("❌ nonce 이미 사용됨");
    process.exit(1);
  }
  console.log("   nonce 미사용 ✅");

  // ── staticCall로 리버트 이유 확인 ─────────────────────────────────────────────
  console.log("\n[2.5/3] staticCall로 리버트 이유 확인...");
  const usdcRelayer = new ethers.Contract(USDC, USDC_ABI, relayer);
  try {
    await usdcRelayer.transferWithAuthorization.staticCall(
      payer.address, RECIPIENT, amountRaw,
      validAfter, validBefore, nonce,
      v, r, s
    );
    console.log("   staticCall 통과 ✅ — TX 전송 진행");
  } catch (e) {
    console.error(`\n❌ 리버트 이유: ${e.reason ?? e.message?.slice(0, 400)}`);
    if (e.data) console.error(`   revert data: ${e.data}`);
    process.exit(1);
  }

  // ── USDC.transferWithAuthorization() 직접 호출 ────────────────────────────────
  console.log("\n[3/3] USDC.transferWithAuthorization() 호출 (릴레이어가 OKB 가스 냄)...");

  let txHash;
  try {
    const tx = await usdcRelayer.transferWithAuthorization(
      payer.address, RECIPIENT, amountRaw,
      validAfter, validBefore, nonce,
      v, r, s,
      { gasLimit: 200000 }
    );
    console.log(`   TX 전송: ${tx.hash}`);
    const receipt = await tx.wait();
    txHash = tx.hash;
    console.log(`   블록: ${receipt.blockNumber}, status: ${receipt.status === 1 ? "✅ success" : "❌ revert"}`);
  } catch (e) {
    console.error(`\n❌ TX 실패: ${e.message?.slice(0, 300)}`);
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
