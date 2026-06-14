# Deployed contract source — on-chain verification

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
| Scroll | 534352 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Q402PaymentImplementationScroll.sol | full |
| Arbitrum | 42161 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Q402PaymentImplementationArbitrum.sol | full |

Re-verify any row:
`curl https://sourcify.dev/server/files/any/<chainId>/<address>`

## Not on Sourcify — explorer-verified, in-repo export pending

These chains aren't indexed by Sourcify; the impls are verified on each chain's
native explorer, but those explorers need an API key (or manual page export) to
pull the source into the repo. NOTE: the `0x2fb2…` address recurs across chains
via plain-CREATE determinism (same deployer + nonce 0) — the *address* matches
but the *source is chain-specific* (Scroll's and Arbitrum's verified sources at
that address differ, 252 vs 259 lines), so each chain below must be fetched and
re-verified separately; they do NOT inherit the Scroll/Arbitrum source.

| Chain | chainId | Impl address | Verified at | To complete |
|---|---|---|---|---|
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | OKLink / X Layer explorer | explorer API key |
| Stable | 988 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Stable explorer | explorer API key |
| Mantle | 5000 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | MantleScan | explorer API key |
| Injective | 1776 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Injective EVM explorer | explorer API key |
| Monad | 143 | `0x39Ba9520718eE069D7f72882FF4C28a5Ea8a2acC` | Monad explorer | explorer API key |
| Yield (Aave, BNB) | 56 | `0x968DfEeDA554b2aB1a43944520CE2aB1e40f84A4` | BscScan | Etherscan-V2 key (covers chainId 56) |

(The Stable/Mantle/Injective deployments reuse the `0x2fb2…` *address* but carry
their own chain-specific source — they are NOT covered by the Scroll/Arbitrum
exports above and still need a per-chain fetch.)

## Note for due diligence

In-repo source + Sourcify full-match proves the **deployed bytecode == this
source**. It does NOT substitute for a **third-party security audit** of that
source (reentrancy, economic, access-control review by an external firm) — that
remains a separate, external deliverable and is recommended as a DD condition.
