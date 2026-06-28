/**
 * deploy-yield-impl.mjs — compile + deploy the guarded Q402 YIELD implementation
 * (ERC-4626 on Base / Aave on BNB), then PROVE the owner-binding + EIP-712 domain
 * + (for ERC-4626) the vault/asset allowlist on the freshly-deployed address
 * BEFORE wiring YIELD_IMPL_<CHAIN>.
 *
 * Compiler is pinned to solc 0.8.20 / optimizer 200 / evmVersion london — the
 * same settings the deployed payment impls were verified with (see
 * contracts/deployed/base/RECONCILIATION.md). The deployer key never leaves your
 * shell: it is read from DEPLOYER_PRIVATE_KEY and used only to sign locally.
 *
 *   # 1) dry verify the build with NO key + NO funds:
 *   node scripts/deploy-yield-impl.mjs --chain base --compile-only
 *
 *   # 2) real deploy (deployer wallet must hold Base ETH for gas):
 *   DEPLOYER_PRIVATE_KEY=0x<key> node scripts/deploy-yield-impl.mjs --chain base
 *
 * After a green run: set YIELD_IMPL_BASE=<address> in the Vercel env. Until then
 * the deposit/withdraw routes fail closed (503 yield_not_enabled). Then re-run
 * `vitest run yield-base-vault-drift` and do a small smoke deposit + withdraw.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const RPCS = {
  base: "https://mainnet.base.org",
  bnb: "https://bsc-dataseed.binance.org",
};

// Per-chain yield impl: source file + contract name + the on-chain identity to
// assert post-deploy. ERC-4626 chains also carry the immutable vault/asset the
// allowlist must hard-code (probed after deploy).
const YIELD_IMPL = {
  base: {
    source: "contracts/yield/Q402PaymentImplementationBASEv2.sol",
    name: "Q402PaymentImplementationBASEv2",
    domainName: "Q402 Base",
    erc4626: true,
    vault: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", // Gauntlet USDC Prime
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // native Base USDC
  },
  // BNB yield venue = Lista Lending (Moolah curated ERC-4626 vaults). This is the
  // pivot from the Aave-based BNBv2 (kept in-repo at
  // contracts/yield/Q402PaymentImplementationBNBv2.sol for reference). Launch is
  // USDT-only via the Gauntlet USDT Vault; a USDC vault is added once Lista
  // confirms its address. After deploy: set YIELD_IMPL_BNB, then LISTA_YIELD_ENABLED=true.
  bnb: {
    source: "contracts/yield/Q402PaymentImplementationBNBYieldErc4626.sol",
    name: "Q402PaymentImplementationBNBYieldErc4626",
    domainName: "Q402 BNB Chain",
    erc4626: true,
    // Allowlists BOTH stable vaults (AssetVaultMismatch blocks cross-routing).
    vaults: [
      "0x6d6783C146F2B0B2774C1725297f1845dc502525", // Gauntlet USDT Vault
      "0x8a06ac91265dbebe6d4606f45b10993e9a571869", // Lista USDC Vault (lisUSDC)
    ],
    assets: [
      "0x55d398326f99059fF775485246999027B3197955", // BSC USDT, 18dp
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BSC USDC, 18dp
    ],
  },
};

const argv = process.argv;
const chain = (() => { const i = argv.indexOf("--chain"); return i >= 0 ? argv[i + 1] : null; })();
const compileOnly = argv.includes("--compile-only");
if (!chain || !YIELD_IMPL[chain]) {
  console.error(`Usage: [DEPLOYER_PRIVATE_KEY=0x...] node scripts/deploy-yield-impl.mjs --chain <${Object.keys(YIELD_IMPL).join("|")}> [--compile-only]`);
  process.exit(2);
}
const cfg = YIELD_IMPL[chain];

// ── Compile (no key needed) ────────────────────────────────────────────────
const source = readFileSync(resolve(root, cfg.source), "utf8");
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
    // viaIR is required: the ERC-4626 functions hit "stack too deep" otherwise.
    // It changes codegen only, NOT storage layout (slot 0 usedNonces / slot 1
    // reentrancy are source-ordered), the EIP-712 typehashes (compile-time
    // constants), or the domain separator. So re-delegation storage-safety vs
    // the deployed payment impl is preserved. Match these EXACT settings when
    // verifying on BaseScan: solc 0.8.20, optimizer 200, london, viaIR=true.
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) { console.error("compile errors:\n" + errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const c = out.contracts["Q402.sol"][cfg.name];
if (!c) { console.error(`compiled output has no contract ${cfg.name}`); process.exit(1); }
const abi = c.abi;
const bytecode = "0x" + c.evm.bytecode.object;

// Guard checks on the compiled ABI — refuse to ship a build missing the owner
// binding, the ERC-4626 entrypoints, or the vault allowlist error.
const hasError = (n) => abi.some((x) => x.type === "error" && x.name === n);
const hasFn = (n) => abi.some((x) => x.type === "function" && x.name === n);
const abiChecks = {
  OwnerMismatch: hasError("OwnerMismatch"),
  transferWithAuthorization: hasFn("transferWithAuthorization"),
  supplyToErc4626: cfg.erc4626 ? hasFn("supplyToErc4626") : true,
  withdrawFromErc4626: cfg.erc4626 ? hasFn("withdrawFromErc4626") : true,
  VaultNotAllowed: cfg.erc4626 ? hasError("VaultNotAllowed") : true,
};
const abiOk = Object.values(abiChecks).every(Boolean);
console.error(`Compiled ${cfg.name}: ${(bytecode.length - 2) / 2} bytes. ABI checks: ${JSON.stringify(abiChecks)}`);
if (!abiOk) { console.error("! ABI guard checks FAILED — refusing to deploy a non-guarded build."); process.exit(1); }

if (compileOnly) {
  console.log(JSON.stringify({ chain, contract: cfg.name, bytecodeBytes: (bytecode.length - 2) / 2, abiChecks, compileOnly: true }, null, 2));
  process.exit(0);
}

// ── Deploy (key required) ──────────────────────────────────────────────────
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("Set DEPLOYER_PRIVATE_KEY=0x<64-hex> in your environment (it is never logged). Or pass --compile-only to just verify the build.");
  process.exit(2);
}
const rpc = process.env[`${chain.toUpperCase()}_RPC_URL`] || RPCS[chain];
const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(pk, provider);
const chainId = Number((await provider.getNetwork()).chainId);
console.error(`Deploying ${cfg.name} to ${chain} (chainId ${chainId}, NAME="${cfg.domainName}") from ${wallet.address} …`);
const factory = new ethers.ContractFactory(abi, bytecode, wallet);

// Gas preflight: confirm the deployer can cover the deploy before broadcasting.
const deployTx = await factory.getDeployTransaction();
const [estGas, feeData, balance] = await Promise.all([
  provider.estimateGas({ from: wallet.address, data: deployTx.data }),
  provider.getFeeData(),
  provider.getBalance(wallet.address),
]);
const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
const estCost = (estGas * gasPrice * 12n) / 10n; // +20% headroom
console.error(`Preflight: estGas=${estGas} gasPrice=${ethers.formatUnits(gasPrice, "gwei")}gwei estCost~${ethers.formatEther(estCost)} balance=${ethers.formatEther(balance)}`);
if (balance < estCost) {
  console.error(`\n! insufficient balance on ${chain}: need ~${ethers.formatEther(estCost)} ETH, have ${ethers.formatEther(balance)}. Fund ${wallet.address} and re-run.`);
  process.exit(1);
}

const contract = await factory.deploy();
await contract.waitForDeployment();
const address = await contract.getAddress();
console.error(`Deployed at ${address}`);

// ── Post-deploy proofs ──────────────────────────────────────────────────────
// 1) owner-binding: transferWithAuthorization from a non-owner must revert OwnerMismatch.
const PROBE = "0x000000000000000000000000000000000000dEaD";
const SEL_OWNER_MISMATCH = ethers.id("OwnerMismatch()").slice(0, 10).toLowerCase();
const tIface = new ethers.Interface([
  "function transferWithAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes witnessSignature)",
]);
const probeData = tIface.encodeFunctionData("transferWithAuthorization", [PROBE, PROBE, PROBE, PROBE, 0n, 0n, 2n ** 48n, "0x" + "00".repeat(65)]);
let ownerGuardOk = false;
try {
  await provider.send("eth_call", [{ to: address, from: PROBE, data: probeData }, "latest"]);
} catch (e) {
  const d = e?.data || e?.error?.data || e?.info?.error?.data || "";
  ownerGuardOk = typeof d === "string" && d.slice(0, 10).toLowerCase() === SEL_OWNER_MISMATCH;
}

// 2) EIP-712 identity: NAME()/VERSION() constants (the domain separator derives from them).
const idc = new ethers.Contract(address, [
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
], provider);
const onchainName = await idc.NAME();
const onchainVersion = await idc.VERSION();
const nameOk = onchainName === cfg.domainName;
const versionOk = onchainVersion === "1";

// 3) ERC-4626 allowlist: the curated vault + USDC must be allowed; anything else denied.
let allowlistOk = true;
let allowlistDetail = null;
if (cfg.erc4626) {
  const yc = new ethers.Contract(address, [
    "function isAllowedVault(address) view returns (bool)",
    "function isAllowedAsset(address) view returns (bool)",
  ], provider);
  // Accept a single vault/asset or arrays (a chain may allowlist several stables).
  const vaults = cfg.vaults ?? [cfg.vault];
  const assets = cfg.assets ?? [cfg.asset];
  const [vaultsAllowed, assetsAllowed, vaultNo, assetNo] = await Promise.all([
    Promise.all(vaults.map((v) => yc.isAllowedVault(v))),
    Promise.all(assets.map((a) => yc.isAllowedAsset(a))),
    yc.isAllowedVault(PROBE),
    yc.isAllowedAsset(PROBE),
  ]);
  allowlistDetail = { vaults, vaultsAllowed, randomVaultDenied: !vaultNo, assets, assetsAllowed, randomAssetDenied: !assetNo };
  allowlistOk = vaultsAllowed.every(Boolean) && !vaultNo && assetsAllowed.every(Boolean) && !assetNo;
}

console.log(JSON.stringify({
  chain, chainId, address, deployer: wallet.address,
  onchainName, onchainVersion, nameOk, versionOk,
  ownerGuardConfirmed: ownerGuardOk, allowlistOk, allowlistDetail,
}, null, 2));

if (!nameOk || !versionOk || !ownerGuardOk || !allowlistOk) {
  console.error(`\n! deploy verification FAILED (nameOk=${nameOk} versionOk=${versionOk} ownerGuard=${ownerGuardOk} allowlistOk=${allowlistOk}) — do NOT wire it in.`);
  process.exit(1);
}
console.error(`\nOK ${chain}: NAME()="${onchainName}", owner-binding + vault/asset allowlist confirmed on ${address}.`);
console.error(`Next: set YIELD_IMPL_${chain.toUpperCase()}=${address} in Vercel env, fund the relayer with ${chain} gas, re-run the drift test, then a small smoke deposit+withdraw.`);
