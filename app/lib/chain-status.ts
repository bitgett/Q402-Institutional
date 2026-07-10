/**
 * chain-status.ts — settlement allow-list.
 *
 * Every chain EXCEPT robinhood runs the guarded EIP-7702 implementation (the
 * `owner == address(this)` binding). Mantle, Injective, Monad, Scroll, and
 * Arbitrum were redeployed 2026-06-15 with the correct per-chain EIP-712 domain
 * NAME, verified on-chain (NAME() + domainSeparator() match each chain's domain;
 * runtime byte-identical to the guarded source — see scripts/verify-contracts.mjs).
 *
 * HELD: robinhood (2026-07-10). The live Robinhood impl 0x2fb2…f350 is byte-for-byte
 * an UNGUARDED build — it has no `owner == address(this)` binding and no
 * facilitator check on transferWithAuthorization, so any caller could drain a
 * delegated account (M-01 class, confirmed on-chain). Held until the guarded
 * Robinhood impl is redeployed, re-wired, and existing delegations are cleared /
 * re-delegated. Do NOT remove from this set before verify-contracts passes robinhood.
 *
 * Enforced server-side at every settlement entrypoint. This gates NEW
 * settlements only — an EOA still delegated to a retired impl keeps that
 * delegation until its next payment re-delegates it to the guarded build
 * automatically. To hold a chain, add its key here.
 */

export const DISABLED_CHAINS: ReadonlySet<string> = new Set(["robinhood"]);

/** True when settlement/delegation on this chain is currently held. */
export function isChainDisabled(chain: string | null | undefined): boolean {
  return !!chain && DISABLED_CHAINS.has(chain.toLowerCase());
}

/** Caller-facing reason (safe to return to external clients). */
export const CHAIN_DISABLED_MESSAGE =
  "This chain is temporarily unavailable while its on-chain implementation is " +
  "being refreshed. Try again shortly, or use one of the other supported Q402 chains.";
