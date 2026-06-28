/** Post-deploy on-chain audit of the LIVE BNB Lista ERC-4626 yield impl.
 *  Read-only. Verifies the deployed contract IS our audited source: on-chain
 *  typehashes/domain/allowlist match, and a real opcode walk finds NO
 *  DELEGATECALL / SELFDESTRUCT / CALLCODE (no proxy/backdoor/self-destruct). */
import { ethers } from "ethers";

const IMPL = "0x7EC2559a7A724ad02Ddce796710ebe04eE6064dD";
const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org", { chainId: 56, name: "bnb" }, { staticNetwork: true });

const EXPECT = {
  DOMAIN_TYPEHASH: ethers.id("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  TRANSFER_AUTHORIZATION_TYPEHASH: ethers.id("TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"),
  ERC4626_SUPPLY_AUTHORIZATION_TYPEHASH: ethers.id("Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)"),
  ERC4626_WITHDRAW_AUTHORIZATION_TYPEHASH: ethers.id("Erc4626WithdrawAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)"),
};

const c = new ethers.Contract(IMPL, [
  "function DOMAIN_TYPEHASH() view returns (bytes32)",
  "function TRANSFER_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function ERC4626_SUPPLY_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function ERC4626_WITHDRAW_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function IMPL_VERSION() view returns (string)",
  "function domainSeparator() view returns (bytes32)",
  "function isAllowedVault(address) view returns (bool)",
  "function isAllowedAsset(address) view returns (bool)",
], p);

let fail = 0;
const ok = (cond, label) => { console.log(`  ${cond ? "OK " : "!! "} ${label}`); if (!cond) fail++; };

console.log("== 1. Witness typehashes (signing integrity) ==");
for (const [k, want] of Object.entries(EXPECT)) {
  const got = await c[k]();
  ok(got.toLowerCase() === want.toLowerCase(), `${k} = ${got}`);
}

console.log("\n== 2. Identity + domain separator ==");
const name = await c.NAME(), ver = await c.VERSION(), iv = await c.IMPL_VERSION();
ok(name === "Q402 BNB Chain", `NAME = "${name}"`);
ok(ver === "1", `VERSION = "${ver}"`);
ok(iv === "2-yield-bnb-erc4626-lista", `IMPL_VERSION = "${iv}"`);
// Under 7702 the live domain uses the EOA as verifyingContract; this impl address
// (un-delegated) is the verifyingContract when called directly. Recompute + compare.
const wantDS = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32", "bytes32", "bytes32", "uint256", "address"],
  [EXPECT.DOMAIN_TYPEHASH, ethers.id("Q402 BNB Chain"), ethers.id("1"), 56, IMPL],
));
ok((await c.domainSeparator()).toLowerCase() === wantDS.toLowerCase(), "domainSeparator() matches keccak(domain, chainId=56, address(this))");

console.log("\n== 3. Immutable allowlist ==");
const GAUNTLET = "0x6d6783C146F2B0B2774C1725297f1845dc502525", LISTA_USDC = "0x8a06Ac91265dBEBE6D4606f45b10993E9a571869";
const USDT = "0x55d398326f99059fF775485246999027B3197955", USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const DEAD = "0x000000000000000000000000000000000000dEaD";
ok(await c.isAllowedVault(GAUNTLET), "isAllowedVault(Gauntlet USDT)");
ok(await c.isAllowedVault(LISTA_USDC), "isAllowedVault(Lista USDC)");
ok(!(await c.isAllowedVault(DEAD)), "isAllowedVault(random) == false");
ok(await c.isAllowedAsset(USDT), "isAllowedAsset(USDT)");
ok(await c.isAllowedAsset(USDC), "isAllowedAsset(USDC)");
ok(!(await c.isAllowedAsset(DEAD)), "isAllowedAsset(random) == false");

console.log("\n== 4. Bytecode safety — opcode walk (no proxy/backdoor) ==");
const code = await p.getCode(IMPL);
const bytes = ethers.getBytes(code);
console.log(`  runtime bytecode: ${bytes.length} bytes`);
const DANGER = { 0xf4: "DELEGATECALL", 0xff: "SELFDESTRUCT", 0xf2: "CALLCODE" };
const found = {};
for (let i = 0; i < bytes.length; i++) {
  const op = bytes[i];
  if (op >= 0x60 && op <= 0x7f) { i += op - 0x5f; continue; } // PUSH1..PUSH32: skip immediate data
  if (DANGER[op]) found[DANGER[op]] = (found[DANGER[op]] || 0) + 1;
}
const dangerNames = Object.keys(DANGER).map((k) => DANGER[k]);
for (const n of dangerNames) ok(!found[n], `no ${n} opcode (found ${found[n] || 0})`);

console.log(`\n${fail === 0 ? "AUDIT PASS — live contract matches the audited source, no backdoor." : `AUDIT FAIL — ${fail} check(s) failed.`}`);
process.exit(fail === 0 ? 0 : 1);
