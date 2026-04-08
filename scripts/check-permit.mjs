/**
 * X Layer USDC가 EIP-2612 permit을 지원하는지 확인
 */
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc.xlayer.tech");
const USDC_XLAYER = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const PAYER = "0xfe7ba1cdc7077f71855627f9983a70188826726f";

const abi = [
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function name() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
];

const usdc = new ethers.Contract(USDC_XLAYER, abi, provider);

const [name, permitNonce, domainSep, authState] = await Promise.all([
  usdc.name().catch(() => "N/A"),
  usdc.nonces(PAYER).catch(() => null),
  usdc.DOMAIN_SEPARATOR().catch(() => null),
  usdc.authorizationState(PAYER, ethers.ZeroHash).catch(() => null),
]);

console.log("Token name       :", name);
console.log("EIP-2612 permit  :", permitNonce !== null ? `✅ (nonce=${permitNonce})` : "❌ 미지원");
console.log("EIP-3009 authz   :", authState !== null ? "✅ transferWithAuthorization 지원" : "❌ 미지원");
console.log("DOMAIN_SEPARATOR :", domainSep ? domainSep.slice(0, 20) + "..." : "❌");

console.log("\n결론:");
if (authState !== null) {
  console.log("✅ EIP-3009 지원 → Avalanche와 동일한 방식으로 X Layer 가스리스 가능");
} else if (permitNonce !== null) {
  console.log("⚠️  EIP-2612만 지원 → permit 방식으로 가능하지만 컨트랙트 수정 필요할 수 있음");
} else {
  console.log("❌ permit 미지원 → X Layer 가스리스 불가");
}
