/**
 * Q402 Yield — adapter registry + public surface.
 *
 * Routes/MCP/dashboard import from here, staying protocol-agnostic.
 * Aave ships in Phase 0; Morpho (Base/Arbitrum) is added as a second
 * adapter later with no change to callers.
 */

import { aaveAdapter, aaveSupportedChains } from "./aave";
import type { YieldAdapter, YieldMarket, YieldPosition } from "./types";

export type {
  YieldProtocol,
  YieldMarket,
  YieldPosition,
  YieldExecutionPlan,
  YieldAdapter,
} from "./types";

/** All installed yield adapters. Append Morpho here when it lands. */
export const YIELD_ADAPTERS: YieldAdapter[] = [aaveAdapter];

/** Chains with at least one yield market (union across adapters). */
export function yieldSupportedChains(): string[] {
  return Array.from(new Set([...aaveSupportedChains()]));
}

/** Live markets across all adapters for a chain (read). */
export async function listAllMarkets(chain: string): Promise<YieldMarket[]> {
  const lists = await Promise.all(
    YIELD_ADAPTERS.map((a) => a.listMarkets(chain).catch(() => [] as YieldMarket[])),
  );
  return lists.flat();
}

/** A wallet's positions across all adapters for a chain (read). */
export async function listAllPositions(chain: string, walletAddress: string): Promise<YieldPosition[]> {
  const lists = await Promise.all(
    YIELD_ADAPTERS.map((a) => a.getPositions(chain, walletAddress).catch(() => [] as YieldPosition[])),
  );
  return lists.flat();
}
