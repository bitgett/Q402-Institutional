# Implementation refresh — Mantle / Injective / Monad / Scroll / Arbitrum

**Status: completed 2026-06-15.** All five chains were redeployed to the guarded
implementation, wired through every config surface, and re-enabled.
`DISABLED_CHAINS` in [`app/lib/chain-status.ts`](../app/lib/chain-status.ts) is
now empty — all 10 chains run the guarded build.

The guarded `transferWithAuthorization` enforces, in order: `msg.sender ==
facilitator`, `owner != address(0)`, `owner == address(this)`, deadline, nonce,
EIP-712 recover, low-s malleability check. The earlier builds on these five
chains were missing the `owner == address(this)` binding; the BNB / AVAX / ETH /
Stable / X Layer builds already carried it.

## Deployed addresses (2026-06-15)

Reference source: [`contracts/deployed/bnb/Q402PaymentImplementationBNB.sol`](deployed/bnb/Q402PaymentImplementationBNB.sol)
(same logic per chain, only the `NAME` constant differs). Deployed with
`scripts/deploy-fixed-impl.mjs` (solc 0.8.20, optimizer 200), owner-binding
confirmed on-chain at deploy.

| chain     | `NAME` constant  | chainId | impl (current)                               | replaced (retired)                            |
|-----------|------------------|---------|----------------------------------------------|-----------------------------------------------|
| mantle    | `Q402 Mantle`    | 5000    | `0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e` | `0x2fb2B2D110b6c5664e701666B3741240242bf350`  |
| injective | `Q402 Injective` | 1776    | `0x892E647FbbAdc8Ee8342710244931ea98529EA9C` | `0x2fb2B2D110b6c5664e701666B3741240242bf350`  |
| monad     | `Q402 Monad`     | 143     | `0x5a8fde1851491D9eD512a9eDa1c63CA7627BECb8` | `0x39Ba9520718eE069D7f72882FF4C28a5Ea8a2acC`  |
| scroll    | `Q402 Scroll`    | 534352  | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | `0x2fb2B2D110b6c5664e701666B3741240242bf350`  |
| arbitrum  | `Q402 Arbitrum`  | 42161   | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699` | `0x2fb2B2D110b6c5664e701666B3741240242bf350`  |

(BNB / AVAX / ETH / Stable / X Layer were already on the guarded build — unchanged.)

## Procedure used (for reference, if a chain ever needs a re-deploy)

1. **Deploy:** `DEPLOYER_PRIVATE_KEY=0x… node scripts/deploy-fixed-impl.mjs --chain <chain>`
   — compiles the reference source with that chain's `NAME`, deploys, and runs
   the owner-binding eth_call probe on the new address before reporting success.
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
