# Implementation refresh — Mantle / Injective / Monad / Scroll / Arbitrum

These five chains are currently held in [`app/lib/chain-status.ts`](../app/lib/chain-status.ts):
their deployed EIP-7702 implementation does not enforce the owner-binding check
(`owner == address(this)`) + facilitator check that the BNB / AVAX / ETH / Stable
builds carry. This runbook refreshes them to the guarded implementation and
re-enables them.

Everything except the on-chain deploy + re-delegation is already in place
(kill-switch, owner-binding gate in `scripts/verify-contracts.mjs`). The deploy
and the type-4 transactions require the deployer / wallet keys, so those steps
are yours.

## Reference (guarded) source

[`contracts/deployed/bnb/Q402PaymentImplementationBNB.sol`](deployed/bnb/Q402PaymentImplementationBNB.sol)
is the canonical guarded implementation. Its `transferWithAuthorization` does, in
order: `msg.sender == facilitator`, `owner != address(0)`, `owner == address(this)`,
deadline, nonce, EIP-712 recover, low-s malleability check. Deploy this exact
logic to each chain below, changing **only** the `NAME` constant.

| chain     | `NAME` constant | chainId | current (unsafe) impl |
|-----------|-----------------|---------|------------------------|
| mantle    | `Q402 Mantle`    | 5000    | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| injective | `Q402 Injective` | 1776    | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| monad     | `Q402 Monad`     | 143     | `0x39Ba9520718eE069D7f72882FF4C28a5Ea8a2acC` |
| scroll    | `Q402 Scroll`    | 534352  | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| arbitrum  | `Q402 Arbitrum`  | 42161   | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |

(BNB/AVAX/ETH/Stable already carry the guards — leave them.)

## Steps (per chain)

1. **Deploy** the guarded impl (solc 0.8.20, optimizer 200 — match the existing
   metadata) with `NAME` set per the table. Record the new address.
2. **Prove behaviour BEFORE wiring it in.** Point the manifest entry at the new
   address and run the gate:
   ```bash
   node scripts/verify-contracts.mjs
   ```
   It eth_calls `transferWithAuthorization` with a non-owner + garbage signature
   and requires an `OwnerMismatch()` revert. A new impl that still reaches
   `InvalidSignature()` (or an inconclusive probe on a non-held chain) fails the
   gate — do not proceed until it passes.
3. **Wire it in:** update `Q402_IMPL_PER_CHAIN` in
   [`app/lib/eip7702.ts`](../app/lib/eip7702.ts) and `implContract` in
   [`contracts.manifest.json`](../contracts.manifest.json) to the new address.
4. **Re-delegate** any EOA currently delegated to the old impl. With no real
   users this is only the test wallets — clear each with the existing script
   (sponsored on BNB, Gas-Tank-charged elsewhere):
   ```bash
   PRIVATE_KEY=0x<key> node scripts/undelegate-7702.mjs --chain <chain>
   ```
   The next payment re-delegates to the new (guarded) impl automatically.
5. **Re-enable:** remove the chain from `DISABLED_CHAINS` in
   [`app/lib/chain-status.ts`](../app/lib/chain-status.ts) and from the
   `DISABLED_CHAINS` mirror in `scripts/verify-contracts.mjs`. Run the full
   suite (`CI=true npx vitest run`) — `chain-status.test.ts` pins the held set,
   so update it in the same change.

## Why a backend change alone wasn't enough

The hold stops Q402 from delegating or settling anyone NEW on these chains. It
does not protect an EOA already delegated to the old impl — anyone can call that
EOA directly, bypassing Q402. The only fix for an already-delegated EOA is to
re-delegate it (step 4). With zero real users today the exposure is the test
wallets only, but the deploy + re-delegate is still the real close-out.
