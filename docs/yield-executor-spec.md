# Q402 Agent Wallet — Gasless Aave V3 Supply/Withdraw Extension (Spec v1.0)

> EIP-7702 impl extension that lets a Q402 Agent Wallet supply/withdraw
> stablecoins to/from Aave V3 gaslessly (relayer pays gas), mirroring the
> existing `transferWithAuthorization` witness pattern. For review before
> audit. Phase 1 of Q402 Yield (BNB Chain first).

## 1. Goal
Add two functions to `Q402PaymentImplementation` in the SAME witness style:
- `supplyToAave(owner, facilitator, pool, asset, amount, nonce, deadline, witnessSig)` — under 7702 (`msg.sender`/`address(this)` == owner EOA): `approve(pool, amount)` then `Pool.supply(asset, amount, owner, 0)`. Funds from owner, aTokens to owner, relayer pays gas.
- `withdrawFromAave(...)` — `Pool.withdraw(asset, amount, owner)`. `amount == type(uint256).max` = withdraw-all.

## 2. Must mirror existing pattern
`msg.sender == facilitator` · EIP-712 witness recovers to `owner` · `verifyingContract` = EOA (`address(this)` under 7702) · per-EOA nonce · `deadline` · relayer = gas payer.

## 3. EIP-712 domain
Identical to existing impl (`name` per-chain e.g. "Q402 BNB Chain", `version` "1", `chainId` from `block.chainid`, `verifyingContract` = `address(this)`).

## 4. New typed-data (exact field order)
```
AaveSupplyAuthorization(address owner,address facilitator,address pool,address asset,uint256 amount,uint256 nonce,uint256 deadline)
AaveWithdrawAuthorization(address owner,address facilitator,address pool,address asset,uint256 amount,uint256 nonce,uint256 deadline)
```
Distinct typehashes (supply vs withdraw) are mandatory — prevents cross-action replay (identical layout otherwise).

## 5. supplyToAave logic (in order)
1. `require(msg.sender == facilitator)`
2. `require(owner == address(this))` (self-binding under 7702)
3. `require(block.timestamp <= deadline)`
4. `require(amount != 0 && amount != type(uint256).max)` (max meaningless for supply)
5. **`require(isAllowedPool(pool))`** (+ optionally `isAllowedAsset(asset)`) — see §9.1
6. nonce: `require(!usedNonces[nonce]); usedNonces[nonce]=true;` (mark BEFORE external calls — CEI)
7. recover `AaveSupplyAuthorization` digest == owner (malleability-safe ECDSA, reject high-s / addr(0))
8. safe approve to EXACT `amount` (reset-to-zero-first, no-return-value tolerant — §7)
9. `Pool.supply(asset, amount, owner, 0)`
10. (optional) reset residual allowance to 0
11. `emit AaveSupplied(owner, pool, asset, amount, nonce)`

