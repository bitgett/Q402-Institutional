/**
 * chain-status.ts — settlement allow-list.
 *
 * All chains run the guarded EIP-7702 implementation (the `owner == address(this)`
 * binding). Mantle, Injective, Monad, Scroll, and Arbitrum were redeployed
 * 2026-06-15 with the correct per-chain EIP-712 domain NAME, verified on-chain
 * (NAME() + domainSeparator() match each chain's domain; runtime byte-identical to
 * the guarded source — see scripts/verify-contracts.mjs).
 *
 * robinhood was briefly held 2026-07-10: its original impl 0x2fb2…f350 was an
 * UNGUARDED build (no owner==address(this) binding, M-01 class, confirmed on-chain).
 * Resolved same day — the guarded impl 0xa9a7dce7… was deployed, verified (probe
 * returns OwnerMismatch), and re-wired across manifest/relay/codehash, and the only
 * delegated account (a Q402 test wallet, 0.04 USDG) was cleared. Hold lifted.
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
