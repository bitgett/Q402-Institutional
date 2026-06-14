/**
 * chain-status.ts — settlement allow-list.
 *
 * The guarded implementation for Mantle, Injective, Monad, Scroll, and Arbitrum
 * was redeployed 2026-06-15 with the correct per-chain EIP-712 domain NAME and
 * verified on-chain (NAME + owner-binding via bytecode equivalence to the guarded
 * source — see scripts/verify-contracts.mjs). The new addresses are wired into
 * this repo, BUT these five stay held until BOTH are true in production:
 *   1. the production env (Vercel *_IMPLEMENTATION_CONTRACT) points at the new
 *      addresses — a stale override would route settlement to a retired impl;
 *   2. the EOAs still delegated to a retired impl have been cleared/re-pointed.
 * Re-enable per chain only after `node scripts/verify-contracts.mjs` passes
 * against the production-resolved addresses for that chain.
 *
 * Enforced server-side at every settlement entrypoint. This gates NEW
 * settlements only — an EOA already delegated to a retired impl is unaffected by
 * a backend change and must have its delegation cleared/refreshed.
 */

export const DISABLED_CHAINS: ReadonlySet<string> = new Set([
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
  "being refreshed. Try again shortly, or use one of the other supported Q402 chains.";
