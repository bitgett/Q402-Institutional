# Deployed contract source — on-chain verification

> **Refreshed for 5 chains (2026-06-15):** Mantle, Injective, Monad, Scroll, and
> Arbitrum were redeployed to the guarded implementation with the correct per-chain
> EIP-712 domain `NAME`. Their current addresses are in
> [`contracts/IMPL_REFRESH_RUNBOOK.md`](../IMPL_REFRESH_RUNBOOK.md); each new impl is
> confirmed byte-for-byte equal to the locally-compiled guarded build and is pending
> re-verification on Sourcify / the native explorer. BNB / AVAX / ETH / Stable /
> X Layer are unchanged and covered below.

The Solidity source under `contracts/deployed/<chain>/` is the **exact source the
deployed bytecode was compiled from**, fetched from Sourcify (decentralized
source verification). `status: full` = a *full* bytecode match (the deployed
runtime bytecode, including metadata hash, matches this source — not just a
partial/metadata-stripped match). Each chain folder also carries the
`metadata.json` (compiler version, settings, ABI) Sourcify holds.

This closes the "verified deployed source not in-repo" gap: a reviewer can diff
these files against the addresses below on any explorer, and re-derive the
match independently from Sourcify.

## Sourcify full-match (in repo)

| Chain | chainId | Impl address | Source | Sourcify |
|---|---|---|---|---|
| Avalanche | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | Q402PaymentImplementation.sol | full |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | Q402PaymentImplementationBNB.sol | full |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | Q402PaymentImplementationETH.sol | full |

(Scroll and Arbitrum were redeployed 2026-06-15 — see the refresh runbook for their
current addresses; Sourcify re-verification is pending.)

Re-verify any row:
`curl https://sourcify.dev/server/files/any/<chainId>/<address>`

## Not on Sourcify — explorer-verified, in-repo export pending

These chains aren't indexed by Sourcify; the impls are verified on each chain's
native explorer, but those explorers need an API key (or manual page export) to
pull the source into the repo.

| Chain | chainId | Impl address | Verified at | To complete |
|---|---|---|---|---|
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | OKLink / X Layer explorer | explorer API key |
| Stable | 988 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Stable explorer | explorer API key |
| Yield (Aave, BNB) | 56 | `0x968DfEeDA554b2aB1a43944520CE2aB1e40f84A4` | BscScan | Etherscan-V2 key (covers chainId 56) |

(Mantle / Injective / Monad were redeployed 2026-06-15 — see the refresh runbook
for their current addresses; explorer re-verification is pending. Each impl address
is a CREATE address per (chain, nonce), so the same address can recur across chains
as distinct contracts — resolve by (chain, address), never by address alone.)

## Note for due diligence

In-repo source + Sourcify full-match proves the **deployed bytecode == this
source**. It does NOT substitute for a **third-party security audit** of that
source (reentrancy, economic, access-control review by an external firm) — that
remains a separate, external deliverable and is recommended as a DD condition.
