/**
 * Q (QuackAI token) USD price via the PancakeSwap V3 Q/USDT pool TWAP.
 *
 * Q is NOT a stablecoin, so the Agent Wallet's USD-denominated limits need a
 * live price to value a Q transfer. We read a 30-minute TWAP from the deepest
 * Q market — the PancakeSwap V3 Q/USDT pool (fee 0.01%, ~$1M TVL, observation
 * cardinality 360) — which is far more expensive to manipulate than spot. The
 * pair is Q/USDT, so this yields Q/USD directly (USDT ~= $1), no WBNB hop.
 *
 * Pool token ordering: token0 = USDT (0x55d3..), token1 = Q (0xc07e..), both
 * 18 decimals, so the decimal adjustment cancels and USD-per-Q = 1.0001^(-tick).
 *
 * Fail policy: this THROWS on RPC/observe failure or an out-of-band price so a
 * spend path can fail CLOSED — an unpriced Q transfer must never slip past the
 * USD limit. A short in-memory cache avoids hammering the RPC on bursts.
 */
import { createPublicClient, http, type Address } from "viem";
import { AGENTIC_CHAINS } from "./agentic-wallet-sign";

/** PancakeSwap V3 Q/USDT pool, fee tier 0.01% — the deepest Q market on BNB. */
export const QUACK_USDT_V3_POOL: Address = "0x8bafe0bdd3eb9ae0539f5b32e771c1a72a189b7f";
const TWAP_WINDOW_SEC = 1800;
const CACHE_TTL_MS = 60_000;
// Sanity band: a price outside this range is treated as corrupt/manipulated
// and THROWS rather than feeding garbage into limit math. Q has traded around
// $0.017; the band is wide enough to survive real moves, tight enough to catch
// a poisoned read (0, infinity, decimals mistake).
const MIN_USD = 0.0001;
const MAX_USD = 100;

const POOL_ABI = [
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
] as const;

/** USD per Q from a V3 tick. token0=USDT, token1=Q, equal decimals, so
 *  price(token1/token0)=1.0001^tick = Q per USDT, and USD-per-Q is its inverse. */
function tickToQuackUsd(tick: number): number {
  return Math.pow(1.0001, -tick);
}

let cache: { price: number; at: number } | null = null;

/**
 * Current USD value of 1 Q, from the 30-min TWAP. Throws on read failure, an
 * unservable TWAP window, or an out-of-band price so callers fail CLOSED —
 * there is deliberately no spot (slot0) fallback: spot is far cheaper to
 * manipulate than a 30-min TWAP, and this value gates a spend/pay path.
 */
export async function quackUsdPrice(): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.price;
  const client = createPublicClient({ transport: http(AGENTIC_CHAINS.bnb.rpc) });

  // TWAP only — fail CLOSED. If observe() reverts (RPC error, or the pool's
  // observation window can't serve the full 30-min TWAP because cardinality
  // shrank or trading spiked) we let it THROW so callers return 503 rather than
  // quote a manipulable price. The remedy for a persistent revert is to grow the
  // pool's observation cardinality, NOT to price off spot. (Audit P1, 2026-07-03.)
  const result = (await client.readContract({
    address: QUACK_USDT_V3_POOL,
    abi: POOL_ABI,
    functionName: "observe",
    args: [[TWAP_WINDOW_SEC, 0]],
  })) as readonly [readonly bigint[], readonly bigint[]];
  const tickCumulatives = result[0];
  // tickCumulatives[1] is "now", [0] is TWAP_WINDOW_SEC ago.
  const avgTick = Number(tickCumulatives[1] - tickCumulatives[0]) / TWAP_WINDOW_SEC;
  const price = tickToQuackUsd(avgTick);

  if (!Number.isFinite(price) || price < MIN_USD || price > MAX_USD) {
    throw new Error(`quack price out of sane band: ${price}`);
  }
  cache = { price, at: Date.now() };
  return price;
}

/**
 * Convert a human Q amount to its USD value at the current TWAP. Throws if the
 * price can't be read — a spend path value-gating a Q transfer MUST fail closed.
 */
export async function quackAmountToUsd(quackAmount: number): Promise<number> {
  const price = await quackUsdPrice();
  return quackAmount * price;
}

/** Test seam — pure tick→USD math, no network. */
export const __test = { tickToQuackUsd };
