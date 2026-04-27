/**
 * verify-contracts.mjs
 *
 * Cross-checks every deployed Q402 impl contract against contracts.manifest.json.
 *
 *   1. eth_getCode      → contract deployed, bytecode non-empty
 *   2. NAME()           → EIP-712 domain name matches manifest
 *   3. TRANSFER_AUTHORIZATION_TYPEHASH() or equivalent → witness typehash
 *
 * Run: node scripts/verify-contracts.mjs
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "..", "contracts.manifest.json"), "utf8")
);

const RPCS = {
  avax:   "https://api.avax.network/ext/bc/C/rpc",
  bnb:    "https://bsc-dataseed1.binance.org/",
  eth:    "https://ethereum.publicnode.com",
  xlayer: "https://rpc.xlayer.tech",
  stable: "https://rpc.stable.xyz",
  mantle: "https://rpc.mantle.xyz",
};

// Human-readable TransferAuthorization typehash (matches local source)
const TRANSFER_AUTH_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
  "TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
));

const ABI = [
  "function NAME() view returns (string)",
  "function VERSION() view returns (string)",
  "function TRANSFER_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function DOMAIN_TYPEHASH() view returns (bytes32)",
  "function domainSeparator() view returns (bytes32)",
];

const results = [];

for (const [chain, cfg] of Object.entries(manifest.chains)) {
  const row = { chain, address: cfg.implContract, checks: {} };
  try {
    const provider = new ethers.JsonRpcProvider(RPCS[chain]);
    const code = await provider.getCode(cfg.implContract);
    row.checks.hasCode = code && code !== "0x";
    row.checks.codeSize = code.length;

    if (!row.checks.hasCode) {
      results.push(row);
      continue;
    }

    const c = new ethers.Contract(cfg.implContract, ABI, provider);

    // Try NAME()
    try {
      row.checks.onChainName = await c.NAME();
      row.checks.nameMatch = row.checks.onChainName === cfg.witness.domainName;
    } catch (e) {
      row.checks.nameError = e.shortMessage || e.message;
    }

    // Try VERSION()
    try {
      row.checks.onChainVersion = await c.VERSION();
    } catch (e) {
      row.checks.versionError = e.shortMessage || e.message;
    }

    // Try TRANSFER_AUTHORIZATION_TYPEHASH()
    try {
      row.checks.onChainTypehash = await c.TRANSFER_AUTHORIZATION_TYPEHASH();
      row.checks.typehashMatchesTransferAuth =
        row.checks.onChainTypehash.toLowerCase() === TRANSFER_AUTH_TYPEHASH.toLowerCase();
    } catch (e) {
      row.checks.typehashError = e.shortMessage || e.message;
    }
  } catch (e) {
    row.error = e.shortMessage || e.message;
  }
  results.push(row);
}

console.log(JSON.stringify({
  expectedTransferAuthTypehash: TRANSFER_AUTH_TYPEHASH,
  results,
}, null, 2));
