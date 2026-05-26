#!/usr/bin/env node
/**
 * register-q402-self.mjs — register Q402 itself as an ERC-8004 agent.
 *
 * One-shot script. Submits an ERC-8004 `register(agentURI)` tx from a
 * configured operator wallet (`Q402_AGENT_REGISTRAR_KEY`) on BSC
 * mainnet, then prints the assigned `agentId` and the 8004scan URL so
 * the public landing can advertise "Q402 is ERC-8004 agent #N."
 *
 * The metadata JSON is built locally (no Pinata round-trip needed) and
 * pinned via the same Pinata helper the dashboard route uses, so that
 * users and Q402 itself live under the same identity-file convention.
 *
 * Usage (PowerShell):
 *   $env:Q402_AGENT_REGISTRAR_KEY="0x<64-hex>"   # the EOA that owns the NFT
 *   $env:PINATA_JWT="<jwt>"
 *   $env:BSC_RPC_URL="<rpc>"                     # optional; defaults to dataseed
 *   node scripts/register-q402-self.mjs --dry-run         # build + pin, no tx
 *   node scripts/register-q402-self.mjs                   # live
 *
 * Cost: ~$0.05 BSC gas. The registrar wallet must have a small BNB
 * balance to cover it.
 */

import { parseArgs } from "node:util";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    network:   { type: "string", default: "bsc" },
  },
});

const DRY_RUN = !!values["dry-run"];
const NETWORK = values["network"];

function die(msg) {
  process.stderr.write(`[register-q402] ERROR: ${msg}\n`);
  process.exit(1);
}

if (NETWORK !== "bsc") die(`only network=bsc is supported in v1 (got ${NETWORK})`);

const REGISTRAR = process.env.Q402_AGENT_REGISTRAR_KEY;
if (!REGISTRAR) die("Q402_AGENT_REGISTRAR_KEY required (0x-prefixed 32-byte hex)");
if (!/^0x[0-9a-fA-F]{64}$/.test(REGISTRAR)) die("Q402_AGENT_REGISTRAR_KEY must be 32-byte hex");

const PINATA_JWT = process.env.PINATA_JWT;
if (!DRY_RUN && !PINATA_JWT) die("PINATA_JWT required (or pass --dry-run)");

const BSC_RPC = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const RELAY_BASE = process.env.APP_ORIGIN ?? "https://q402.quackai.ai";
const FACILITATOR = "0xfc77FF29178B7286A8bA703D7a70895CA74fF466";

const REGISTER_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
];

const METADATA = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Q402 — Gasless Stablecoin Payment Rails for AI Agents",
  description:
    "Q402 is the payment infrastructure for autonomous AI agents — gasless USDC / USDT settlement " +
    "across 9 EVM chains (BNB, Ethereum, Avalanche, X Layer, Stable, Mantle, Injective, Monad, Scroll) " +
    "via EIP-7702 type-4 transactions + EIP-712 TransferAuthorization. Used by 745+ payers, " +
    "settled 11,700+ payments to date. Available as @quackai/q402-mcp on npm for Claude, " +
    "Codex CLI, Cursor, and Cline.",
  services: [
    { name: "q402",  endpoint: `${RELAY_BASE}/api/relay/info`, version: "1.3.1", walletAddress: FACILITATOR },
    { name: "MCP",   endpoint: "npm://@quackai/q402-mcp" },
    { name: "web",   endpoint: RELAY_BASE },
  ],
  x402Support: false,
  supportedTrust: ["reputation"],
  metadata: {
    chainCount: "9",
    facilitator: FACILITATOR,
    docsUrl: `${RELAY_BASE}/docs`,
  },
};

async function pinJsonToPinata(payload) {
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: JSON.stringify({
      pinataContent: payload,
      pinataMetadata: { name: "q402-self-agent-metadata" },
      pinataOptions: { cidVersion: 1 },
    }),
  });
  if (!res.ok) die(`pinata ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data?.IpfsHash) die("pinata returned no IpfsHash");
  return `ipfs://${data.IpfsHash}`;
}

async function main() {
  process.stderr.write(`[register-q402] network=${NETWORK} ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);
  process.stderr.write(`[register-q402] metadata name: "${METADATA.name}"\n`);

  if (DRY_RUN) {
    process.stderr.write("[register-q402] (skipping IPFS pin in dry run)\n");
    process.stderr.write("[register-q402] METADATA preview:\n");
    process.stderr.write(JSON.stringify(METADATA, null, 2) + "\n");
    return;
  }

  process.stderr.write("[register-q402] pinning metadata to IPFS…\n");
  const agentURI = await pinJsonToPinata(METADATA);
  process.stderr.write(`[register-q402] agentURI = ${agentURI}\n`);

  const account = privateKeyToAccount(REGISTRAR);
  const viemChain = {
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [BSC_RPC] } },
  };
  const publicClient = createPublicClient({ chain: viemChain, transport: http(BSC_RPC) });
  const walletClient = createWalletClient({ chain: viemChain, transport: http(BSC_RPC), account });

  process.stderr.write(`[register-q402] from = ${account.address}\n`);
  const balance = await publicClient.getBalance({ address: account.address });
  process.stderr.write(`[register-q402] balance = ${balance} wei (${Number(balance) / 1e18} BNB)\n`);
  if (balance < 1_000_000_000_000_000n) {
    die("registrar wallet has under 0.001 BNB — top it up to cover gas");
  }

  const data = encodeFunctionData({ abi: REGISTER_ABI, functionName: "register", args: [agentURI] });
  process.stderr.write("[register-q402] submitting register tx…\n");

  const hash = await walletClient.sendTransaction({ to: REGISTRY, data });
  process.stderr.write(`[register-q402] tx hash: ${hash}\n`);
  process.stderr.write("[register-q402] waiting for receipt…\n");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") die("transaction reverted");

  let agentId = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== REGISTRY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: REGISTER_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "Registered") {
        agentId = decoded.args.agentId.toString();
        break;
      }
    } catch { /* not our event */ }
  }
  if (!agentId) die("Registered event not found in receipt");

  const scanUrl = `https://8004scan.io/eip155:56/agent/${agentId}`;
  process.stderr.write("\n=================================================================\n");
  process.stderr.write(`✓ Q402 registered as ERC-8004 agent #${agentId} on BSC mainnet\n`);
  process.stderr.write(`  tx:      https://bscscan.com/tx/${hash}\n`);
  process.stderr.write(`  agent:   ${scanUrl}\n`);
  process.stderr.write(`  uri:     ${agentURI}\n`);
  process.stderr.write("=================================================================\n");
  process.stdout.write(JSON.stringify({ agentId, scanUrl, txHash: hash, agentURI }) + "\n");
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
