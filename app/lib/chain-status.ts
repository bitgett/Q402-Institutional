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
  // Held: the 2026-06-15 redeploy compiled with the wrong EIP-712 domain NAME
  // (all five returned "Q402 BNB Chain"), so settlement reverts there, and the
  // previous delegations on these chains have not been re-pointed. Held until a
  // corrected impl is deployed, verified on-chain (NAME + owner-binding), and
  // existing delegations are cleared/re-pointed.
  "mantle",
  "injective",
  "monad",
  "scroll",
  "arbitrum",
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
