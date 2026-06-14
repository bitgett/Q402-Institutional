/**
 * chain-status.ts — settlement allow-list.
 *
 * The EIP-7702 implementation currently deployed on Mantle, Injective, Monad,
 * Scroll, and Arbitrum is missing the owner-binding check
 * (`owner == address(this)`) that the BNB / AVAX / ETH / Stable builds carry,
 * so Q402 holds settlement on those chains until a refreshed implementation is
 * deployed and users are re-delegated. The guarded chains stay active.
 *
 * Enforced server-side at every settlement entrypoint. This gates NEW
 * settlements only — an EOA already delegated to the old implementation is
 * unaffected by a backend change and needs its delegation refreshed.
 */

export const DISABLED_CHAINS: ReadonlySet<string> = new Set([
  // monad / scroll / arbitrum now run the guarded implementation (redeployed
  // 2026-06-15) and are active again. Still held: mantle (pending a deploy-gas
  // top-up) and injective (pending deploy-gas funding).
  "mantle",
  "injective",
]);

/** True when settlement/delegation on this chain is currently held. */
export function isChainDisabled(chain: string | null | undefined): boolean {
  return !!chain && DISABLED_CHAINS.has(chain.toLowerCase());
}

/** Caller-facing reason (safe to return to external clients). */
export const CHAIN_DISABLED_MESSAGE =
  "This chain is temporarily unavailable while its on-chain implementation is " +
  "being refreshed. Supported chains right now: BNB Chain, Avalanche, Ethereum, " +
  "Stable, X Layer.";
