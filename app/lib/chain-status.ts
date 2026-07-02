/**
 * chain-status.ts — settlement allow-list.
 *
 * all twelve chains run the guarded EIP-7702 implementation (the
 * `owner == address(this)` binding present on every build). Mantle, Injective,
 * Monad, Scroll, and Arbitrum were redeployed 2026-06-15 with the correct
 * per-chain EIP-712 domain NAME, verified on-chain (NAME() + domainSeparator()
 * match each chain's domain; runtime byte-identical to the guarded source — see
 * scripts/verify-contracts.mjs), re-wired across every surface, and the stale
 * Vercel *_IMPLEMENTATION_CONTRACT overrides were removed so production resolves
 * the new addresses from code. The allow-list is therefore empty.
 *
 * Enforced server-side at every settlement entrypoint. This gates NEW
 * settlements only — an EOA still delegated to a retired impl keeps that
 * delegation until its next payment re-delegates it to the guarded build
 * automatically. To hold a chain, add its key here.
 */

export const DISABLED_CHAINS: ReadonlySet<string> = new Set([]);

/** True when settlement/delegation on this chain is currently held. */
export function isChainDisabled(chain: string | null | undefined): boolean {
  return !!chain && DISABLED_CHAINS.has(chain.toLowerCase());
}

/** Caller-facing reason (safe to return to external clients). */
export const CHAIN_DISABLED_MESSAGE =
  "This chain is temporarily unavailable while its on-chain implementation is " +
  "being refreshed. Try again shortly, or use one of the other supported Q402 chains.";
