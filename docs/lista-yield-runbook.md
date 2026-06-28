# Q402 Yield x Lista Lending (BNB) — go-live runbook

BNB yield venue = **Lista Lending** (Moolah curated ERC-4626 vaults). Launch routes
USDT into the **Gauntlet USDT Vault** `0x6d6783C146F2B0B2774C1725297f1845dc502525`
(verified on-chain: ERC-4626, asset() == BSC USDT, ~$8M TVL) and USDC into the
**Lista USDC Vault** `0x8a06Ac91265dBEBE6D4606f45b10993E9a571869` (verified on-chain:
ERC-4626, asset() == BSC USDC, ~$330K TVL). Both stables are wired end to end (curated
default vault + immutable impl allowlist + drift test). The whole path is built and gated
by `LISTA_YIELD_ENABLED` (default off → BNB stays on the Aave path, zero behavior change).

## Go-live sequence (do in order — fail-closed until step 4)

1. **External audit** of `contracts/yield/Q402PaymentImplementationBNBYieldErc4626.sol`
   (new mainnet fund-moving impl; the vault path adds external-DeFi + approve surface).
   Pre-audit internal review found no HIGH issues; it is a faithful port of the audited
   `BASEv2`, differing only in the four chain constants + the Lista allowlist.
2. **Deploy** the impl:
   `DEPLOYER_PRIVATE_KEY=0x… node scripts/deploy-yield-impl.mjs --chain bnb`
   (compiles with the pinned solc 0.8.20/200/london/viaIR, deploys, and PROVES
   owner-binding + NAME "Q402 BNB Chain" + the full allowlist (Gauntlet USDT + Lista USDC
   vaults & assets, a random address denied) on the fresh address before printing it).
   `--compile-only` first to dry-verify the build.
3. **Wire** the env: set `YIELD_IMPL_BNB=<deployed address>` in Vercel (prod). Fund the
   relayer with BNB gas.
4. **Pre-flip guard:** `node scripts/verify-lista-wiring.mjs` — asserts the wired
   `YIELD_IMPL_BNB` IS the Lista ERC-4626 impl (IMPL_VERSION + allowlist) so we can't
   flip the flag against the Aave impl (would revert deposits after paying gas — spec
   MED-2). Only when it prints OK:
5. **Flip:** set `LISTA_YIELD_ENABLED=true`. Re-run `vitest run yield-bnb-lista-vault-drift`,
   then a small smoke deposit + withdraw for BOTH USDT and USDC.

Rollback is NOT a clean flag-unset once funds are in Lista. **`LISTA_YIELD_ENABLED`
currently gates the Lista READ adapter and the write-target resolution too** (`listaEnabled()`
in `lista.ts`), so unsetting it makes Lista positions invisible to `listAllPositions`,
un-withdrawable via the normal path (`listaVaultFor` returns null → withdraw can't target
the vault), and uncounted by the GC sweep. Unsetting the flag is safe ONLY while no wallet
holds a Lista position. **Do not treat flag-unset as a kill switch for funds already
supplied.** The P1 fixes below decouple read+withdraw from the deposit flag so Lista funds
stay recoverable regardless; until those land, roll back by migrating/withdrawing Lista
positions FIRST, then unset.

## P1 BLOCKERS — must close before the flip (external audit, confirmed in code)

The flag flips BNB's yield protocol from Aave to Lista GLOBALLY (`yieldProtocolForChain`
returns "lista" for BNB when enabled, `sign.ts`). Protocol identity is derived from
(chain + flag), NOT per-position, which breaks any wallet that already has an Aave BNB
position and makes Lista funds flag-dependent:

1. **Withdraw routes to the wrong venue.** `listAllPositions` reads ALL adapters
   (`index.ts`), so an existing Aave BNB position still shows in the UI and passes the
   withdraw preflight (`execute.ts` asset match), but `signYieldAction` signs for Lista
   (flag-derived) → on-chain revert, relayer gas burned. FIX: withdraw must sign for the
   POSITION's protocol+marketAddress (both already on `YieldPosition`), not the flag.
2. **Rollback orphans Lista funds** (see the rollback paragraph above). FIX: ungate Lista
   read + withdraw from `LISTA_YIELD_ENABLED`; the flag should gate only NEW deposits.
3. **maxAllocationPct undercounts.** `policy.ts` sums only the flag-selected protocol's
   position, so an existing Aave BNB position is excluded from the cap and a wallet can
   over-allocate into Lista beyond its yield cap. FIX: sum ALL protocols for the chain.
