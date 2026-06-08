/**
 * Q402 Hook #4 — ConditionalOracle.
 *
 * Lifecycle: beforeSettle.
 *
 * Gates a settlement on an external condition: a Chainlink price level
 * ("only settle when BTC/USD >= 80000") or a timestamp ("only settle
 * after this unix time"). This is the stablecoin limit-order primitive
 * — no other agentic-payments stack offers it, and it's our SECOND
 * Chainlink integration (CCIP being the first).
 *
 * The condition travels PER-PAYMENT in `params.condition` (not stored
 * per-wallet) — a payer attaches the gate to the specific intent.
 *
 * ── failMode: "closed" (the correct semantics for a conditional gate) ──
 *
 * If we cannot read the price, we DO NOT settle. A price condition whose
 * price is unreadable is, by definition, unverified — settling anyway
 * would defeat the entire point of the condition. So every error path
 * (unknown feed, RPC failure, stale round, feed-description mismatch)
 * resolves to a DENY, not an allow.
 *
 * ── "condition not met" is a soft 412, not an error ──
 *
 * When the price/time simply hasn't reached the threshold yet, that's
 * the EXPECTED state of an un-triggered limit order — the payer retries
 * later. We surface it as 412 Precondition Failed (CONDITION_NOT_MET),
 * distinct from the 5xx error denies, so clients can poll without
 * treating it as a hard failure.
 *
 * ── Feed-address safety ──
 *
 * The hardcoded Chainlink aggregator addresses are the well-known
 * mainnet Data Feeds, ENV-overridable. As a defense against a wrong/
 * stale address (which under fail-closed would block ALL price
 * conditions rather than mis-settle), we verify the aggregator's
 * on-chain description() matches the requested pair before trusting
 * its answer. A mismatch denies CONDITION_FEED_MISMATCH.
 */

import { createPublicClient, http, type Address } from "viem";
import type { Hook, HookContext, HookOutcome, OracleCondition } from "./types";
import { getPrimaryRpc } from "@/app/lib/relayer";

/** Minimal Chainlink AggregatorV3Interface surface. */
const AGGREGATOR_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

/**
 * Well-known Chainlink Data Feed aggregators per (chain, pair). Mainnet
 * addresses; ENV-overridable via CHAINLINK_FEED_{CHAIN}_{PAIR} (e.g.
 * CHAINLINK_FEED_ETH_BTC_USD). Verified against the on-chain
 * description() at read time — a wrong address denies rather than
 * mis-settles. Price conditions on chains/pairs not in this map deny
 * CONDITION_FEED_UNKNOWN; timestamp conditions never touch this map.
 */
