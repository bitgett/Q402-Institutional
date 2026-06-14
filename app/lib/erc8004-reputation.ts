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
 * Parse the wallet record's `erc8004AgentId` tag (stored as
 * `{network}:{agentId}` — see `setErc8004AgentId` in agentic-wallet.ts)
 * back into a `bigint` for use as the `uint256 agentId` arg to
 * `giveFeedback`. Returns `null` for unparseable input so the caller
 * (cron / smoke) can skip rather than throw on a bogus stored tag.
 *
 * Without this helper the cron blindly does `BigInt(record.erc8004AgentId)`,
 * which throws on the `"bsc:12345"` shape that's actually persisted — i.e.
 * every graduated agent gets marked as `failed` in the ledger and zero
 * feedback writes go out. Discovered by external audit before the first
 * automatic Sunday cron tick.
 */
export function parseAgentIdTag(tag: string | null | undefined): bigint | null {
  if (typeof tag !== "string" || tag.length === 0) return null;
  // Accept both the legacy raw-numeric form ("12345") and the
  // network-qualified form ("bsc:12345"). Anything else → null.
  const candidate = tag.includes(":") ? tag.split(":").pop() ?? "" : tag;
  if (!/^\d+$/.test(candidate)) return null;
  try {
    return BigInt(candidate);
  } catch {
    return null;
  }
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
 * Fire a single `giveFeedback` and return ONLY after the BSC receipt
 * confirms `status === "success"`. The relayer pays BSC gas
 * (~$0.07-0.10 per call). Reverts / dropped txs throw so the caller
 * (the weekly cron) treats them as failed instead of silently caching
 * a dead tx hash as "fired".
 *
 * Wait window: 60s — BSC blocks are ~3s and one giveFeedback is a
 * single block tx, so this is generous. The cron's per-tx budget
 * (~2-3s nominal, 60s on a sluggish RPC) stays well inside the
 * 300s maxDuration of the route handler.
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
  const txHash = await wallet.sendTransaction({
    account,
    chain: null,
    to: cfg.registry,
    data,
    value: 0n,
  });
  // Confirm the tx actually mined + didn't revert before reporting
  // success. Without this, a tx hash whose underlying call later
  // reverted would still land in the ledger as `fired`, masking
  // failures and burning the same agent's weekly slot for nothing.
  const reader = readClient(network);
  const receipt = await reader.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
    confirmations: 1,
  });
  if (receipt.status !== "success") {
    throw new Error(
      `giveFeedback reverted (tx ${txHash}, status=${receipt.status})`,
    );
  }
  return txHash;
}

/**
 * Read a per-agent summary the way 8004scan does — surfaces the
 * aggregate `count`, `summaryValue`, `summaryValueDecimals` so we can
 * verify our weekly fires are actually landing on-chain.
 *
 * Pass an empty `clientAddresses` array to aggregate across ALL
 * feedback sources; pass `[relayerAddress]` to scope to Q402's own
 * writes only. The `tag1` / `tag2` defaults match our weekly cadence
 * but can be overridden to "" / "" for a fully unscoped read.
 */
export async function readSummary(
  agentId: bigint,
  clients: Address[],
  network: Erc8004Network = "bsc",
  tag1: string = REPUTATION_TAG_WEEKLY,
  tag2: string = "bsc",
): Promise<{ count: bigint; value: bigint; decimals: number }> {
  const cfg = REPUTATION_NETWORKS[network];
  const reader = readClient(network);
  const result = (await reader.readContract({
    address: cfg.registry,
    abi: REPUTATION_ABI,
    functionName: "getSummary",
    args: [agentId, clients, tag1, tag2],
  })) as [bigint, bigint, number];
  return { count: result[0], value: result[1], decimals: result[2] };
}

/**
 * Public-facing reputation snapshot. Two views surfaced side-by-side:
 *
 *   - `total`    — aggregate across ALL feedback sources + tags.
 *                  What an outside observer sees when they land on
 *                  8004scan and look at the agent's overall score.
 *   - `fromQ402` — scoped to Q402's relayer address + the
 *                  `q402-weekly` tag. Tells the agent owner how many
 *                  weekly heartbeats Q402's cron has fired on their
 *                  behalf so far.
 *
 * Numbers come back JSON-safe (strings + `number` for decimals) so
 * the same shape can flow through the dashboard + MCP responses
 * without bigint serialisation headaches.
 */
export interface ReputationSummaryView {
  agentId: string;
  total: { feedbackCount: number; summaryValue: string; valueDecimals: number };
  fromQ402: { feedbackCount: number; summaryValue: string; valueDecimals: number };
  scan8004Url: string;
  lastChecked: number;
}

