# Dependency security notes

Tracked transitive advisories that surface in `npm audit` and why they are accepted.

## elliptic / ethers v5 (via @redstone-finance/sdk)

`npm audit` reports `elliptic` (GHSA-848j-6mx2-7j84, ECDSA/EDDSA signature-malleability) through the `@ethersproject/signing-key` (ethers v5) chain.

- **Resolved elliptic is `6.6.1`** (the latest, patched line). The advisory has no further fixed release to move to; the flag is carried by the `@ethersproject/*` metadata, not a genuinely-vulnerable installed version.
- The **only** thing pulling ethers v5 is `@redstone-finance/sdk` (the RedStone price/NAV feed reader used by the RedStone trigger watcher). We use it **read-only** to read on-chain oracle prices. It never signs or moves user funds; user settlement uses ethers **v6** + the EIP-7702 / EIP-712 paths in `app/lib`.
- Blast radius of the elliptic malleability issue (verifying third-party signatures) is therefore not reachable from any fund-moving code path.

**Action:** accepted + tracked. Revisit if RedStone ships an ethers-v6 SDK (would drop the whole v5 chain) or if the advisory gains an exploitable path in a read-only context.
