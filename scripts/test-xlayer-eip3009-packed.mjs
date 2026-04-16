/**
 * test-xlayer-eip3009-packed.mjs
 * X Layer USDC가 packed bytes 서명 방식의 transferWithAuthorization을 쓰는 경우
 *
 * 실행: node scripts/test-xlayer-eip3009-packed.mjs
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
const envVars = Object.fromEntries(
  readFileSync(envPath, "utf-8")
    .split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
    .filter(p => p[0])
);

const PAYER_KEY     = envVars.TEST_PAYER_KEY;
const RELAYER_KEY   = envVars.RELAYER_PRIVATE_KEY;
const RPC           = "https://rpc.xlayer.tech";
const CHAIN_ID      = 196;
const USDC          = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const USDC_DECIMALS = 6;
const RECIPIENT     = "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28";
const AMOUNT_USDC   = "0.05";

// 두 가지 ABI variant 모두 정의
const USDC_ABI_PACKED = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  // packed bytes 방식 (7 params)
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external",
];

const USDC_ABI_VRS = [
  "function balanceOf(address) view returns (uint256)",
  // v,r,s 분리 방식 (9 params)
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
];

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

  const usdcRead = new ethers.Contract(USDC, USDC_ABI_PACKED, provider);

  console.log("=".repeat(60));
  console.log("X Layer USDC — packed bytes transferWithAuthorization 테스트");
  console.log("=".repeat(60));

  const [usdcName, usdcVersion, payerBal] = await Promise.all([
    usdcRead.name().catch(() => "USD Coin"),
    usdcRead.version().catch(() => "2"),
    usdcRead.balanceOf(payer.address),
  ]);

  console.log(`Payer USDC : ${ethers.formatUnits(payerBal, USDC_DECIMALS)} USDC`);
  console.log(`USDC name  : ${usdcName} / version: ${usdcVersion}`);

  // 함수 selector 확인
  const ifacePacked = new ethers.Interface(USDC_ABI_PACKED);
  const ifaceVRS    = new ethers.Interface(USDC_ABI_VRS);
  const selPacked = ifacePacked.getFunction("transferWithAuthorization").selector;
  const selVRS    = ifaceVRS.getFunction("transferWithAuthorization").selector;
  console.log(`\nSelector (packed 7-param): ${selPacked}`);
  console.log(`Selector (v,r,s  9-param): ${selVRS}`);

  // 실제 컨트랙트에 어떤 selector가 있는지 확인
  console.log("\n함수 selector 존재 여부 확인...");
  for (const [label, sel] of [["packed(7)", selPacked], ["vrs(9)", selVRS]]) {
    try {
      const result = await provider.call({ to: USDC, data: sel + "0".repeat(64*9) });
      console.log(`  ${label} (${sel}): 응답 있음 (length=${result.length})`);
    } catch (e) {
      // revert가 나도 selector는 존재하는 것
      const msg = e.message ?? "";
      if (msg.includes("execution reverted") || msg.includes("revert") || e.data) {
        console.log(`  ${label} (${sel}): ✅ 함수 존재 (revert됨 — 파라미터 오류)`);
      } else {
        console.log(`  ${label} (${sel}): ❌ 없음 (${msg.slice(0,60)})`);
      }
    }
  }

  const amountRaw   = ethers.parseUnits(AMOUNT_USDC, USDC_DECIMALS);
  const validAfter  = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce       = ethers.hexlify(ethers.randomBytes(32));

  const usdcDomain = {
    name: usdcName, version: usdcVersion,
    chainId: CHAIN_ID, verifyingContract: USDC,
  };

  const sig = await payer.signTypedData(usdcDomain, TRANSFER_AUTH_TYPES, {
    from: payer.address, to: RECIPIENT, value: amountRaw,
    validAfter, validBefore, nonce,
  });

  const { v, r, s } = ethers.Signature.from(sig);
  console.log(`\n서명 완료: ${sig.slice(0,20)}...`);

  // packed 방식 시도
  console.log("\n[packed 방식] staticCall 시도...");
  const usdcPacked = new ethers.Contract(USDC, USDC_ABI_PACKED, relayer);
  try {
    await usdcPacked.transferWithAuthorization.staticCall(
      payer.address, RECIPIENT, amountRaw,
      validAfter, validBefore, nonce, sig
    );
    console.log("  ✅ packed staticCall 통과 → TX 전송");

    const tx = await usdcPacked.transferWithAuthorization(
      payer.address, RECIPIENT, amountRaw,
      validAfter, validBefore, nonce, sig,
      { gasLimit: 200000 }
    );
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  블록: ${receipt.blockNumber}, status: ${receipt.status === 1 ? "✅ success" : "❌ revert"}`);

    const [payerAfter, recipAfter] = await Promise.all([
      usdcRead.balanceOf(payer.address),
      usdcRead.balanceOf(RECIPIENT),
    ]);
    console.log(`\nPayer 잔고    : ${ethers.formatUnits(payerAfter, USDC_DECIMALS)} USDC`);
    console.log(`Recipient 잔고: ${ethers.formatUnits(recipAfter, USDC_DECIMALS)} USDC`);
    console.log(`Explorer: https://web3.okx.com/explorer/x-layer/tx/${tx.hash}`);

  } catch (e) {
    console.log(`  ❌ packed 실패: ${e.reason ?? e.message?.slice(0,200)}`);
    console.log("\n[v,r,s 방식] staticCall 시도...");
    const usdcVRS = new ethers.Contract(USDC, USDC_ABI_VRS, relayer);
    try {
      await usdcVRS.transferWithAuthorization.staticCall(
        payer.address, RECIPIENT, amountRaw,
        validAfter, validBefore, nonce, v, r, s
      );
      console.log("  ✅ v,r,s staticCall 통과 → TX 전송");

      const tx = await usdcVRS.transferWithAuthorization(
        payer.address, RECIPIENT, amountRaw,
        validAfter, validBefore, nonce, v, r, s,
        { gasLimit: 200000 }
      );
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  블록: ${receipt.blockNumber}, status: ${receipt.status === 1 ? "✅ success" : "❌ revert"}`);

      const [payerAfter, recipAfter] = await Promise.all([
        usdcRead.balanceOf(payer.address),
        usdcRead.balanceOf(RECIPIENT),
      ]);
      console.log(`\nPayer 잔고    : ${ethers.formatUnits(payerAfter, USDC_DECIMALS)} USDC`);
      console.log(`Recipient 잔고: ${ethers.formatUnits(recipAfter, USDC_DECIMALS)} USDC`);
      console.log(`Explorer: https://web3.okx.com/explorer/x-layer/tx/${tx.hash}`);

    } catch (e2) {
      console.log(`  ❌ v,r,s도 실패: ${e2.reason ?? e2.message?.slice(0,200)}`);
    }
  }
}

main().catch(e => {
  console.error("❌ 예외:", e.message);
  process.exit(1);
});
