# Implementation refresh — Mantle / Injective / Monad / Scroll / Arbitrum

**Status: redeployed + verified + re-enabled 2026-06-15.** All five chains were
redeployed to the guarded implementation with the correct per-chain EIP-712 domain
`NAME`, verified on-chain (NAME + domainSeparator + bytecode equivalence to the
guarded build), wired through every config surface, the stale Vercel
`*_IMPLEMENTATION_CONTRACT` overrides removed, and re-enabled in
[`app/lib/chain-status.ts`](../app/lib/chain-status.ts) (`DISABLED_CHAINS` empty).
New settlements route to the guarded build on every chain.

**Pre-existing delegations are NOT auto-migrated by re-enabling.** An EOA that
delegated to an OLDER impl before the refresh stays on it until it next pays (auto
re-delegate) or is explicitly cleared; until then an actor with the EOA's own key
could call its delegated code directly (this path bypasses Q402, so chain-status
doesn't gate it). The official clear path accepts RETIRED impls (`RETIRED_IMPLS` +
`isClearableQ402Impl`) and, as a completeness fallback, any impl whose on-chain
`NAME()` is `"Q402 …"` (`isQ402ImplOnChain`), both in
[`app/lib/eip7702.ts`](../app/lib/eip7702.ts) — so an un-enumerated older generation
still clears via `q402_clear_delegation` / `scripts/undelegate-7702.mjs`.

**Migration status — complete as of 2026-06-15.** A full scan of every historical
payer EOA in KV (all owners × all wallets, ~492 EOAs) across the five chains, with
zero RPC read errors, found four owner-controlled EOAs still on retired
owner-binding-MISSING impls. All four were cleared (sponsored type-0x04, `address=0x0`)
and re-confirmed `eth_getCode == 0x`:

| chain  | EOA            | retired impl   | clear tx        |
|--------|----------------|----------------|-----------------|
| monad  | `0x7039…f7b7`  | `0x39ba95…2acc`| `0xd7ab9be0…`   |
| monad  | `0xbd35…47af`  | `0x39ba95…2acc`| `0xf799a8ba…`   |
| scroll | `0x8266…b6c2`  | `0x2fb2b2…f350`| `0x389c4511…`   |
| scroll | `0xf5cd…5c28`  | `0x2fb2b2…f350`| `0x5c6885fd…`   |

`0xf5cd…5c28` was the fourth and last; the scan confirms zero remaining
Q402-clearable delegations on any of the five chains. (Five unrelated Arbitrum
delegations the scan surfaced are non-Q402 — e.g. MetaMask's `EIP7702StatelessDelegator`
— and are out of scope for this endpoint.)

The guarded `transferWithAuthorization` enforces, in order: `msg.sender ==
facilitator`, `owner != address(0)`, `owner == address(this)`, deadline, nonce,
EIP-712 recover, low-s malleability check. The BNB / AVAX / ETH / Stable / X Layer
builds already carry this binding and were unchanged.

## Deployed addresses (2026-06-15)

Reference source: [`contracts/deployed/bnb/Q402PaymentImplementationBNB.sol`](deployed/bnb/Q402PaymentImplementationBNB.sol)
(same logic per chain, only the `NAME` constant differs). Deployed with
`scripts/deploy-fixed-impl.mjs` (solc 0.8.20, optimizer 200). The script asserts
`NAME() == domainName` and `VERSION() == "1"` on-chain and runs the owner-binding
probe before reporting success; the deployed runtime was additionally confirmed
byte-for-byte equal to the locally-compiled guarded build for each chain.

