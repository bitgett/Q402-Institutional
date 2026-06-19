/**
 * test-x402.mjs — on-chain test of the Base x402 rail (USDC EIP-3009).
 *
 *   node scripts/test-x402.mjs [--amount 0.001] [--to 0x...]
 *
 * Flow (mirrors app/lib/relayer.ts settlePaymentEIP3009 — the Q402 facilitator
 * path the relay route reaches for isBaseEIP3009):
 *   1. Payer signs USDC's EIP-712 TransferWithAuthorization against the token's
 *      OWN domain (name "USD Coin", version "2", chainId 8453, verifyingContract
 *      = Base USDC). No EIP-7702 delegation.
 *   2. Relayer submits USDC.transferWithAuthorization(from,to,value,validAfter,
 *      validBefore,nonce,v,r,s) and pays the gas. The USDC contract self-verifies
 *      the signature, so the payer holds zero ETH.
 *
 * Requires .env.local: TEST_PAYER_KEY (holds Base USDC), RELAYER_PRIVATE_KEY.
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dir, "../.env.local"), "utf-8")
    .split("\n").filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
    .filter(p => p[0]),
);
const pk = k => k && (k.startsWith("0x") ? k : `0x${k}`);
if (!env.TEST_PAYER_KEY || !env.RELAYER_PRIVATE_KEY) {
  console.error("Missing TEST_PAYER_KEY or RELAYER_PRIVATE_KEY in .env.local");
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) => a.startsWith("--") ? [[a.slice(2), arr[i + 1]]] : []));
const amountIn = args.amount ?? "0.001";

const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native Circle USDC, 6 dec
const CHAIN_ID = 8453;

const EIP3009_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function balanceOf(address) view returns (uint256)",
];
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const payer = new ethers.Wallet(pk(env.TEST_PAYER_KEY), provider);
  const relayer = new ethers.Wallet(pk(env.RELAYER_PRIVATE_KEY), provider);
  const to = args.to ?? relayer.address;
  const value = ethers.parseUnits(amountIn, 6);
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  console.log("=".repeat(60));
  console.log("Q402 Base — x402 (EIP-3009) rail test");
  console.log("=".repeat(60));
  console.log(`Payer (from)    : ${payer.address}`);
  console.log(`Relayer (gas)   : ${relayer.address}`);
  console.log(`Recipient (to)  : ${to}`);
  console.log(`Token           : Base USDC ${USDC}`);
  console.log(`Amount          : ${amountIn} USDC`);

  // [1/2] Payer signs USDC's TransferWithAuthorization (token's own domain)
  console.log("\n[1/2] Payer signs EIP-3009 TransferWithAuthorization...");
  const domain = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
  const sig = await payer.signTypedData(domain, TYPES, { from: payer.address, to, value, validAfter, validBefore, nonce });
  const { v, r, s } = ethers.Signature.from(sig);
  console.log(`   sig: ${sig.slice(0, 30)}... (v=${v})`);

  // [2/2] Relayer submits transferWithAuthorization + pays gas
  console.log("\n[2/2] Relayer submits USDC.transferWithAuthorization (pays gas)...");
  const usdc = new ethers.Contract(USDC, EIP3009_ABI, relayer);
  const tx = await usdc.transferWithAuthorization(payer.address, to, value, validAfter, validBefore, nonce, v, r, s, { gasLimit: 200000n });
  const receipt = await tx.wait();
  const ok = receipt.status === 1;

  // verify the transfer landed
  const recBal = await new ethers.Contract(USDC, EIP3009_ABI, provider).balanceOf(to);

  console.log("\n" + "=".repeat(60));
  console.log(`${ok ? "SUCCESS" : "REVERTED"} — block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  console.log(`recipient USDC balance: ${ethers.formatUnits(recBal, 6)}`);
  console.log(`https://basescan.org/tx/${tx.hash}`);
  console.log("=".repeat(60));
  if (!ok) process.exit(1);
}
main().catch(e => { console.error("Error:", e.shortMessage ?? e.message ?? e); process.exit(1); });
