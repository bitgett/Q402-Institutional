#!/usr/bin/env node
/**
 * register-q402-self.mjs — register Q402 itself as an ERC-8004 agent.
 *
 * One-shot operator script. Builds the Q402-as-agent metadata, computes
 * the keccak256 content-hash, writes the JSON into Vercel KV at the
 * same key the public agent-metadata route serves
 * (`aw:agent-md:{hash}`), then submits the ERC-8004 `register(agentURI)`
 * tx from `Q402_AGENT_REGISTRAR_KEY` on BSC mainnet. Prints the
 * assigned `agentId` and the 8004scan URL so the public landing can
 * advertise "Q402 is ERC-8004 agent #N."
 *
 * Trade-off: this puts an external dependency on Vercel KV (which Q402
 * already requires) instead of IPFS pinning. Aligned with how live
 * users' dashboards register — both paths now share the
 * `agent-metadata-store` helper + the self-hosted `agentURI` URL
 * shape, so resolvers fetch from `q402.quackai.ai`, not from any
 * third-party gateway.
 *
 * Usage (PowerShell — simplest path):
 *
 *   # 1. Pull Vercel-managed env once. This produces .env.local with
 *   #    KV_REST_API_URL + KV_REST_API_TOKEN already populated:
 *   vercel env pull .env.local --environment=production
 *
 *   # 2. Only the registrar key has to come from outside Vercel (it's
 *   #    the operator's own wallet, not something the project stores):
 *   $env:Q402_AGENT_REGISTRAR_KEY="0x<64-hex>"
 *
 *   # 3. Dry-run preview → live submit.
 *   node scripts/register-q402-self.mjs --dry-run
 *   node scripts/register-q402-self.mjs
 *
 * The script auto-loads `.env.local` from the repo root. Override with
 * `--env-file=/path/to/file` if you keep secrets elsewhere. Process env
 * always beats the file on collisions.
 *
 * Optional overrides:
 *   APP_ORIGIN     — defaults to https://q402.quackai.ai
 *   BSC_RPC_URL    — defaults to public BNB dataseed
 *
 * Cost: ~$0.05 BSC gas. The registrar wallet must have ≥0.001 BNB to
 * cover it.
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
  decodeEventLog,
  keccak256,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    network:   { type: "string", default: "bsc" },
    "env-file": { type: "string" },
  },
});

/**
 * Auto-load env from `.env.local` (or whatever `--env-file=…` points
 * at) so the operator only needs to run `vercel env pull .env.local`
 * once and then `node scripts/register-q402-self.mjs`. Without this
 * they would have to either (a) export every env var manually, or
 * (b) launch Node with the built-in `--env-file=` flag, which is
 * easy to forget. Reads minimal KEY=VALUE syntax — no quoting,
 * comments stripped, blank lines ignored. Process env wins on
 * collision so an explicitly-exported variable always takes
 * precedence over the file.
 */
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
    // Strip simple surrounding quotes if present (vercel env pull
    // produces double-quoted values for entries containing whitespace
    // or special chars).
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(values["env-file"] ?? resolve(__dirname, "..", ".env.local"));

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

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!DRY_RUN && (!KV_URL || !KV_TOKEN)) {
  die("KV_REST_API_URL and KV_REST_API_TOKEN required (Vercel KV integration → Settings → REST API). Pass --dry-run to skip the KV write.");
}

const BSC_RPC = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const APP_ORIGIN = (process.env.APP_ORIGIN ?? "https://q402.quackai.ai").replace(/\/$/, "");
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
  name: "Q402 (by Quack AI) — Gasless Stablecoin Payment Rails for AI Agents",
  description:
    "Q402 is Quack AI's payment infrastructure for autonomous AI agents — gasless USDC / USDT " +
    "settlement across 9 EVM chains (BNB, Ethereum, Avalanche, X Layer, Stable, Mantle, " +
    "Injective, Monad, Scroll) via EIP-7702 type-4 transactions + EIP-712 TransferAuthorization. " +
    "Free trial on BNB Chain, paid plan for multichain. Install with `npx @quackai/q402-mcp` " +
    "for Claude, Codex CLI, Cursor, or Cline.",
  services: [
    { name: "q402",  endpoint: `${APP_ORIGIN}/api/relay/info`, version: "1.3.1", walletAddress: FACILITATOR },
    { name: "MCP",   endpoint: "npm://@quackai/q402-mcp" },
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

/** Mirror of `app/lib/agent-metadata-store.ts::canonicalJson`. Keys
 *  sorted recursively so server-side and CLI-side hashes converge for
 *  identical content regardless of the producer's key ordering. */
function canonicalJson(payload) {
  return JSON.stringify(payload, (_key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const k of sortedKeys) {
      out[k] = value[k];
    }
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
  // Upstash REST: POST [url]/set/<key> with body = value (JSON-stringified).
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
  process.stderr.write(`[register-q402] network=${NETWORK} ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);
  process.stderr.write(`[register-q402] metadata name: "${METADATA.name}"\n`);
  process.stderr.write(`[register-q402] app origin:    ${APP_ORIGIN}\n`);

  const hash = hashAgentMetadata(METADATA);
  const agentURI = agentMetadataUrl(hash);
  process.stderr.write(`[register-q402] content hash:  ${hash}\n`);
  process.stderr.write(`[register-q402] agentURI:      ${agentURI}\n`);

  if (DRY_RUN) {
    process.stderr.write("[register-q402] (skipping KV write + chain submit in dry run)\n");
    process.stderr.write("[register-q402] METADATA preview:\n");
    process.stderr.write(JSON.stringify(METADATA, null, 2) + "\n");
    return;
  }

  process.stderr.write("[register-q402] writing metadata to KV…\n");
  await kvSet(agentMetadataKey(hash), METADATA);
  process.stderr.write(`[register-q402] KV write OK at ${agentMetadataKey(hash)}\n`);

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

  const txHash = await walletClient.sendTransaction({ to: REGISTRY, data });
  process.stderr.write(`[register-q402] tx hash: ${txHash}\n`);
  process.stderr.write("[register-q402] waiting for receipt…\n");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
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

  // 8004scan uses chain-slug paths (`/agents/bsc/{id}`), NOT the
  // EIP-155 CAIP-2 form the earlier draft of this script printed.
  // Keep this in sync with `scanUrl()` in app/lib/erc8004.ts.
  const scanUrl = `https://8004scan.io/agents/bsc/${agentId}`;
  process.stderr.write("\n=================================================================\n");
  process.stderr.write(`✓ Q402 registered as ERC-8004 agent #${agentId} on BSC mainnet\n`);
  process.stderr.write(`  tx:      https://bscscan.com/tx/${txHash}\n`);
  process.stderr.write(`  agent:   ${scanUrl}\n`);
  process.stderr.write(`  uri:     ${agentURI}\n`);
  process.stderr.write("=================================================================\n");
  process.stdout.write(JSON.stringify({ agentId, scanUrl, txHash, agentURI, metadataHash: hash }) + "\n");
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
