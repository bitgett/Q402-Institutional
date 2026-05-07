import { ethers } from "ethers";

// Wallets come from env. Set Q402_PAYER + Q402_TEST_RECIPIENT before running.
const PAYER     = (process.env.Q402_PAYER           ?? "").trim();
const RECIPIENT = (process.env.Q402_TEST_RECIPIENT  ?? "").trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(PAYER) || !/^0x[0-9a-fA-F]{40}$/.test(RECIPIENT)) {
  console.error("Set Q402_PAYER and Q402_TEST_RECIPIENT (40-hex 0x addresses) before running.");
  process.exit(1);
}
const CONTRACT  = "0x2fb2B2D110b6c5664e701666B3741240242bf350";

const provider = new ethers.JsonRpcProvider("https://rpc.xlayer.tech");
const usdc = new ethers.Contract(
  "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
  [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ],
  provider
);

const [payerBal, recipientBal, payerOKB, allowance] = await Promise.all([
  usdc.balanceOf(PAYER),
  usdc.balanceOf(RECIPIENT),
  provider.getBalance(PAYER),
  usdc.allowance(PAYER, CONTRACT),
]);

console.log("Payer  USDC      :", ethers.formatUnits(payerBal, 6), "USDC");
console.log("Recipient USDC  :", ethers.formatUnits(recipientBal, 6), "USDC");
console.log("Payer  OKB      :", ethers.formatEther(payerOKB), "OKB");
console.log("Allowance (Payer→Contract):", ethers.formatUnits(allowance, 6), "USDC");
