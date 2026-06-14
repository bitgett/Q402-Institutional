# Implementation refresh — Mantle / Injective / Monad / Scroll / Arbitrum

**Status: redeployed + verified 2026-06-15; re-enable gated.** All five chains
were redeployed to the guarded implementation with the correct per-chain EIP-712
domain `NAME`, verified on-chain (NAME + bytecode equivalence to the guarded
build), and wired through every config surface. They remain in `DISABLED_CHAINS`
([`app/lib/chain-status.ts`](../app/lib/chain-status.ts)) until
`scripts/verify-contracts.mjs` passes against the new addresses and old
delegations are cleared/re-pointed; re-enabled per chain thereafter.

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
