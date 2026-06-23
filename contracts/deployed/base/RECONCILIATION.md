# Base yield impl (Q402PaymentImplementationBASEv2) — pre-deploy reconciliation

Purpose: before deploying the Base ERC-4626 yield impl, prove its preserved
transfer path + EIP-712 domain + storage layout are compatible with the
already-deployed Base **payment** impl, so a wallet that re-delegates between
the two (EIP-7702 set-code) never corrupts its own EOA storage or replays a
nonce. The EOA's storage is shared across whichever impl is delegated; only the
code changes per type-4 tx.

## Subjects
- Deployed Base **payment** impl: `0x2fb2B2D110b6c5664e701666B3741240242bf350`
  (per `contracts.manifest.json` -> chains.base.implContract). Same CREATE
  address as the Stable impl: CREATE addresses depend on (deployer, nonce) only,
  not bytecode, so the same deployer+nonce yields the same address on both
  chains while each carries its own per-chain bytecode (domain NAME differs).
- New Base **yield** impl: `contracts/yield/Q402PaymentImplementationBASEv2.sol`
  (this branch, not yet deployed).

## Method
BaseScan's V1 `getsourcecode` endpoint is deprecated (V2 requires an API key,
which is not present in this repo). The deployed payment impl is, however, the
canonical per-chain transfer impl, which is byte-identical across chains except
for the domain NAME string. The local verified sources
`contracts/deployed/{bnb,eth,avax,arbitrum,scroll}/*.sol` are therefore the
authoritative structural reference. Reconciliation below is against the deployed
BNB source (`contracts/deployed/bnb/Q402PaymentImplementationBNB.sol`); the Base
variant is identical except `NAME = "Q402 Base"`.

## Findings (all PASS)

1. **Storage layout — no collision.** The deployed transfer impl declares
   exactly ONE state variable: `mapping(address => mapping(uint256 => bool))
   usedNonces` at **slot 0**. Its TYPEHASHes, NAME and VERSION are `constant`
   (compile-time, occupy no storage), so **slot 1+ is unused**. BASEv2 keeps
   `usedNonces` as the FIRST state var (slot 0, byte-identical mapping type) and
   APPENDS `uint256 _reentrancyStatus` at slot 1. Re-delegating payment<->yield
   reads/writes the same `usedNonces` mapping; slot 1 was 0 in the payment impl,
   so the reentrancy guard starts clean. No insert-before, no overlap.

2. **TransferAuthorization typehash — byte-identical.**
   `TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)`
   matches in both (the deployed source builds it from concatenated string
   literals; BASEv2 inlines the same final string). A nonce consumed by a
   payment is therefore "used" for yield too, and vice versa — strictly safer,
   never replayable.

3. **EIP-712 domain — matches.** `DOMAIN_TYPEHASH` is identical; BASEv2
   `NAME = "Q402 Base"`, `VERSION = "1"`; `_domainSeparator()` =
   `keccak256(DOMAIN_TYPEHASH, keccak(NAME), keccak(VERSION), block.chainid, address(this))`.
   This equals the off-chain signer's domain in `app/lib/yield/sign.ts`
   (`AGENTIC_CHAINS.base.domainName = "Q402 Base"`, version "1", chainId 8453,
   verifyingContract = the EOA == address(this) under 7702).

4. **ERC-4626 witness typehashes — byte-identical off-chain and on-chain.**
   `Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)`
   and the matching `Erc4626WithdrawAuthorization(...)` are identical between the
   contract and `sign.ts`'s `ERC4626_SUPPLY_AUTH_TYPES` / `ERC4626_WITHDRAW_AUTH_TYPES`.
   Pinned forever by `__tests__/yield-base-vault-drift.test.ts`.

5. **Vault + asset allowlist — matches off-chain config.**
   `BASE_USDC_VAULT = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` equals the
   off-chain `MORPHO_DEFAULT_VAULT.base` in `morpho.ts`; `USDC =
   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` equals the manifest's native Base
   USDC (NOT the bridged USDbC). Pinned by the same drift test.

## Still required AT deploy time (not code; gates go-live)
- Obtain a BaseScan / Etherscan V2 API key; fetch the verified source at
  `0x2fb2...f350` and confirm it byte-matches the canonical transfer impl with
  `NAME = "Q402 Base"` (final on-chain confirmation of finding 1-3).
- `forge inspect Q402PaymentImplementationBASEv2 storage-layout` and diff slot 0
  == `usedNonces` against the deployed impl's layout.
- Verify the curated vault `0xeE8F...4b61` on the live Base proxy: ERC-4626
  interface present, `asset() == USDC`, sane TVL.
- Compile + deploy via `scripts/deploy-yield-impl.mjs --chain base` (solc 0.8.20,
  optimizer 200, evmVersion london, viaIR=true). viaIR is REQUIRED for the
  ERC-4626 functions (stack depth) and changes codegen only, not storage layout
  or the EIP-712 typehashes. Use these EXACT settings when verifying the source
  on BaseScan. (`--compile-only` confirmed a clean 4,986-byte build.)
- Fund the relayer/facilitator `0xfc77FF29178B7286A8bA703D7a70895CA74fF466` with
  Base ETH (it sponsors yield gas; without it every Base yield op fails at
  broadcast).

## Conclusion
Storage / domain / transfer-typehash / ERC-4626-typehash / allowlist
reconciliation PASSES against the canonical sources. EOA storage is safe across
payment<->yield re-delegation. The remaining items above are deploy-time
on-chain confirmations and ops funding, not code changes.
