# Q402 Gasless Escrow — Master Plan (single source)

> ⚠️ CURRENT STATUS (2026-07-02) — supersedes the planning text below.
> - Contracts: v6-final (H-1/M-1/M-2 all fixed), 26 tests pass. **LIVE on BNB
>   mainnet**: vault `0x56c2A0B14341bd3FEF3174714EF664D8bb6F1256`, lockImpl
>   `0x1da993Ac47bf492A72FA8e5DCBcFb5C0AFDD8a56` (BscScan + Sourcify verified,
>   real-USDT lock/release proven). External-audit package = `q402-escrow-audit`
>   tag `escrow-audit-2026-07-02-v6-final`.
> - Backend: **LIVE** (`ESCROW_ENABLED=1`) at `/api/escrow/*`. Record/marker TTL
>   covers the 14d resolve window; a lost lock-write reconciles from on-chain state.
> - H-1 CLOSED: a dispute can no longer strand funds — refund is buyer-available
>   after `releaseDeadline + RESOLVE_WINDOW` (14d), and `resolve()` closes after
>   that window so it can't front-run the timeout refund.
> - MCP escrow tools built (unpublished) + dashboard UI pending.

Status (historical): P0 contracts written + hardened after internal review.
Canonical source = `Downloads/q402-avalanche/contracts/`.

⚠️ Internal review (2026-07-01) found and we closed: LockImpl `buyer==address(this)`
binding (was a delegated-EOA theft vector), Vault `buyer==msg.sender` (now
structural — no buyer param), ERC-7201 nonce namespacing, future-deadline guard,
exact-amount-received (fee-on-transfer reject), nonReentrant, low-s. The LockImpl
now mirrors the DEPLOYED payment impl's full guard set (facilitator + InvalidOwner
+ OwnerMismatch). 18 escrow tests (15 london-EVM + 3 REAL EIP-7702 on Hardhat
Prague: happy-path lock succeeds, funds move, nonce replay blocked). Full repo
suite 26/26 (escrow files snapshot-isolate so they never leak time/delegation
into the payment tests). ERC-7201 nonce slot cross-checked against the OZ golden
value.

✅ Verified: the DEPLOYED `Q402PaymentImplementationBNB` (BscScan verified source)
HAS `msg.sender!=facilitator`, `owner==address(0)`, `owner!=address(this)` guards —
the live payment system is SAFE. The LOCAL `Downloads/q402-avalanche` copies are
STALE (pre-fix, lack all three) — do NOT redeploy from them; canonical source =
the deployed/verified contracts.

## Why (strategy)

OKX shipped **OKX.AI**, a full, open-source agent-commerce OS (`okx/onchainos-skills`:
a Rust `onchainos` CLI + agent skills): identity registry, task state machine,
**escrow on X Layer**, an **evaluator/OKB-staking arbitration economy**, and a
**unified payment dispatcher over x402 + MPP + a2a-pay**. Their `a2a-pay`
(paymentId create/pay/status) is the same shape as Q402 payment-requests; their
A2MCP pay-per-call billing is **x402**, which Q402 already speaks.

We do NOT rebuild their marketplace / arbitration / identity. The one thing OKX
structurally lacks is what we own:

> **Gasless EIP-7702 settlement across 11 chains** (OKX escrow is X Layer-centric).

So Q402 builds a **gasless, non-custodial, multichain escrow primitive** that
plugs into OKX (and any x402/MPP agent) and stands alone. Two parallel tracks:

- **Track A (presence):** register Q402 as an **A2MCP ASP** on OKX.AI (billing =
  x402, which we already support). Light, fast, gives an inside view.
- **Track B (this doc):** the gasless multichain escrow rail. Simple dispute
  (timeout + named arbiter), NOT a competing evaluator economy.

## Architecture

Escrow is **purely additive** — the deployed `Q402PaymentImplementation` is
untouched (no migration / re-audit of the live payment core). Two new contracts
per chain:

