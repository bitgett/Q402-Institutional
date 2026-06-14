/**
 * deploy-fixed-impl.mjs — compile + deploy the guarded Q402 implementation to a
 * held chain, then prove the owner-binding check on the freshly-deployed address
 * BEFORE you wire it in.
 *
 * The key never enters anyone else's hands: it's read from the DEPLOYER_PRIVATE_KEY
 * environment variable in YOUR shell and used only to sign the deploy tx locally.
 *
 *   npm i -D solc@0.8.20
 *   DEPLOYER_PRIVATE_KEY=0x<key> node scripts/deploy-fixed-impl.mjs --chain arbitrum
 *
 * The deployer wallet needs native gas on the target chain. After a green run,
 * follow contracts/IMPL_REFRESH_RUNBOOK.md steps 3-5 (wire address, re-delegate,
 * re-enable). Re-run scripts/verify-contracts.mjs once the manifest points at the
 * new address.
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
  mantle:    "https://rpc.mantle.xyz",
  injective: "https://sentry.evm-rpc.injective.network/",
  monad:     "https://rpc.monad.xyz",
  scroll:    "https://rpc.scroll.io",
  arbitrum:  "https://arb1.arbitrum.io/rpc",
};

const chain = (() => {
  const i = process.argv.indexOf("--chain");
  return i >= 0 ? process.argv[i + 1] : null;
})();
if (!chain || !RPCS[chain]) {
  console.error(`Usage: DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-fixed-impl.mjs --chain <${Object.keys(RPCS).join("|")}>`);
  process.exit(2);
}
const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("Set DEPLOYER_PRIVATE_KEY=0x<64-hex> in your environment (it is never logged).");
  process.exit(2);
}
const rpc = process.env[`${chain.toUpperCase()}_RPC_URL`] || RPCS[chain];

const manifest = JSON.parse(readFileSync(resolve(root, "contracts.manifest.json"), "utf8"));
const domainName = manifest.chains?.[chain]?.witness?.domainName;
const chainId = manifest.chains?.[chain]?.chainId;
if (!domainName || !chainId) { console.error(`manifest has no domainName/chainId for ${chain}`); process.exit(1); }

// Guarded reference source → swap only the NAME constant for this chain.
const refPath = resolve(root, "contracts/deployed/bnb/Q402PaymentImplementationBNB.sol");
let source = readFileSync(refPath, "utf8");
if (!source.includes('"Q402 BNB Chain"')) { console.error("reference NAME marker not found — source changed?"); process.exit(1); }
source = source.replace('"Q402 BNB Chain"', `"${domainName}"`);

// ── Compile (solc 0.8.20, optimizer 200, london — matches the verified metadata)
const solc = require("solc");
if (!solc.version().startsWith("0.8.20")) {
  console.error(`solc ${solc.version()} loaded; install the matching compiler: npm i -D solc@0.8.20`);
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
const c = out.contracts["Q402.sol"]["Q402PaymentImplementationBNB"];
const abi = c.abi;
const bytecode = "0x" + c.evm.bytecode.object;
// Sanity: the guarded ABI must declare the owner-binding error.
if (!abi.some((x) => x.type === "error" && x.name === "OwnerMismatch")) {
  console.error("compiled ABI lacks OwnerMismatch() — refusing to deploy a non-guarded build."); process.exit(1);
}

// ── Deploy
const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(pk, provider);
console.error(`Deploying guarded impl to ${chain} (chainId ${chainId}, NAME="${domainName}") from ${wallet.address} …`);
const factory = new ethers.ContractFactory(abi, bytecode, wallet);
const contract = await factory.deploy();
await contract.waitForDeployment();
const address = await contract.getAddress();
console.error(`Deployed at ${address}`);

// ── Prove the owner-binding check on the new address (same probe as verify-contracts)
const PROBE = "0x000000000000000000000000000000000000dEaD";
const SEL_OWNER_MISMATCH = ethers.id("OwnerMismatch()").slice(0, 10).toLowerCase();
const iface = new ethers.Interface([
  "function transferWithAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes witnessSignature)",
]);
const data = iface.encodeFunctionData("transferWithAuthorization", [PROBE, PROBE, PROBE, PROBE, 0n, 0n, 2n ** 48n, "0x" + "00".repeat(65)]);
let ownerGuardOk = false;
try {
  await provider.send("eth_call", [{ to: address, from: PROBE, data }, "latest"]);
} catch (e) {
  const d = e?.data || e?.error?.data || e?.info?.error?.data || "";
  ownerGuardOk = typeof d === "string" && d.slice(0, 10).toLowerCase() === SEL_OWNER_MISMATCH;
}

console.log(JSON.stringify({ chain, chainId, address, deployer: wallet.address, ownerGuardConfirmed: ownerGuardOk }, null, 2));
if (!ownerGuardOk) {
  console.error("\n! owner-binding probe did NOT confirm OwnerMismatch on the new address — do NOT wire it in; investigate.");
  process.exit(1);
}
console.error(`\n✓ owner-binding confirmed on ${chain}. Next: set Q402_IMPL_PER_CHAIN["${chain}"] + manifest implContract to ${address}, re-delegate, then remove "${chain}" from DISABLED_CHAINS (chain-status.ts + verify-contracts.mjs).`);
