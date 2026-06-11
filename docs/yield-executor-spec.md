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
