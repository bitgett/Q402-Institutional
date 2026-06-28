# Q402 Yield x Lista Lending (BNB) — go-live runbook

BNB yield venue = **Lista Lending** (Moolah curated ERC-4626 vaults). Launch routes
USDT into the **Gauntlet USDT Vault** `0x6d6783C146F2B0B2774C1725297f1845dc502525`
(verified on-chain: ERC-4626, asset() == BSC USDT, ~$8M TVL) and USDC into the
**Lista USDC Vault** `0x8a06Ac91265dBEBE6D4606f45b10993E9a571869` (verified on-chain:
ERC-4626, asset() == BSC USDC, ~$330K TVL). Both stables are wired end to end (curated
default vault + immutable impl allowlist + drift test). The whole path is built and gated
by `LISTA_YIELD_ENABLED` (default off → BNB stays on the Aave path, zero behavior change).

**DEPLOYED 2026-06-29 (BNB mainnet):** impl `0x7EC2559a7A724ad02Ddce796710ebe04eE6064dD`
(deployer Alice `0xFe7bA1CDc7077F71855627F9983a70188826726f`). `verify-lista-wiring.mjs`
PASS on it — NAME "Q402 BNB Chain" / VERSION 1 / IMPL_VERSION "2-yield-bnb-erc4626-lista",
Gauntlet USDT + Lista USDC allowlisted, random vault/asset denied. MCP republished
(`@quackai/q402-mcp@0.8.56`). REMAINING to go live (Vercel prod env): set
`YIELD_IMPL_BNB_LISTA=0x7EC2559a7A724ad02Ddce796710ebe04eE6064dD` (leave `YIELD_IMPL_BNB`
unset/Aave), then `LISTA_YIELD_ENABLED=true`, then smoke deposit + withdraw (USDT + USDC).

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
3. **Wire** the env: set `YIELD_IMPL_BNB_LISTA=<deployed address>` in Vercel (prod) — the
   NEW per-protocol env for the Lista ERC-4626 impl. ⚠️ Do NOT touch `YIELD_IMPL_BNB` (it
   stays the Aave impl; lista resolves its own env and never falls back). Fund the relayer
   with BNB gas.
4. **Pre-flip guard:** `node scripts/verify-lista-wiring.mjs` — asserts the wired
   `YIELD_IMPL_BNB_LISTA` IS the Lista ERC-4626 impl (IMPL_VERSION + allowlist) so we
   can't flip the flag against the wrong impl (would revert deposits after paying gas —
   spec MED-2). Only when it prints OK:
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

## P1 BLOCKERS — CLOSED in code (external audit + adversarial re-audit)

Root cause: the write path pinned protocol per-op, but reads/withdraw/accounting/
allocation/GC were keyed by (chain,asset) and assumed one protocol per chain, so the
flag's global Aave→Lista pivot orphaned/mis-routed existing funds. The full-coexistence
fix (commits `f75baef`, `9d2bb87`, `0d54e51`; new env `YIELD_IMPL_BNB_LISTA`) resolves
them. Re-audit verified all CLOSED + 1491/1491 tests / tsc / eslint green.

1. **Withdraw routes by the POSITION's protocol+marketAddress** (validated vs the
   curated allowlist), not the flag — legacy Aave + new Lista both withdrawable. A
   same-asset two-venue withdraw returns `409 AMBIGUOUS_POSITION` (caller passes
   `protocol`). ✅
2. **Reads/withdraw/GC decoupled from the flag** — `LISTA_YIELD_ENABLED` gates ONLY new
   deposits + market advertising; Lista positions stay visible, withdrawable and
   GC-counted with the flag off (rollback no longer orphans). ✅
3. **maxAllocationPct sums ALL configured protocols** on the chain. ✅
4. **Per-protocol impl (P0):** `yieldImplFor` resolves `YIELD_IMPL_<CHAIN>_LISTA` and
   never falls back to the Aave impl, so flipping the flag without the deployed ERC-4626
   impl fails closed (no per-deposit gas burn). ✅
5. **Principal key namespaced** `${chain}:${protocol}:${asset}` (legacy migrated on first
   touch); activity rows carry `protocol`. ✅

**Still required before the flip (flip-batch, needs client lockstep — see below):**
the MCP + dashboard withdraw need an optional `protocol` selector so a two-venue wallet
can resolve the `409` (server already accepts it; the idempotency key is already
venue-tagged). Binding protocol into the SIGNED intent + the "BNB = Aave" MCP
descriptions are the remaining consent-integrity items. The EIP-712 witness already
binds the exact vault on-chain, so these are integrity/UX, not a fund path.

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