const FEED_ADDRESSES: Record<string, Record<string, string>> = {
  bnb: {
    "BTC/USD": "0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf",
    "ETH/USD": "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e",
  },
  eth: {
    "BTC/USD": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
    "ETH/USD": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
  avax: {
    "BTC/USD": "0x2779D32d5166BAaa2B2b658333bA7e6Ec0C65743",
    "ETH/USD": "0x976B3D034E162d8bD72D6b9C989d545b839003b0",
  },
  arbitrum: {
    "BTC/USD": "0x6ce185860a4963106506C203335A2910413708e9",
    "ETH/USD": "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  },
};

/** A Chainlink round older than this is treated as dead/stale → deny. */
const STALE_AFTER_SEC = 25 * 60 * 60; // 25h — outlives any crypto-feed heartbeat

function resolveFeedAddress(chain: string, pair: string): string | null {
  const envKey = `CHAINLINK_FEED_${chain.toUpperCase()}_${pair.replace("/", "_").toUpperCase()}`;
  const override = process.env[envKey];
  if (override && /^0x[0-9a-fA-F]{40}$/.test(override)) return override;
  return FEED_ADDRESSES[chain]?.[pair] ?? null;
}

function normalisePair(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

export const conditionalOracle: Hook = {
  name: "ConditionalOracle",
  lifecycle: "beforeSettle",
  failMode: "closed",

  shouldRun(ctx: HookContext): boolean {
    return ctx.params?.condition !== undefined;
  },

  async run(ctx: HookContext): Promise<HookOutcome> {
    const cond = ctx.params?.condition;
    if (!cond) return { action: "allow" }; // shouldRun guards this; defensive.

    if (cond.kind === "timestamp") {
      return evalTimestamp(cond);
    }
    return evalPrice(ctx.chain, cond);
  },
};

function evalTimestamp(cond: OracleCondition): HookOutcome {
  const nowSec = Math.floor(Date.now() / 1000);
  const target = cond.value;
  const ok = compare(nowSec, cond.op, target, "time");
  if (ok === null) {
    return deny("CONDITION_INVALID_OP", 400, `operator ${cond.op} invalid for a timestamp condition`);
  }
  return ok
    ? { action: "allow" }
    : deny("CONDITION_NOT_MET", 412, `timestamp condition not yet met (now=${nowSec}, target=${target}, op=${cond.op})`, {
        kind: "timestamp", now: nowSec, target, op: cond.op,
      });
}

async function evalPrice(chain: string, cond: OracleCondition): Promise<HookOutcome> {
  if (!cond.feed) {
    return deny("CONDITION_FEED_REQUIRED", 400, "price condition requires a feed pair (e.g. BTC/USD)");
  }
  const feedAddr = resolveFeedAddress(chain, cond.feed);
  if (!feedAddr) {
    return deny("CONDITION_FEED_UNKNOWN", 400, `no Chainlink feed configured for ${cond.feed} on ${chain}`);
  }

  const client = createPublicClient({ transport: http(getPrimaryRpc(chain)) });

  // Read description() + decimals() + latestRoundData() together. Any
  // throw bubbles to the dispatcher which, with failMode "closed",
  // denies — but we catch here to attach a precise code.
  let description: string;
  let decimals: number;
  let answer: bigint;
  let updatedAt: bigint;
  try {
    const [desc, dec, round] = await Promise.all([
      client.readContract({ address: feedAddr as Address, abi: AGGREGATOR_ABI, functionName: "description" }),
      client.readContract({ address: feedAddr as Address, abi: AGGREGATOR_ABI, functionName: "decimals" }),
      client.readContract({ address: feedAddr as Address, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
    ]);
    description = desc as string;
    decimals = Number(dec);
    answer = (round as readonly bigint[])[1];
    updatedAt = (round as readonly bigint[])[3];
  } catch (e) {
    return deny("CONDITION_FEED_READ_FAILED", 502, `Chainlink feed read failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
  }

  // Safety: the on-chain description must match the requested pair.
  // Guards against a wrong/rotated feed address silently returning a
  // different asset's price.
  if (normalisePair(description) !== normalisePair(cond.feed)) {
    return deny("CONDITION_FEED_MISMATCH", 502, `feed at ${feedAddr} reports "${description}", expected "${cond.feed}"`);
  }

  // Staleness: a dead feed must not satisfy a condition off an old price.
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - Number(updatedAt) > STALE_AFTER_SEC) {
    return deny("CONDITION_FEED_STALE", 502, `feed ${cond.feed} last updated ${nowSec - Number(updatedAt)}s ago (> ${STALE_AFTER_SEC}s)`);
  }
  if (answer <= 0n) {
    return deny("CONDITION_FEED_BAD_PRICE", 502, `feed ${cond.feed} returned non-positive answer ${answer.toString()}`);
  }

  const price = Number(answer) / 10 ** decimals;
  const ok = compare(price, cond.op, cond.value, "price");
  if (ok === null) {
    return deny("CONDITION_INVALID_OP", 400, `operator ${cond.op} invalid for a price condition`);
  }
  return ok
    ? { action: "allow" }
    : deny("CONDITION_NOT_MET", 412, `price condition not met (${cond.feed}=${price}, target=${cond.value}, op=${cond.op})`, {
        kind: "price", feed: cond.feed, price, target: cond.value, op: cond.op,
      });
}

/**
 * Compare `current` against `target` under `op`. Returns null if the op
 * isn't valid for the domain (price ops: >= <= > < ; time ops: those
 * plus after/before aliases).
 */
function compare(current: number, op: OracleCondition["op"], target: number, domain: "price" | "time"): boolean | null {
  switch (op) {
    case ">=": return current >= target;
    case "<=": return current <= target;
    case ">": return current > target;
    case "<": return current < target;
    case "after": return domain === "time" ? current >= target : null;
    case "before": return domain === "time" ? current <= target : null;
    default: return null;
  }
}

function deny(code: string, status: number, reason: string, meta?: Record<string, unknown>): HookOutcome {
  return { action: "deny", code, reason, status, ...(meta ? { meta } : {}) };
}
