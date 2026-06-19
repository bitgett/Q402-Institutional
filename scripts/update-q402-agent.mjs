#!/usr/bin/env node
/**
 * update-q402-agent.mjs — refresh an already-registered Q402 agent's
 * metadata + point the on-chain `agentURI` at the new content.
 *
 * Mirror of register-q402-self.mjs, but instead of `register()` it
 * calls `setAgentURI(agentId, newURI)` so the existing ERC-8004 NFT
 * keeps its agentId + ownership but resolves to fresh metadata. Use
 * this when copy / endpoints change after the first mint.
 *
 * 8004scan re-indexes on the Updated event so the public agent page
 * picks up the new content within their batch window.
 *
 * Usage (PowerShell):
 *   vercel env pull .env.local --environment=production   # one-time
 *   $env:Q402_AGENT_REGISTRAR_KEY="0x<64-hex>"             # owner of the NFT
 *   node scripts/update-q402-agent.mjs --agent-id=114376 --dry-run
 *   node scripts/update-q402-agent.mjs --agent-id=114376
 *
 * The registrar wallet MUST be the current owner of the agent NFT —
 * setAgentURI is owner-only on the registry. Costs ~$0.05 BSC gas.
 *
 * Idempotency: when the content hash matches what's already on-chain
 * (same name + description), the script refuses with `URI_UNCHANGED`
 * so an accidental re-run doesn't burn gas on a no-op tx.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  keccak256,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { values } = parseArgs({
  options: {
    "dry-run":   { type: "boolean", default: false },
    "agent-id":  { type: "string" },
    network:     { type: "string", default: "bsc" },
    "env-file":  { type: "string" },
  },
});

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(values["env-file"] ?? resolve(__dirname, "..", ".env.local"));

const DRY_RUN  = !!values["dry-run"];
const NETWORK  = values["network"];
const AGENT_ID = values["agent-id"];

function die(msg) {
  process.stderr.write(`[update-q402] ERROR: ${msg}\n`);
  process.exit(1);
}

if (NETWORK !== "bsc") die(`only network=bsc is supported (got ${NETWORK})`);
if (!AGENT_ID || !/^\d+$/.test(AGENT_ID)) {
  die("--agent-id=<uint> required (e.g. --agent-id=114376)");
}

const REGISTRAR = process.env.Q402_AGENT_REGISTRAR_KEY;
if (!REGISTRAR) die("Q402_AGENT_REGISTRAR_KEY required (0x-prefixed 32-byte hex)");
if (!/^0x[0-9a-fA-F]{64}$/.test(REGISTRAR)) die("Q402_AGENT_REGISTRAR_KEY must be 32-byte hex");

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!DRY_RUN && (!KV_URL || !KV_TOKEN)) {
  die("KV_REST_API_URL and KV_REST_API_TOKEN required. Pass --dry-run to skip the KV write.");
}

const BSC_RPC = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const APP_ORIGIN = (process.env.APP_ORIGIN ?? "https://q402.quackai.ai").replace(/\/$/, "");
const FACILITATOR = "0xfc77FF29178B7286A8bA703D7a70895CA74fF466";

const ABI = [
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
];

// KEEP IN SYNC with register-q402-self.mjs::METADATA. The two scripts
// must produce byte-identical canonical JSON (= identical hash) for a
// given content version so a re-mint and a refresh land on the same
// KV slot if the content didn't actually change.
const METADATA = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Q402 (by Quack AI) — Gasless Stablecoin Payment Rails for AI Agents",
  description:
    "Q402 is Quack AI's payment infrastructure for autonomous AI agents — gasless USDC / USDT " +
    "settlement across 11 EVM chains (BNB, Ethereum, Avalanche, X Layer, Stable, Mantle, " +
    "Injective, Monad, Scroll, Arbitrum, Base) via EIP-7702 type-4 transactions + EIP-712 TransferAuthorization. " +
    "Free trial on BNB Chain, paid plan for multichain. Install with `npx @quackai/q402-mcp` " +
    "for Claude, Codex CLI, Cursor, or Cline.",
  services: [
    { name: "q402",  endpoint: `${APP_ORIGIN}/api/relay/info`, version: "1.3.1", walletAddress: FACILITATOR },
    // MCP service uses the HTTPS discovery endpoint so 8004scan can
    // health-check it. Kept in sync with the runtime metadata builder
    // at app/lib/erc8004.ts.
    { name: "MCP",   endpoint: `${APP_ORIGIN}/api/mcp/info` },
    { name: "web",   endpoint: APP_ORIGIN },
  ],
  x402Support: false,
  supportedTrust: ["reputation"],
  metadata: {
    chainCount: "9",
    facilitator: FACILITATOR,
    docsUrl: `${APP_ORIGIN}/docs`,
  },
};

function canonicalJson(payload) {
  return JSON.stringify(payload, (_key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const k of sortedKeys) out[k] = value[k];
    return out;
  });
}

function hashAgentMetadata(payload) {
  return keccak256(stringToBytes(canonicalJson(payload)));
}

function agentMetadataKey(hash) {
  return `aw:agent-md:${hash.toLowerCase()}`;
}

function agentMetadataUrl(hash) {
  return `${APP_ORIGIN}/api/wallet/agentic/agent-metadata/${hash.toLowerCase()}`;
}

async function kvSet(key, value) {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) die(`KV set failed (${res.status}): ${await res.text()}`);
}

async function main() {
  process.stderr.write(`[update-q402] network=${NETWORK} agent=#${AGENT_ID} ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);
  process.stderr.write(`[update-q402] new name: "${METADATA.name}"\n`);
  process.stderr.write(`[update-q402] app origin: ${APP_ORIGIN}\n`);

  const newHash = hashAgentMetadata(METADATA);
  const newUri = agentMetadataUrl(newHash);
  process.stderr.write(`[update-q402] new content hash: ${newHash}\n`);
  process.stderr.write(`[update-q402] new agentURI:     ${newUri}\n`);

  const account = privateKeyToAccount(REGISTRAR);
  const viemChain = {
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [BSC_RPC] } },
  };
  const publicClient = createPublicClient({ chain: viemChain, transport: http(BSC_RPC) });

  // Pre-flight: confirm caller owns the NFT and the URI is actually changing.
  let currentOwner, currentUri;
  try {
    [currentOwner, currentUri] = await Promise.all([
      publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "ownerOf", args: [BigInt(AGENT_ID)] }),
      publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "tokenURI", args: [BigInt(AGENT_ID)] }),
    ]);
  } catch (e) {
    die(`could not read registry state for agent #${AGENT_ID}: ${e?.shortMessage ?? e?.message ?? e}`);
  }

  process.stderr.write(`[update-q402] current owner:   ${currentOwner}\n`);
  process.stderr.write(`[update-q402] current uri:     ${currentUri}\n`);
  process.stderr.write(`[update-q402] caller address:  ${account.address}\n`);

  if (currentOwner.toLowerCase() !== account.address.toLowerCase()) {
    die(`registrar ${account.address} is NOT the current owner (${currentOwner}). Transfer the NFT first or sign with the owner key.`);
  }
  if (currentUri === newUri) {
    die("URI_UNCHANGED — the canonical content already matches what's on-chain. Edit METADATA and retry.");
  }

  if (DRY_RUN) {
    process.stderr.write("[update-q402] DRY RUN — skipping KV write + setAgentURI tx\n");
    process.stderr.write(JSON.stringify(METADATA, null, 2) + "\n");
    return;
  }

  process.stderr.write("[update-q402] writing new metadata to KV…\n");
  await kvSet(agentMetadataKey(newHash), METADATA);
  process.stderr.write(`[update-q402] KV write OK at ${agentMetadataKey(newHash)}\n`);

  const balance = await publicClient.getBalance({ address: account.address });
  process.stderr.write(`[update-q402] balance = ${balance} wei (${Number(balance) / 1e18} BNB)\n`);
  // setAgentURI is a single SSTORE — ~30k gas (vs register's ~200k for
  // the NFT mint), so the threshold is an order of magnitude lower.
  if (balance < 100_000_000_000_000n) {
    die("registrar wallet has under 0.0001 BNB — top it up to cover gas");
  }

  const walletClient = createWalletClient({ chain: viemChain, transport: http(BSC_RPC), account });
  const data = encodeFunctionData({
    abi: ABI,
    functionName: "setAgentURI",
    args: [BigInt(AGENT_ID), newUri],
  });
  process.stderr.write("[update-q402] submitting setAgentURI tx…\n");
  const txHash = await walletClient.sendTransaction({ to: REGISTRY, data });
  process.stderr.write(`[update-q402] tx hash: ${txHash}\n`);
  process.stderr.write("[update-q402] waiting for receipt…\n");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") die("transaction reverted");

  const scanUrl = `https://8004scan.io/agents/bsc/${AGENT_ID}`;
  process.stderr.write("\n=================================================================\n");
  process.stderr.write(`✓ agent #${AGENT_ID} updated\n`);
  process.stderr.write(`  tx:      https://bscscan.com/tx/${txHash}\n`);
  process.stderr.write(`  agent:   ${scanUrl}\n`);
  process.stderr.write(`  new uri: ${newUri}\n`);
  process.stderr.write("=================================================================\n");
  process.stderr.write("8004scan should re-index on the Updated event within their batch window.\n");
  process.stdout.write(JSON.stringify({ agentId: AGENT_ID, scanUrl, txHash, agentURI: newUri, metadataHash: newHash }) + "\n");
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