| Contract | Role |
|---|---|
| `Q402EscrowVault` | Holds funds non-custodially; state machine; release / refund / dispute / resolve. Verifies signatures against its OWN domain (verifyingContract = vault). |
| `Q402EscrowLockImpl` | EIP-7702 delegate **for a lock only**. Runs as the buyer EOA; verifies the buyer's `EscrowLock` sig; `approve(vault, amount)` + `vault.lockFrom(...)` atomically. |

### Funding (structural buyer == funder)
A lock, in ONE tx (buyer EOA delegated to `Q402EscrowLockImpl`):
```
// LockImpl, running AS the buyer EOA:
require(buyer == address(this));                       // signed buyer == executing EOA
_safeApprove(token, vault, amount);
vault.lockFrom(escrowId, seller, token, amount, releaseDeadline, arbiter);
```
- **There is NO `buyer` parameter on `lockFrom`** — the vault records `msg.sender`
  AS the buyer and debits that same account. "Funds owner == escrow buyer" is a
  structural invariant, not a check that can be forgotten or spoofed.
- **LockImpl enforces `buyer == address(this)`**: the function is callable by
  anyone on any EOA delegated here, so without this an attacker could sign
  `buyer = attacker` and run it on a *victim's* delegated EOA to approve+lock the
  victim's funds. Binding the signer to the executing EOA closes that.
- `lockFrom` reverts unless EXACTLY `amount` is received (balanceBefore/After) ->
  rejects fee-on-transfer / rebasing; `nonReentrant` guards the funding path.
- Nonces (LockImpl) live in an ERC-7201 slot, never slot 0 -> no collision with
  the payment/staking impls' slot-0 `usedNonces` under shared EOA storage.

### State machine (`Q402EscrowVault`)
```
None --lockFrom--> Open --release(buyerSig)--------> Released  (-> seller)
                    |  --refund (after deadline)----> Refunded  (-> buyer)
                    |  --dispute(buyer|seller sig)--> Disputed --resolve(arbiterSig)--> Released|Refunded
```
- **release**: buyer-signed `EscrowRelease`, gasless (relayer broadcasts). Pays seller.
- **refund**: permissionless after `releaseDeadline` (only ever pays buyer; no sig).
- **dispute**: buyer or seller signed; requires an arbiter was set; freezes auto paths.
- **resolve**: arbiter-signed `EscrowResolve(toSeller)`; only from Disputed.
- CEI: state advances to terminal BEFORE the token transfer (no re-entrancy payout).
- `_safeTransfer` / `_safeTransferFrom` / `_safeApprove` tolerate no-return tokens (USDT).

### EIP-712 types
- LockImpl domain `Q402 Escrow Lock` (verifyingContract = buyer EOA under 7702):
  `EscrowLock(address buyer,address seller,address vault,address token,uint256 amount,bytes32 salt,uint256 releaseDeadline,address arbiter,address facilitator,uint256 nonce,uint256 deadline)`
  (the witness signs `salt`; the vault derives `escrowId = keccak256(abi.encode(buyer, salt))`. `facilitator` binds the relayer, matching the payment impl.)
- Vault domain `Q402 Escrow` (verifyingContract = vault):
  `EscrowRelease(bytes32 escrowId,uint256 nonce,uint256 deadline)`
  `EscrowDispute(bytes32 escrowId,uint256 nonce,uint256 deadline)`
  `EscrowResolve(bytes32 escrowId,bool toSeller,uint256 nonce,uint256 deadline)`
- Per-signer `usedNonces` replay guard on both contracts; chainId in both domains
  (cross-chain replay safe).

## Backend (mirror payment-request patterns)
- `app/lib/escrow.ts` + routes `/api/escrow/{create,lock,release,refund,dispute,status}`.
- KV: `escrow:{id}` (record) · `escrow:owner:{owner}` (list) · `escrow:lock:{id}`
  (SET NX 120s serialize) · `escrow:settled:{id}` (durable marker BEFORE status flip,
  per the payreq ordering rule).
- id = `esc_` + 24 hex. Record = payment-request shape + `seller/releaseDeadline/arbiter/state/lockTxHash/releaseTxHash`.

## Relayer
- New `settleEscrowLock/Release/Refund/Resolve` in `app/lib/relayer.ts`, reusing the
  existing Type-4 (authorizationList) broadcast + nonce-retry. Lock sets the buyer's
  7702 delegation to `Q402EscrowLockImpl` (NOT the payment impl).
