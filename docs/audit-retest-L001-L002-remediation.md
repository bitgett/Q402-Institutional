# Q402 ERC-4626 Yield: L-001 / L-002 Retest Remediation

Date: 2026-07-10
Repository: github.com/bitgett/Q402-Institutional
Branch: main
Commits:
- `93e46f1713d8c3bbb3cc0d96edbf74af5f45fb63` security(L-001/L-002): enforce ERC-4626 slippage on measured balance deltas
- `cacdb7c2ab2512900cc72863cbf934e9d026dece` eip7702/test/ops: allowlist v4 slippage-measured yield codehashes

Files:
- contracts/yield/Q402PaymentImplementationBNBYieldErc4626.sol
- contracts/yield/Q402PaymentImplementationBASEv2.sol

## L-001 (Q402-CONTRACT-L-001): withdraw NatSpec vs maxRedeem

The withdraw NatSpec in both contracts previously described the `amount == max`
path as a full share-balance drain. The code uses `maxRedeem(owner)`, which is
the maximum currently redeemable, and vault caps, queues or pauses can leave that
below the owner's full share balance.

Fix: both NatSpec blocks now state the max path redeems the MAXIMUM CURRENTLY
REDEEMABLE shares (`maxRedeem`), that caps/queues/pauses can leave this below the
owner's full balance, and that shares may remain outstanding after the call. It is
documented as not a guaranteed full exit.

## L-002 (Q402-CONTRACT-L-002): slippage bound on returned values

Slippage was enforced against the values RETURNED by `deposit` / `withdraw` /
`redeem`, and the BASE fixed-withdraw path hardcoded `assetsOut = amount`. A
non-conforming or upgraded allowlisted vault could return values that satisfy the
bounds while transferring or minting fewer real assets or shares.

Fix: every path now measures balance DELTAS around the single vault call and
enforces the signed bounds on the observed result, never on the vault's return
value.

- Supply: `shares = balanceOf(vault, owner)_after - _before`, then
  `if (shares < minSharesOut) revert SlippageExceeded()`.
- Withdraw (both max and fixed): capture `assetBefore` / `shareBefore`, perform the
  single `redeem` / `withdraw` call, then
  `sharesBurned = shareBefore - balanceOf(vault, owner)` with
  `if (sharesBurned > maxSharesBurned) revert`, and
  `assetsOut = balanceOf(asset, owner) - assetBefore` with
  `if (assetsOut < minAssetsOut) revert`. The former `assetsOut = amount` hardcode
  is removed. Emitted `assetsOut` / `shares` are the measured deltas.

The function is `nonReentrant` and makes a single external vault call between the
before/after reads, so the deltas are exact. For a conforming vault the measured
delta equals the return value, so behaviour is unchanged for the live vaults
(Lista, Gauntlet, Morpho). A non-conforming or upgraded vault that delivers fewer
assets or mints fewer shares now reverts the whole transaction, including its own
token pull.

## Additional hardening (found during our own re-audit)

Ported the `IERC4626(vault).asset() != asset` (AssetVaultMismatch) guard into BASE
`withdrawFromErc4626`, matching BNB withdraw and BASE supply. Redundant today
(Base allows a single vault), it prevents asset/vault mislabeling once the Base
allowlist grows beyond one vault.

## Invariants preserved

- EIP-712 typehashes and struct field ordering are unchanged, so signer and relay
  stay compatible.
  - supply typehash `0xbbafd0590b4b6cddf57619b6fbbe63e65409b7910c935313549f60c1a1a7d85e`
  - withdraw typehash `0x50b44ecd273e77cd48eb1c6446b01c4414d0df89be455144568e723d9d213f19`
- `IMPL_VERSION` bumped to the v4 slippage-measured tags.

## Deployment (mainnet, verified)

| Chain | Impl | IMPL_VERSION | codehash | Explorer |
|-------|------|--------------|----------|----------|
| BNB (56) | `0x8cE4826097c5b9186662e48980da72c4191Dfa2e` | 4-yield-bnb-erc4626-lista-slippage-measured | `0xec96433924eff1de183f8671bb663ebe9d5e817cca3d0de8a41238de12046f61` | bscscan.com/address/0x8cE4826097c5b9186662e48980da72c4191Dfa2e#code |
| Base (8453) | `0x85C68EbB1F2846Fa59366d453CfAe41a18926F54` | 4-yield-base-erc4626-slippage-measured | `0x4385bad7312ce5dfa7ff38e099d5bc0b4d3aeaaa7036ce0ad33de423438e9dc3` | basescan.org/address/0x85C68EbB1F2846Fa59366d453CfAe41a18926F54#code |

Both codehashes are added to the `Q402_IMPL_CODEHASHES` clear-delegation allowlist
(v3 codehashes retained for wallets delegated during the v3 window). Backend impl
pointers (`YIELD_IMPL_BNB_LISTA`, `YIELD_IMPL_BASE`) now point to the v4 addresses.
