/**
 * Q402 Yield — adapter registry + public surface.
 *
 * Routes/MCP/dashboard import from here, staying protocol-agnostic.
 * Aave ships in Phase 0; Morpho (Base/Arbitrum) is added as a second
 * adapter later with no change to callers.
 */

import { aaveAdapter, aaveSupportedChains } from "./aave";
import { morphoAdapter, morphoSupportedChains } from "./morpho";
import type { YieldAdapter, YieldMarket, YieldPosition } from "./types";

export type {
  YieldProtocol,
  YieldMarket,
  YieldPosition,
  YieldExecutionPlan,
  YieldAdapter,
} from "./types";

/** All installed yield adapters. Aave (BNB) + Morpho (Base/Arbitrum, ENV-gated). */
export const YIELD_ADAPTERS: YieldAdapter[] = [aaveAdapter, morphoAdapter];

/** Chains with at least one yield market (union across adapters). */
export function yieldSupportedChains(): string[] {
  return Array.from(new Set([...aaveSupportedChains(), ...morphoSupportedChains()]));
}

/** Live markets across all adapters for a chain (read, best-effort). */
export async function listAllMarkets(chain: string): Promise<YieldMarket[]> {
  const lists = await Promise.all(
    YIELD_ADAPTERS.map((a) => a.listMarkets(chain).catch(() => [] as YieldMarket[])),
  );
  return lists.flat();
}

/**
 * Strict variant of {@link listAllMarkets}: THROWS if any adapter's RPC
 * read fails, so a route can report the chain's market data as
 * unavailable rather than as a phantom 0% APY. A chain with no markets
 * still returns [] (not an error).
 */
export async function listAllMarketsStrict(chain: string): Promise<YieldMarket[]> {
  const lists = await Promise.all(YIELD_ADAPTERS.map((a) => a.listMarketsStrict(chain)));
  return lists.flat();
}

/** A wallet's positions across all adapters for a chain (read, best-effort). */
export async function listAllPositions(chain: string, walletAddress: string): Promise<YieldPosition[]> {
  const lists = await Promise.all(
    YIELD_ADAPTERS.map((a) => a.getPositions(chain, walletAddress).catch(() => [] as YieldPosition[])),
  );
  return lists.flat();
}

/**
 * Strict variant of {@link listAllPositions}: THROWS if any adapter's RPC
 * read fails, so a route can tell "couldn't read" from a genuine "no
 * position". A wallet with no balances still returns [] (not an error).
 */
export async function listAllPositionsStrict(chain: string, walletAddress: string): Promise<YieldPosition[]> {
  const lists = await Promise.all(YIELD_ADAPTERS.map((a) => a.getPositionsStrict(chain, walletAddress)));
  return lists.flat();
}