/** TTL for the cached reputation summary. Reputation only ticks once
 *  a week (cron) + occasional manual fires, so a 5-minute cache is
 *  generous + keeps dashboard / MCP polls cheap. */
const REPUTATION_CACHE_TTL_SEC = 5 * 60;
const reputationCacheKey = (agentId: string) => `aw:rep-cache:${agentId}`;

/** Negative-cache TTL. When an RPC read fails we stash a short-lived
 *  "miss" marker so the dashboard / MCP polls don't re-hammer a sick
 *  RPC on every request. Kept deliberately short (30s) so a transient
 *  outage self-heals on the next poll after the window expires while a
 *  flapping RPC still gets meaningful relief. Uses the SAME @vercel/kv
 *  store as the success path, under a distinct key namespace so a
 *  cached miss can never be mistaken for a real `ReputationSummaryView`. */
const REPUTATION_NEG_CACHE_TTL_SEC = 30;
const reputationMissKey = (agentId: string) => `aw:rep-miss:${agentId}`;

/**
 * Cached two-view reputation read. Used by `GET /api/wallet/agentic`
 * and `POST /api/wallet/agentic/info-by-key` (MCP path).
 *
 * Returns null when the RPC reads fail outright — the dashboard /
 * MCP responses then just omit the `reputation` field rather than
 * surface a misleading "0 feedback" when the chain was actually
 * unreachable.
 */
export async function readReputationSummary(
  agentIdOrTag: string,
  relayerAddress: Address,
  network: Erc8004Network = "bsc",
): Promise<ReputationSummaryView | null> {
  // Accept both the canonical `{network}:{agentId}` tag (what wallet
  // records store) and the bare numeric form. Before this, callers
  // passing `record.erc8004AgentId` (always tag-shaped) silently got
  // `null` back → dashboard + MCP showed no reputation even for
  // graduated wallets.
  const agentId = parseAgentIdTag(agentIdOrTag);
  if (agentId === null) return null;
  const agentIdStr = agentId.toString();

  // ── Cache hit ─────────────────────────────────────────────────────
  try {
    const { kv } = await import("@vercel/kv");
    const cached = await kv.get<ReputationSummaryView>(reputationCacheKey(agentIdStr));
    if (cached && Date.now() - cached.lastChecked < REPUTATION_CACHE_TTL_SEC * 1000) {
      return cached;
    }
    // Negative-cache hit: a recent RPC read failed. Return the same
    // graceful `null` callers already handle WITHOUT re-hitting the RPC.
    // The key's own TTL expires the miss, so a later retry can succeed.
    const miss = await kv.get<{ failedAt: number }>(reputationMissKey(agentIdStr));
    if (miss) return null;
  } catch {
    /* cache failure is non-fatal — fall through to live read */
  }

  // ── Live read (2 RPC calls in parallel) ───────────────────────────
  let total: { count: bigint; value: bigint; decimals: number };
  let fromQ402: { count: bigint; value: bigint; decimals: number };
  try {
    [total, fromQ402] = await Promise.all([
      readSummary(agentId, [], network, "", ""),
      readSummary(agentId, [relayerAddress], network, REPUTATION_TAG_WEEKLY, "bsc"),
    ]);
  } catch (e) {
    console.error("[readReputationSummary] RPC read failed for agent " + agentIdStr + ":", e);
    // Negative-cache the failure so subsequent polls inside the short
    // TTL return a graceful `null` instead of re-attempting (and
    // re-erroring on) the same sick RPC every request. The key's TTL
    // expires the miss, so a later retry can still succeed.
    try {
      const { kv } = await import("@vercel/kv");
      await kv.set(
        reputationMissKey(agentIdStr),
        { failedAt: Date.now() },
        { ex: REPUTATION_NEG_CACHE_TTL_SEC },
      );
    } catch {
      /* non-fatal */
    }
    return null;
  }

  const view: ReputationSummaryView = {
    agentId: agentIdStr,
    total: {
      feedbackCount: Number(total.count),
      summaryValue: total.value.toString(),
      valueDecimals: total.decimals,
    },
    fromQ402: {
      feedbackCount: Number(fromQ402.count),
      summaryValue: fromQ402.value.toString(),
      valueDecimals: fromQ402.decimals,
    },
    scan8004Url: `https://8004scan.io/agents/bsc/${agentIdStr}`,
    lastChecked: Date.now(),
  };

  // ── Cache the view ────────────────────────────────────────────────
  try {
    const { kv } = await import("@vercel/kv");
    await kv.set(reputationCacheKey(agentIdStr), view, { ex: REPUTATION_CACHE_TTL_SEC });
  } catch {
    /* non-fatal */
  }

  return view;
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