| chain     | `NAME` constant  | chainId | impl (current)                               | retired (previous deploy)                     |
|-----------|------------------|---------|----------------------------------------------|-----------------------------------------------|
| mantle    | `Q402 Mantle`    | 5000    | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699` | `0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e`  |
| injective | `Q402 Injective` | 1776    | `0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e` | `0x892E647FbbAdc8Ee8342710244931ea98529EA9C`  |
| monad     | `Q402 Monad`     | 143     | `0xc5d4dFA6D2e545409C1abf86f336Dd43bb87621f` | `0x5a8fde1851491D9eD512a9eDa1c63CA7627BECb8`  |
| scroll    | `Q402 Scroll`    | 534352  | `0x7635F32D893B64b5944CB8cbF2AC4cd3dA41B2f1` | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73`  |
| arbitrum  | `Q402 Arbitrum`  | 42161   | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699`  |

(BNB / AVAX / ETH / Stable / X Layer were already on the guarded build — unchanged.)

Note: the impl address is a CREATE address (deployer + per-chain nonce), so the
same address can recur across chains — e.g. injective's current impl equals
mantle's retired address, and arbitrum's current impl equals X Layer's live impl.
These are distinct contracts on distinct chains. Always resolve impl by (chain,
address), never by address alone.

### Retired impls — known inventory (for migration / clear)

The "retired" column above is only the immediately-previous generation. EOAs can
still be delegated to OLDER generations that are not one step back, so a migration
scan built only from that column misses them. Complete *known* retired set per
chain (this list + the table's retired column is exactly what `RETIRED_IMPLS` in
[`app/lib/eip7702.ts`](../app/lib/eip7702.ts) accepts for CLEARING — append as more
are discovered; "known", not provably exhaustive):

| chain     | retired impls (per chain)                                                        | notes |
|-----------|----------------------------------------------------------------------------------|-------|
| monad     | `0x39ba9520718eE069D7f72882FF4C28a5Ea8a2acC`, `0x5a8fde1851491D9eD512a9eDa1c63CA7627BECb8` | `0x39ba95…` is owner-binding **MISSING**; the two owner EOAs that were delegated here are cleared (see migration table above) |
| scroll    | `0x2fb2b2D110b6c5664e701666B3741240242bf350`, `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | `0x2fb2b2…` is owner-binding **MISSING**; the two owner EOAs delegated here are cleared (see above). NB: `0x2fb2b2…` is Stable's CURRENT impl on chainId 988 — resolve per (chain, address) |
| mantle    | `0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e`, `0x2fb2b2D110b6c5664e701666B3741240242bf350` | first = guarded but wrong-`NAME` prior deploy; `0x2fb2b2…` = early owner-binding-MISSING deterministic deploy (confirmed `eth_getCode` non-empty here) |
| injective | `0x892E647FbbAdc8Ee8342710244931ea98529EA9C`, `0x2fb2b2D110b6c5664e701666B3741240242bf350` | first = prior deploy; `0x2fb2b2…` = early owner-binding-MISSING deterministic deploy (confirmed on-chain) |
| arbitrum  | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699`, `0x2fb2b2D110b6c5664e701666B3741240242bf350` | first = guarded but wrong-`NAME` prior deploy; `0x2fb2b2…` = early owner-binding-MISSING deterministic deploy (confirmed on-chain) |

## Procedure used (for reference, if a chain ever needs a re-deploy)

1. **Deploy:** `DEPLOYER_PRIVATE_KEY=0x… node scripts/deploy-fixed-impl.mjs --chain <chain>`
   — replaces only the `NAME` constant declaration for that chain, runs a gas
   preflight, deploys, then asserts on-chain `NAME() == domainName` +
   `VERSION() == "1"` and runs the owner-binding eth_call probe before reporting
   success. (A flaky RPC that strips revert data can leave the probe inconclusive;
   confirm such a chain by byte-comparing its `getCode` to the locally-compiled
   guarded build.)
2. **Wire:** set the new address in `Q402_IMPL_PER_CHAIN` (eip7702.ts),
   `contracts.manifest.json`, `app/lib/relayer.ts` CHAIN_CONFIG, `public/q402-sdk.js`,
   `app/lib/agentic-wallet-sign.ts`, and `mcp-server/src/chains.ts` (republish MCP).
3. **Re-delegate:** an EOA still pointing at the previous impl keeps using it until
   its next payment (which re-delegates automatically) or until cleared with
   `PRIVATE_KEY=0x… node scripts/undelegate-7702.mjs --chain <chain>`. With no real
   users, only test wallets were affected.
4. **Re-enable:** remove the chain from `DISABLED_CHAINS` (chain-status.ts + the
   verify-contracts.mjs mirror) and update `chain-status.test.ts`.
5. **Verify:** `node scripts/verify-contracts.mjs` (owner-binding gate) + `CI=true npx vitest run`.
