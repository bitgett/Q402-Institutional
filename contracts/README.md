# Q402 sender contracts

Reference copies of the on-chain sender contracts Q402 deploys. They are checked in here so the public repo carries the exact source behind the live addresses. This directory is source-only; the canonical build + full test suite live in the Hardhat project (not committed to this app repo).

Source is kept **verbatim as deployed** (comments included). solc is compiled with the default metadata hash, so the source bytes are part of the deployed bytecode's metadata; recompiling this exact source with the settings below reproduces the deployed metadata for block-explorer verification.

## Contracts

- `oft/Q402OftSender.sol` - pooled LayerZero OFT (USDT0) sender. Native fee pool, `bridgeFor(owner, ...)` is `onlyFacilitator`, recipient is force-bound to the owner. Return-data-tolerant token calls (Ethereum/Arbitrum USDT return no data).
- `ccip/Q402CCIPSender.sol` - pooled Chainlink CCIP (USDC) sender. Same facilitator-gated + recipient-bound model. Imports `@chainlink/contracts-ccip`.
- `oft/MockNoReturnAdapter.sol`, `oft/MockOftToken.sol` - test doubles (no-return USDT + native/adapter OFT) used by the OFT sender test.

## Build / reproduce

The senders are Solidity `^0.8.20`. To compile + run the tests, use a Hardhat (or Foundry) project with:

- solc **0.8.20**, `evmVersion: "london"`, optimizer on
- dependency **`@chainlink/contracts-ccip` `^1.6.4`** (only `Q402CCIPSender.sol` needs it)
- `@nomicfoundation/hardhat-toolbox` + `ethers` v6 for the test harness

```
mkdir q402-contracts && cd q402-contracts
npm init -y
npm i -D hardhat @nomicfoundation/hardhat-toolbox @chainlink/contracts-ccip@^1.6.4
# hardhat.config: solidity { version: "0.8.20", settings: { optimizer: { enabled: true }, evmVersion: "london" } }
# copy contracts/ + test/ then:
npx hardhat compile && npx hardhat test
```

The OFT sender test (`oft-sender.test.ts`) covers `onlyFacilitator`, owner-bound recipient, `FeeExceedsMax`, `InsufficientNativePool`, `ZeroOwner`, and the no-return USDT adapter path (the regression guard for the Ethereum-USDT `transferFrom` fix).

## Deployed (all facilitator = relayer `0xfc77FF29178B7286A8bA703D7a70895CA74fF466`)

Live addresses are the source of truth in [`../contracts.manifest.json`](../contracts.manifest.json) (`.oft` and `.ccip`). Verify the deployed runtime bytecode against a local build (accounting for immutables + metadata) or via the block explorer's source verification.

**OFT senders** (return-data-tolerant, redeployed 2026-07): eth `0x7b850d2B5026fd7b79B4bc25BC756B2a970C2C33`, arbitrum `0xc5d4dFA6D2e545409C1abf86f336Dd43bb87621f`, mantle `0x863217d0895fe98081Cc71e61D32820EF60147d3`, monad `0xBef6F89C3c2f83a42f60dC60adCae79c2D74fe00`, xlayer `0xac8DdC4A4E214c804837442169f93a6ce7780C92`.

**CCIP senders** (facilitator-gated + recipient-bound): eth `0xcD469DAA4A793a7a515B3A7F304068226F27a2d0`, avax + arbitrum `0xCC6079A44953aB07Fce1e624532254CB398C88b6`.