- relay route 8-step ordering (quota -> gas -> key -> decrement -> relay -> refund-on-fail) applies.
- Never touch the existing settle/payment paths.

## MCP (request-create pattern)
- New tools: `q402_escrow_create`, `q402_escrow_status`, `q402_escrow_release`,
  `q402_escrow_refund`, `q402_escrow_dispute` (consider folding fund-moving ones into
  one `q402_escrow` action tool to limit bloat). 30 -> ~35 tools, v0.9.1 -> v0.10.0.
- Fund-moving tools ride the same intent-bound consent gate as send/yield (no free-fire).
- Bump server.json + package.json + drift-guard test together.

## Interop (thin)
- Expose escrow as MPP `intent` + a2a-pay-shaped create/pay/status so OKX / x402 / MPP
  agents can drive Q402 escrow. Discovery = reuse payment-request `/pay`-style links
  (a funded `/escrow/[id]` link), NOT a marketplace.
- Optional ERC-8004 `giveFeedback` on release (positive) / dispute-loss (negative).

## Rollout (11 chains, NOT X-Layer-first)
Same bytecode all chains -> **audit once**, deploy 11 (proven `deploy-*.ts` per-chain
scripts), smoke 11, **launch together**. Add per-chain `Vault` + `LockImpl` addresses
to `contracts.manifest.json`. USDT/USDC first.

## Security
Closed in P0 hardening (internal review 2026-07-01), each with a regression test:
1. **LockImpl `buyer == address(this)`** — delegated-EOA theft vector. CLOSED.
2. **Vault `buyer == msg.sender`** — now structural (no buyer param). CLOSED.
3. **ERC-7201 nonce namespacing** (LockImpl) — no slot-0 collision. CLOSED.
4. **Future-deadline guard** (`releaseDeadline > now`). CLOSED.
5. **Exact-amount-received** (rejects fee-on-transfer/rebasing). CLOSED.
6. **nonReentrant** on funding + payouts; `_safe*` for USDT no-return; low-s +
   zero-address ecrecover guard. CLOSED.

7. **Facilitator binding** (`msg.sender == p.facilitator`) — parity with the
   deployed payment impl; the buyer's signature names the relayer. CLOSED.

External-audit notes:
- Arbiter liveness: **CLOSED (H-1)** — a Disputed escrow is no longer stuck: the
  buyer's `refund` becomes available after `releaseDeadline + RESOLVE_WINDOW`
  (14d), and `resolve()` is closed after that window so the arbiter can't
  front-run the timeout. (v2 could add reputation-weighted arbitration.)
- Backend token allowlist (USDC/USDT) + manifest drift test as defense-in-depth.
- LockImpl happy-path needs a real EIP-7702 network (testnet, P2) — the london
  EVM unit tests cover it only via the negative (BuyerMismatch/UnauthorizedFacilitator).
- ✅ RESOLVED: deployed payment impl confirmed to carry the guards (BscScan). The
  local q402-avalanche copies are stale — pin canonical source before any deploy.
- ⛔ Do not modify the deployed payment impl or relay/settle fund paths.

## Phases
- **P0** contracts + tests (foundry/hardhat) — IN PROGRESS.
- **P1** external audit (atomic-lock invariant, CEI, USDT, dispute liveness).
- **P2** testnet deploy (BNB + X Layer testnet) + e2e gasless lock -> release.
- **P3** backend (lib + routes + KV) + relayer settle paths.
- **P4** MCP tools + version bump + drift.
- **P5** mainnet 11-chain deploy + manifest + per-chain smoke.
- **P6** MPP/a2a-pay interop adapter + ERC-8004 hook.

## Files
- `Downloads/q402-avalanche/contracts/Q402EscrowVault.sol`
- `Downloads/q402-avalanche/contracts/Q402EscrowLockImpl.sol`
- (tests) `Downloads/q402-avalanche/test/Q402Escrow.test.ts`
- Hardhat: solc 0.8.20, optimizer 200, evmVersion london; 11 networks already configured.