4. **(P2) Consent does not bind the venue.** The yield action intent/auth carries no
   protocol/marketAddress; the user approves a generic "deposit USDT on BNB" while the
   UI label still says "BNB · Aave" (`AgenticWalletEarnSection.tsx`). FIX: bind
   protocol+marketAddress into the action intent + show the real venue in consent.
5. **(P2) Principal accounting key lacks protocol.** `execute.ts` keys principal by
   `${chain}:${asset}` — Aave+Lista USDT on BNB collide. FIX: key by
   `${chain}:${protocol}:${asset}` (back-compat read for legacy keys).

## Copy / branding — BATCH WITH THE FLIP (step 5)

These surfaces say "BNB = Aave" and become wrong the moment Lista is enabled. Do NOT
edit them before the flip (BNB still serves Aave until then). At flip time, update +
(for the MCP) republish. The lib + API response are already data-driven (markets carry
`protocol:"lista"`, `label:"Lista Lending USDT"`), so functional rows auto-update; only
descriptive copy/branding needs hands:

- **Dashboard** `app/dashboard/components/AgenticWalletEarnSection.tsx`: header logos +
  "Aave V3 · Morpho" subtitle (~219-228), teaser "via Aave or Morpho" (~274), and the
  BNB chain-button label `"BNB · Aave"` (~467 — hardcoded; flip to "BNB · Lista", ideally
  data-driven from the reserves `protocol`/`label` by threading it into the form so it
  auto-tracks the flag). Market/position rows are already data-driven (auto-show Lista).
- **Dashboard** `app/dashboard/v2/views/WalletsView.tsx` (~1403, 1410-1411) demo copy;
  `DeveloperView.tsx` (~134-138, 1899) yield tool purposes.
- **MCP** (`mcp-server/`, republish): `yield-deposit.ts` / `yield-withdraw.ts` consent
  preview + descriptions; `yield-reserves.ts` / `yield-positions.ts` descriptions;
  `README.md` (~202-205), `.codex-plugin/plugin.json` (~4), `app/api/mcp/info/route.ts`
  (~76-79) venue enumeration ("Aave V3 on BNB, Morpho on Base" → add Lista). No tool
  count change (no new tool).
- **Docs / landing** `app/docs/page.tsx` (~317-326, 703-706); root `README.md`
  (~135-138, 147); `LandingBody.tsx` INTEGRATIONS (~22-26, co-marketing logo strip) +
  bento (~95-101); `UseCases.tsx` (~49); `app/agents/page.tsx` (~107-108, 130-133);
  `app/claude/page.tsx` (~130-133); `mcp-server/docs/HOOKS.md` (note `allowedProtocols`
  now accepts `"lista"`).
- Logos staged: `public/lista.svg` (circular dark badge) + `public/lista-token.svg`.

## Lista docs constraints baked into the integration

- Withdrawals are instant, NO cooldown/lockup, but **liquidity-bounded** (blocked only
  near ~99.99% utilization). The signer now pre-checks `maxWithdraw(owner)` for ERC-4626
  withdraws and rejects an over-liquidity amount with `yield_insufficient_liquidity`
  (400) before paying gas. "max" withdraw uses redeem(maxRedeem) — already bounded.
- Fees hit YIELD only (vault ≤50% + protocol 0-25%, now ~10%), never principal; the
  ERC-4626 share price nets them. No deposit/withdraw fee on principal.
- No whitelist on standard stable vaults (whitelist = "Alpha Zone" Binance-Alpha vaults).

## Open

- **Storage-layout proof before deploy (DO THIS):** `forge inspect
  Q402PaymentImplementationBNBYieldErc4626 storage-layout` and diff against the deployed
  payment impl `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` — confirm `usedNonces` is at
  slot 0 (a re-delegating wallet must carry its used-nonce set forward; a field inserted
  before it would let a used nonce replay). Typehashes/domain/NAME already match the
  deployed bytecode on-chain; slot equality is the one fund-safety invariant left to prove.
- Confirm the **Lista USDC Vault** `0x8a06Ac91265dBEBE6D4606f45b10993E9a571869` with Lista
  (found via on-chain trace, NOT their public docs): it IS a real ERC-4626 USDC vault
  (asset == BSC USDC, ~$330K TVL, ~3.5% APY live per DeFiLlama), but its curation/official
  status is not independently confirmed — have Lista bless it before scaling deposits.
- Lista APY API endpoint (wire `LISTA_API_URL` so the dashboard shows live APY; until
  then markets list with APY unknown). Do NOT hard-code an APY number anywhere — it drifts.