## 6. withdrawFromAave logic
Same checks 1-3,5-7 (withdraw typehash). `amount != 0` but `type(uint256).max` ALLOWED (withdraw-all). `withdrawn = Pool.withdraw(asset, amount, owner)`. No approval needed (burns owner's aTokens). `emit AaveWithdrawn(...)`.

## 7. Nonce space — **SHARE** existing `usedNonces`
Distinct typehashes + selectors already block cross-action replay, so separate nonce spaces buy nothing; sharing keeps the SDK simple. Reuse the exact existing mapping/slot (no parallel mapping). **Storage slot must be byte-identical (§9.6).**

## 8. Approve handling (BNB USDT)
- BNB USDT (`0x55d398…`) has NO EIP-2612 permit → approve must run on-chain inside the call (fine, relayer pays).
- **Safe approve for ALL assets:** if current allowance ≠ target and ≠ 0, reset to 0 first, then set to `amount`. Use SafeERC20-style low-level call tolerant of no-return-value tokens (or OZ `SafeERC20.forceApprove`).
- **Exact-amount approve, NO unlimited** — caps blast radius if pool allowlist ever weakened.
- Atomic approve+supply in one tx → classic approve front-run race not exploitable.

## 9. Aave V3 specifics + security
- `supply(asset, amount, onBehalfOf=owner, 0)` / `withdraw(asset, amount, to=owner)`. aTokens **rebase** (balance grows). Partial withdraw uses absolute underlying amount; "all" → `type(uint256).max`.
- **BSC USDC (`0x8AC76a…`) and USDT (`0x55d398…`) are 18 decimals** (not 6) — SDK must read `decimals()`, never hardcode.
- BNB Pool: `0x6807dc923806fE8Fd134338EABCA509979a7e0cB`.

### 9.1 Arbitrary pool/asset → **on-chain allowlist (RECOMMENDED)**
Trusting the signed `pool` blindly = a compromised/prompt-injected agent signer could sign a malicious `pool`, causing `approve(malicious, amount)` + drain. **Allowlist the canonical Aave Pool** (+ optionally asset = USDC/USDT). Model **(A) immutable constants per-impl** (chain-bound, zero governance, re-deploy+re-delegate for new Pool) is recommended over (B) owner-signed updates. **Never trust the witness `pool` unchecked.**

### 9.3 External DeFi / reentrancy
Impl now calls an upgradeable external protocol → trust boundary includes Aave governance. Put `nonReentrant` on the new Aave-facing functions (`supplyToAave` / `withdrawFromAave`) so an Aave callback can't reenter them. `transferWithAuthorization` does NOT carry (and need not carry) `nonReentrant` — it follows checks-effects-interactions, marking the per-owner nonce BEFORE the external token transfer, so any reentrant call replaying the same authorization hits `NonceAlreadyUsed` and reverts. This matches the deployed v1 impl; do not add a guard to it. CEI (nonce marked before interactions) applies uniformly across all three functions.

### 9.6 Storage layout (7702-critical)
New state must be **append-only** (never insert before existing vars) — re-delegating wallets carry forward storage; a slot shift corrupts `usedNonces`. Diff storage-layout vs prior impl version.

## 10. Same impl vs separate — **ADD TO EXISTING IMPL**
EIP-7702 allows ONE delegation target per EOA → a separate Aave impl would be mutually exclusive with payments, not additive. Ship as a new storage-append-only version; wallets **re-delegate** (already a normal Q402 upgrade op). Add `version()` getter to drive SDK re-delegation prompts. Reverted Aave call does NOT consume nonce (atomic rollback → relayer can resubmit same signed msg after conditions clear).

## 11. Events
```
event AaveSupplied(address indexed owner, address indexed pool, address indexed asset, uint256 amount, uint256 nonce);
event AaveWithdrawn(address indexed owner, address indexed pool, address indexed asset, uint256 amount, bool max, uint256 nonce);
```

## 12. Test checklist
Happy supply/withdraw/withdraw-all · wrong facilitator · bad/malleable sig · replay (same nonce) + cross-action replay · expired deadline · non-allowlisted pool · USDT reset-to-zero approve · reverted Aave call leaves nonce unconsumed · reentrancy into supply/withdraw blocked by `nonReentrant`; reentrant replay of `transferWithAuthorization` blocked by nonce-mark-before-interaction (CEI) → `NonceAlreadyUsed` · storage-layout diff vs prior impl · 18-dec USDC/USDT.

## 13. Open questions
1. Allowlist (A) immutable vs (B) signed-updates — rec (A). Confirm.
2. Asset allowlist to USDC/USDT only? Rec yes for v1.
3. Add `version()` getter for SDK re-delegation? Rec yes.
4. Reverted-call nonce consumption — spec leaves unconsumed (retry-friendly).

## Verify before audit (env had no web)
- Aave V3 BNB Pool `supply`/`withdraw` exact signatures against the live proxy `0x6807dc…e0cB` (standard V3 IPool assumed).
- BSC USDT approve zero-first behavior (defensive reset-to-zero specified regardless).

---

# ERC-4626 (Morpho on Base) variant

> Same EIP-7702 witness pattern as the Aave variant above, but the venue is a
> MetaMorpho ERC-4626 vault on Base instead of an Aave V3 Pool. Built and wired
> (off-chain sign/relay/policy, MCP tools, dashboard Earn selector); the Base
> impl contract is deployed to Base mainnet. Phase 2 of Q402 Yield (Base, USDC only).

## 4626.1 Goal
Add two functions to the Base impl (`Q402PaymentImplementationBASEv2`) in the SAME witness style:
- `supplyToErc4626(owner, facilitator, vault, asset, amount, nonce, deadline, witnessSig)`. Under 7702 (`address(this)` == owner EOA): `approve(vault, amount)` then `IERC4626(vault).deposit(amount, owner)`. Funds from owner, vault shares to owner, relayer pays gas.
- `withdrawFromErc4626(...)`. `amount == type(uint256).max` = withdraw-all, encoded as `IERC4626(vault).redeem(maxRedeem(owner), owner, owner)` (by shares). Partial withdraw uses the absolute underlying `amount`.

Positional args are identical in shape to the Aave entrypoints; the only difference is the 3rd arg is `vault` (the ERC-4626 / MetaMorpho address), not `pool`.

## 4626.2 Must mirror existing pattern
`msg.sender == facilitator` · EIP-712 witness recovers to `owner` · `verifyingContract` = EOA (`address(this)` under 7702) · per-EOA nonce (SHARED `usedNonces`, see §7) · `deadline` · relayer = gas payer · CEI (nonce marked before external calls) · `nonReentrant` on both 4626-facing functions.

## 4626.3 EIP-712 domain
`name` = "Q402 Base", `version` = "1", `chainId` from `block.chainid` (8453), `verifyingContract` = `address(this)`.

## 4626.4 New typed-data (exact field order)
```
Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)
Erc4626WithdrawAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)
```
Field order is exactly: owner, facilitator, vault, asset, amount, nonce, deadline. Distinct typehashes (supply vs withdraw) are mandatory, and they also differ from the Aave typehashes, so cross-action and cross-venue replay both revert (identical layout otherwise).

## 4626.5 supplyToErc4626 logic (in order)
1. `require(msg.sender == facilitator)`
2. `require(owner == address(this))` (self-binding under 7702)
3. `require(block.timestamp <= deadline)`
4. `require(amount != 0 && amount != type(uint256).max)` (max meaningless for supply)
5. **`require(isAllowedVault(vault))`** (+ optionally `isAllowedAsset(asset)`). See §4626.9
6. nonce: `require(!usedNonces[nonce]); usedNonces[nonce]=true;` (mark BEFORE external calls, CEI)
7. recover `Erc4626SupplyAuthorization` digest == owner (malleability-safe ECDSA, reject high-s / addr(0))
8. safe approve to EXACT `amount` (reset-to-zero-first, no-return-value tolerant, same handling as §8)
9. `IERC4626(vault).deposit(amount, owner)` (shares minted to owner)
10. (optional) reset residual allowance to 0
11. `emit Erc4626Supplied(owner, vault, asset, amount, shares, nonce)`

## 4626.6 withdrawFromErc4626 logic
Same checks 1-3, 5-7 (withdraw typehash). `amount != 0`; `type(uint256).max` ALLOWED (withdraw-all).
- Partial: convert the absolute underlying `amount` and `IERC4626(vault).withdraw(amount, owner, owner)` (shares burned from owner).
- Max (`amount == type(uint256).max`): `IERC4626(vault).redeem(IERC4626(vault).maxRedeem(owner), owner, owner)` so the full share balance is redeemed by shares (avoids dust / rounding left behind by an underlying-denominated withdraw).
No approval needed (burns owner's vault shares). `emit Erc4626Withdrawn(...)`.

## 4626.7 Nonce space (SHARE existing `usedNonces`)
Same rationale as §7: distinct typehashes + selectors already block cross-action and cross-venue replay, so a shared per-EOA nonce space keeps the SDK simple. Append-only storage (see §9.6); the Base impl is a storage-append-only version that wallets re-delegate to.

## 4626.8 Approve handling (Base USDC)
- Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals) is the only supported asset on Base (USDC-only). SDK must read `decimals()`, never hardcode.
- Exact-amount approve to the `vault`, no unlimited, reset-to-zero-first, SafeERC20-style (or OZ `SafeERC20.forceApprove`). Atomic approve+deposit in one tx so the approve front-run race is not exploitable.

## 4626.9 Vault/asset allowlist + security
- `isAllowedVault(vault)` is mandatory: never trust the witness `vault` unchecked, or a compromised/prompt-injected signer could route `approve(maliciousVault, amount)` + deposit into a drain target. Recommended model: immutable constant per-impl (chain-bound), matching §9.1 option (A).
- Canonical Base vault: Gauntlet USDC Prime MetaMorpho (`0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`), asset = USDC only.
- ERC-4626 vaults are external upgradeable-style protocols (allocators, callbacks): keep `nonReentrant` on both 4626-facing functions; CEI (nonce marked before interactions) applies as in §9.3.

## 4626.10 Events
```
event Erc4626Supplied(address indexed owner, address indexed vault, address indexed asset, uint256 assets, uint256 shares, uint256 nonce);
event Erc4626Withdrawn(address indexed owner, address indexed vault, address indexed asset, uint256 assets, bool max, uint256 nonce);
```

## 4626.11 Test checklist (delta vs §12)
Happy deposit/withdraw/withdraw-all via `redeem(maxRedeem(owner))` · wrong facilitator · bad/malleable sig · replay (same nonce) + cross-action + cross-venue (Aave vs 4626 typehash) replay · expired deadline · non-allowlisted vault · 6-dec USDC amount conversion · share-rounding on partial withdraw vs max-redeem · reverted vault call leaves nonce unconsumed · reentrancy into supply/withdraw blocked by `nonReentrant` · storage-layout diff vs prior impl.

## 4626.12 Verify before audit
- `Q402PaymentImplementationBASEv2` `supplyToErc4626` / `withdrawFromErc4626` positional shape matches the Aave entrypoints with `vault` in the 3rd slot, and `NAME() = "Q402 Base"`, `VERSION() = "1"`.
- MetaMorpho `deposit(assets, receiver)` / `redeem(shares, receiver, owner)` / `maxRedeem(owner)` signatures against the live Gauntlet USDC Prime vault `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` (standard ERC-4626 assumed).
- Contract deployed to Base mainnet at `0xd4f703683acac7C02bf482A061C9E1F8DEdA467c`.
