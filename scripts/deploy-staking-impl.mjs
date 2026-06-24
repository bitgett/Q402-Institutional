/**
 * deploy-staking-impl.mjs — compile + deploy Q402StakingImplementationBNB
 * (gasless Q staking into QuackAiStake), then PROVE owner-binding + EIP-712
 * identity + the QuackAiStake/Q allowlist on the freshly-deployed address
 * BEFORE wiring STAKE_IMPL_BNB.
 *
 * solc 0.8.20 / optimizer 200 / evmVersion london (matches the BNB impls).
 * The deployer key is read from DEPLOYER_PRIVATE_KEY and signs locally only.
 *
 *   node scripts/deploy-staking-impl.mjs --compile-only
 *   DEPLOYER_PRIVATE_KEY=0x<key> node scripts/deploy-staking-impl.mjs
 *
 * After a green run: set STAKE_IMPL_BNB=<address> in Vercel env + local.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const RPC = process.env.BNB_RPC_URL || "https://bsc-dataseed.binance.org";
const SOURCE = "contracts/staking/Q402StakingImplementationBNB.sol";
const NAME = "Q402StakingImplementationBNB";
const DOMAIN_NAME = "Q402 BNB Chain";
const QUACK_STAKE = "0x8f5aF1E069Cf63118bdD018203F5228343cc4f94";
const Q_TOKEN = "0xc07e1300dc138601FA6B0b59f8D0FA477e690589";

const compileOnly = process.argv.includes("--compile-only");

// ── Compile ────────────────────────────────────────────────────────────────
const source = readFileSync(resolve(root, SOURCE), "utf8");
const solc = require("solc");
if (!solc.version().startsWith("0.8.20")) {
  console.error(`solc ${solc.version()} loaded; install the pinned compiler: npm i -D solc@0.8.20`);
  process.exit(1);
}
const input = {
  language: "Solidity",
  sources: { "Q402.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "london",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error("compile errors:\n" + errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const c = out.contracts["Q402.sol"][NAME];
if (!c) { console.error(`compiled output has no contract ${NAME}`); process.exit(1); }
const abi = c.abi;
const bytecode = "0x" + c.evm.bytecode.object;

// ABI guards — refuse a build missing the owner binding / staking entrypoints / allowlist.
const hasError = (n) => abi.some((x) => x.type === "error" && x.name === n);
const hasFn = (n) => abi.some((x) => x.type === "function" && x.name === n);
const abiChecks = {
  OwnerMismatch: hasError("OwnerMismatch"),
  StakeNotAllowed: hasError("StakeNotAllowed"),
  StakeAmountMismatch: hasError("StakeAmountMismatch"),
  stakeQuack: hasFn("stakeQuack"),
  unstakeQuack: hasFn("unstakeQuack"),
  isAllowedStake: hasFn("isAllowedStake"),
  isAllowedToken: hasFn("isAllowedToken"),
};
const abiOk = Object.values(abiChecks).every(Boolean);
console.error(`Compiled ${NAME}: ${(bytecode.length - 2) / 2} bytes. ABI checks: ${JSON.stringify(abiChecks)}`);
if (!abiOk) { console.error("! ABI guard checks FAILED — refusing to deploy."); process.exit(1); }

if (compileOnly) {
  console.log(JSON.stringify({ contract: NAME, bytecodeBytes: (bytecode.length - 2) / 2, abiChecks, compileOnly: true }, null, 2));
  process.exit(0);
}

// ── Deploy ───────────────────────────────────────────────────────────────────
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("Set DEPLOYER_PRIVATE_KEY=0x<64-hex> (never logged), or pass --compile-only.");
  process.exit(2);
}
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(pk, provider);
const chainId = Number((await provider.getNetwork()).chainId);
if (chainId !== 56) { console.error(`! expected BNB chainId 56, got ${chainId}`); process.exit(1); }
console.error(`Deploying ${NAME} to BNB (chainId 56) from ${wallet.address} …`);
const factory = new ethers.ContractFactory(abi, bytecode, wallet);

// Gas preflight.
const deployTx = await factory.getDeployTransaction();
const [estGas, feeData, balance] = await Promise.all([
  provider.estimateGas({ from: wallet.address, data: deployTx.data }),
  provider.getFeeData(),
  provider.getBalance(wallet.address),
]);
const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
const estCost = (estGas * gasPrice * 12n) / 10n;
console.error(`Preflight: estGas=${estGas} gasPrice=${ethers.formatUnits(gasPrice, "gwei")}gwei estCost~${ethers.formatEther(estCost)}BNB balance=${ethers.formatEther(balance)}BNB`);
if (balance < estCost) {
  console.error(`\n! insufficient BNB: need ~${ethers.formatEther(estCost)}, have ${ethers.formatEther(balance)}. Fund ${wallet.address} and re-run.`);
  process.exit(1);
}

const contract = await factory.deploy();
await contract.waitForDeployment();
const address = await contract.getAddress();
console.error(`Deployed at ${address}`);

// ── Post-deploy proofs ──────────────────────────────────────────────────────
const PROBE = "0x000000000000000000000000000000000000dEaD";
const SEL_OWNER_MISMATCH = ethers.id("OwnerMismatch()").slice(0, 10).toLowerCase();
// 1) owner-binding: stakeQuack from a non-owner must revert OwnerMismatch.
const sIface = new ethers.Interface([
  "function stakeQuack(address owner,address facilitator,address stakeContract,address token,uint256 stakeType,uint256 amount,uint256 nonce,uint256 deadline,bytes witnessSignature)",
]);
const probeData = sIface.encodeFunctionData("stakeQuack", [PROBE, PROBE, QUACK_STAKE, Q_TOKEN, 0n, 1n, 0n, 2n ** 48n, "0x" + "00".repeat(65)]);
let ownerGuardOk = false;
try {
  await provider.send("eth_call", [{ to: address, from: PROBE, data: probeData }, "latest"]);
} catch (e) {
  const d = e?.data || e?.error?.data || e?.info?.error?.data || "";
  ownerGuardOk = typeof d === "string" && d.slice(0, 10).toLowerCase() === SEL_OWNER_MISMATCH;
}

// 2) EIP-712 identity + 3) allowlist.
const idc = new ethers.Contract(address, [
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function isAllowedStake(address) view returns (bool)",
  "function isAllowedToken(address) view returns (bool)",
], provider);
const [onchainName, onchainVersion, stakeYes, stakeNo, tokenYes, tokenNo] = await Promise.all([
  idc.NAME(), idc.VERSION(),
  idc.isAllowedStake(QUACK_STAKE), idc.isAllowedStake(PROBE),
  idc.isAllowedToken(Q_TOKEN), idc.isAllowedToken(PROBE),
]);
const nameOk = onchainName === DOMAIN_NAME;
const versionOk = onchainVersion === "1";
const allowlistOk = stakeYes && !stakeNo && tokenYes && !tokenNo;

console.log(JSON.stringify({
  chain: "bnb", chainId, address, deployer: wallet.address,
  onchainName, onchainVersion, nameOk, versionOk,
  ownerGuardConfirmed: ownerGuardOk, allowlistOk,
  allowlistDetail: { stakeAllowed: stakeYes, randomStakeDenied: !stakeNo, tokenAllowed: tokenYes, randomTokenDenied: !tokenNo },
}, null, 2));

if (!nameOk || !versionOk || !ownerGuardOk || !allowlistOk) {
  console.error(`\n! deploy verification FAILED (nameOk=${nameOk} versionOk=${versionOk} ownerGuard=${ownerGuardOk} allowlistOk=${allowlistOk}) — do NOT wire it in.`);
  process.exit(1);
}
console.error(`\nOK bnb: NAME()="${onchainName}", owner-binding + QuackAiStake/Q allowlist confirmed on ${address}.`);
console.error(`Next: set STAKE_IMPL_BNB=${address} in Vercel env + local.`);
