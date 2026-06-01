/**
 * erc8004-reputation.ts — ERC-8004 ReputationRegistry client.
 *
 * Companion to `erc8004.ts` (which handles the Identity side). This
 * module wraps the on-chain ReputationRegistry that 8004scan indexes
 * for per-agent reputation scoring.
 *
 * Q402 acts as a neutral "facilitator oracle": every Q402-graduated
 * agent (one with `erc8004AgentId` stamped on its Agent Wallet record)
 * gets a single `giveFeedback` write per week, fired by the relayer
 * master key, summarising that agent's settlement activity from the
 * preceding 7-day window. This is intentionally light — the EIP-8004
 * spec has no native batch helper, and per-settlement writes would cost
 * ~$0.07-0.10 of BSC gas each. Once-per-week throttling drops the bill
 * to ~$23/week for the top 100 most-active agents while still giving
 * 8004scan a regular activity heartbeat to aggregate.
 *
 * Sources:
 *   EIP-8004 spec — https://eips.ethereum.org/EIPS/eip-8004
 *   BSC mainnet  — proxy 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *                  impl  0x16e0FA7f7c56b9a767e34b192b51f921be31da34
 *   Verified ABI — bscscan.com/address/0x16e0FA7f7c56b9a767e34b192b51f921be31da34#code
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

import { ERC8004_NETWORKS, type Erc8004Network } from "./erc8004";
import { loadRelayerKey } from "./relayer-key";

/**
 * Verified ABI fragment — keep this surface MINIMAL. We only write
 * `giveFeedback` and read `getSummary`; the other functions (`revoke`,
 * `appendResponse`) are deferred to Phase 5 if/when refund + dispute
 * flows land.
 */
export const REPUTATION_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
  {
    type: "event",
    name: "NewFeedback",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: false },
      { name: "value", type: "int128", indexed: false },
      { name: "valueDecimals", type: "uint8", indexed: false },
      { name: "indexedTag1", type: "string", indexed: true },
      { name: "tag1", type: "string", indexed: false },
      { name: "tag2", type: "string", indexed: false },
      { name: "endpoint", type: "string", indexed: false },
      { name: "feedbackURI", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

/**
 * ReputationRegistry proxy address per supported chain. Same network
 * map shape as `ERC8004_NETWORKS` in `erc8004.ts` — we expose a single
 * map here to keep ABI + registry address adjacent. BSC mainnet only
 * for v1; the spec is multi-chain but Q402 currently graduates BSC
 * agents only.
 */
const REPUTATION_REGISTRY_BSC = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

export const REPUTATION_NETWORKS: Record<Erc8004Network, { registry: Address; chainId: number; rpc: string }> = {
  bsc: {
    registry: REPUTATION_REGISTRY_BSC,
    chainId: 56,
    rpc: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
  },
  "bsc-testnet": {
    chainId: 97,
    // Testnet ReputationRegistry — same vanity-prefixed deployer pattern.
    // If the testnet deployment uses a different proxy, override via env.
    registry: (process.env.REPUTATION_REGISTRY_BSC_TESTNET ??
      REPUTATION_REGISTRY_BSC) as Address,
    rpc: process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545",
  },
  eth: { ...placeholder("eth"), registry: REPUTATION_REGISTRY_BSC },
  base: { ...placeholder("base"), registry: REPUTATION_REGISTRY_BSC },
  polygon: { ...placeholder("polygon"), registry: REPUTATION_REGISTRY_BSC },
  arbitrum: { ...placeholder("arbitrum"), registry: REPUTATION_REGISTRY_BSC },
  celo: { ...placeholder("celo"), registry: REPUTATION_REGISTRY_BSC },
};

function placeholder(net: Erc8004Network): { chainId: number; rpc: string } {
  const cfg = ERC8004_NETWORKS[net];
  return { chainId: cfg.chainId, rpc: cfg.rpc };
}

/**
 * `tag1` namespace for the Q402 weekly heartbeat. Indexed so 8004scan
 * (or any third-party indexer) can filter "all Q402 reputation events"
 * cheaply. Keep this string stable across the codebase — Q402 v1 owns
 * exactly this tag.
 */
export const REPUTATION_TAG_WEEKLY = "q402-weekly";

/**
 * Build the canonical `feedbackHash` for a weekly summary. Currently a
 * deterministic keccak of the agentId + ISO week so the hash is
 * predictable + de-duplicatable from off-chain tooling. Once Phase 4.2
 * lands the per-agent daily summary JSON, switch this to keccak(JSON).
 */
export function buildWeeklyFeedbackHash(agentId: bigint, isoWeek: string): Hex {
  return keccak256(toBytes(`q402:weekly:${agentId.toString()}:${isoWeek}`));
}

/**
 * Inputs for a single weekly feedback write. All fields are intentional
 * — we don't accept callsite-chosen tag1/feedbackURI so a misuse can't
 * leak unsigned strings into our on-chain reputation tag namespace.
 */
export interface WeeklyFeedbackInput {
  agentId: bigint;
  /** Settlement count for the past 7 days. Capped to int128 range. */
  settlements7d: number;
  /** ISO week stamp, e.g. "2026-W22". Used as the dedup key + feedbackHash input. */
  isoWeek: string;
  /** Public Q402 relay endpoint declared in the agent metadata. */
  endpoint: string;
  /** Optional off-chain summary URL. Empty string means "none". */
  feedbackURI?: string;
}

/**
 * Encode a `giveFeedback` call into raw calldata. Used both by the
 * sequential firing path (one tx per agent) and by the optional
 * Multicall3 wrapper (Phase 4.2).
 */
export function encodeGiveFeedback(input: WeeklyFeedbackInput): Hex {
  // int128 max is ~1.7e38 — overflow protection is academic for
  // settlement counts but stay conservative.
  if (input.settlements7d < 0 || input.settlements7d > Number.MAX_SAFE_INTEGER) {
    throw new Error(`settlements7d out of range: ${input.settlements7d}`);
  }
  return encodeFunctionData({
    abi: REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [
      input.agentId,
      BigInt(input.settlements7d),
      0,
      REPUTATION_TAG_WEEKLY,
      "bsc",
      input.endpoint,
      input.feedbackURI ?? "",
      buildWeeklyFeedbackHash(input.agentId, input.isoWeek),
    ],
  });
}

/**
 * Read public client. Cheap to instantiate per-call; we keep the
 * factory inline so callers can pass an RPC override if they want
 * to read off a private RPC in CI.
 */
export function readClient(network: Erc8004Network = "bsc"): PublicClient {
  const cfg = REPUTATION_NETWORKS[network];
  return createPublicClient({
    chain: {
      id: cfg.chainId,
      name: ERC8004_NETWORKS[network].name,
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpc] } },
    },
    transport: http(cfg.rpc),
  }) as unknown as PublicClient;
}

