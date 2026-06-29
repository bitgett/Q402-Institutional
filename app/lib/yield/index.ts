/**
 * Q402 Yield — adapter registry + public surface.
 *
 * Routes/MCP/dashboard import from here, staying protocol-agnostic.
 * Aave shipped first; Morpho (Base/Arbitrum) and Lista (BNB ERC-4626) are
 * added as further adapters with no change to callers.
 */

import { aaveAdapter, aaveSupportedChains } from "./aave";
import { morphoAdapter, morphoSupportedChains } from "./morpho";
import { listaAdapter, listaDepositChains } from "./lista";
import type { YieldAdapter, YieldMarket, YieldPosition } from "./types";

// ALL venues are surfaced per chain (Aave + Lista on BNB, Morpho on Base) so the
// user CHOOSES where to deposit. Safe because the deposit now carries an explicit,
// consent-bound `protocol` (the chosen venue is in the owner-signed intent), so a
// market row can no longer mis-route a deposit. (Earlier we de-duped to one venue
// per chain; that's removed in favor of user choice.)

export type {
  YieldProtocol,
  YieldMarket,
  YieldPosition,
  YieldExecutionPlan,
  YieldAdapter,
} from "./types";

/** All installed yield adapters. Aave (BNB) + Morpho (Base/Arbitrum, ENV-gated)
 *  + Lista Lending (BNB ERC-4626, gated by LISTA_YIELD_ENABLED). */
export const YIELD_ADAPTERS: YieldAdapter[] = [aaveAdapter, morphoAdapter, listaAdapter];

/** Chains with at least one yield market (union across adapters; Lista counted
 *  only where its deposit flag is on, matching the de-duped market listing). */
export function yieldSupportedChains(): string[] {
  return Array.from(new Set([...aaveSupportedChains(), ...morphoSupportedChains(), ...listaDepositChains()]));
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