/**
 * Wallet client signed by the Q402 relayer master key. Used by the
 * weekly cron to fire `giveFeedback` from a stable address — that
 * `clientAddress` then becomes the indexed event field 8004scan
 * groups feedback by.
 *
 * Reuses `loadRelayerKey()` so the relayer-address mismatch guard
 * fires identically here as on the settlement path — same single key,
 * same single accounting.
 */
export function reputationWalletClient(network: Erc8004Network = "bsc"): WalletClient {
  const keyResult = loadRelayerKey();
  if (!keyResult.ok) {
    throw new Error(`relayer key unavailable (${keyResult.reason}): ${keyResult.detail}`);
  }
  const account = privateKeyToAccount(keyResult.privateKey);
  const cfg = REPUTATION_NETWORKS[network];
  return createWalletClient({
    account,
    chain:
      network === "bsc"
        ? bsc
        : {
            id: cfg.chainId,
            name: ERC8004_NETWORKS[network].name,
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: { default: { http: [cfg.rpc] } },
          },
    transport: http(cfg.rpc),
  });
}

/**
 * Fire a single `giveFeedback` and return the tx hash. The relayer
 * pays BSC gas (~$0.07-0.10 per call). Reverts bubble up so the
 * caller (the weekly cron) can decide whether to retry, skip, or
 * mark the agent as deferred.
 */
export async function fireWeeklyFeedback(
  input: WeeklyFeedbackInput,
  network: Erc8004Network = "bsc",
): Promise<Hash> {
  const cfg = REPUTATION_NETWORKS[network];
  const wallet = reputationWalletClient(network);
  const account = wallet.account;
  if (!account) throw new Error("wallet client has no account");
  const data = encodeGiveFeedback(input);
  return wallet.sendTransaction({
    account,
    chain: null,
    to: cfg.registry,
    data,
    value: 0n,
  });
}

/**
 * Read a per-agent summary the way 8004scan does — surfaces the
 * aggregate `count`, `summaryValue`, `summaryValueDecimals` so we can
 * verify our weekly fires are actually landing on-chain. Used by the
 * smoke test + ops dashboards, not the hot path.
 *
 * Pass an empty `clientAddresses` array to aggregate across ALL
 * feedback sources; pass `[relayerAddress]` to scope to Q402's own
 * writes only.
 */
export async function readSummary(
  agentId: bigint,
  clients: Address[],
  network: Erc8004Network = "bsc",
): Promise<{ count: bigint; value: bigint; decimals: number }> {
  const cfg = REPUTATION_NETWORKS[network];
  const reader = readClient(network);
  const result = (await reader.readContract({
    address: cfg.registry,
    abi: REPUTATION_ABI,
    functionName: "getSummary",
    args: [agentId, clients, REPUTATION_TAG_WEEKLY, "bsc"],
  })) as [bigint, bigint, number];
  return { count: result[0], value: result[1], decimals: result[2] };
}

/**
 * Compute the current ISO week stamp like `2026-W22`. Used as the
 * dedup key for the weekly fire cycle — two cron runs in the same
 * ISO week should land on the same key + no-op the second.
 */
export function currentIsoWeek(now: Date = new Date()): string {
  // Standard ISO 8601 week — Thursday-anchored, week starts Monday.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
