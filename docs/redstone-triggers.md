# Q402 × RedStone — Autonomous NAV / price triggers

A RedStone signed feed drives a policy check and fires an autonomous **gasless**
stablecoin payout when the feed crosses a threshold ("NAV drops to X → send the
redemption", "ETH >= 2000 → pay the coupon"). Off-chain, ENV-gated, fail-closed.
This is the EVM proof for the Canton Dev Fund (NAV→settlement) and a named-
partnership anchor. RedStone feeds are public, so the whole thing runs on our
side with nothing to wait on from them.

**Status: BUILT, verified, OFF by default.** Nothing runs in production until an
operator completes the enable checklist below and sets `REDSTONE_ENABLED=1`.

## Architecture (reuses the proven recurring spine)

- `app/lib/redstone.ts` — fail-closed signed-feed reader. Fetches a signed
  package from the RedStone gateway via `@redstone-finance/sdk`
  (`requestDataPackages`), re-recovers + verifies each signer against the data
  service's authorized set (`getSignersForDataServiceId`), and THROWS on every
  uncertainty (disabled, not allowlisted, gateway down, too few trusted
  signers, stale, out of band). 45s cache.
- `app/lib/redstone-trigger.ts` — KV store + **edge-latch** state machine. A
  trigger fires EXACTLY ONCE per rising-edge crossing: `armed:false` on create
  (no instant-fire on an already-breached level), arms on the first unmet
  observation, fires on the next crossing, then disarms. `crossingSeq` keys the
  per-crossing fire-lock + durable fired-marker (idempotency, same as
  recurring's `(ruleId, slot)`).
- `app/api/cron/redstone-watcher/route.ts` — the watcher. `requireCronAuth`;
  inert-skip when disabled; per trigger: read feed (any throw → transient, never
  fires) → edge eval → per-tx cap → beforeAuthorize hooks → daily-cap reserve →
  subscription gate → fire-lock claim → reload+recheck → wallet-chain lock →
  beforeSettle hooks → `signAgenticPayment` → `submitToRelay({source:"redstone-
  trigger", internalTrustToken: CRON_SECRET})`. Uncertain relay → keep lock,
  write `uncertain` marker, no refund, no re-fire, page ops.
- Creation: `POST /api/wallet/agentic/redstone-trigger-by-key` (Mode C, apiKey)
  and `/api/wallet/agentic/[walletId]/redstone-trigger` (owner-sig, intent-bound).
- Discovery: `GET /api/redstone/feeds` (public — enabled + allowlist).
- MCP: `q402_redstone_feeds` (no key), `q402_redstone_trigger_create` /
  `_list` / `_cancel` (Mode C).
- Conditional-oracle: any payment can gate on a RedStone NAV via
  `OracleCondition { source: "redstone", feed: "ETH", op: ">=", value: 2000 }`.

## Environment

| var | meaning | default |
| --- | --- | --- |
| `REDSTONE_ENABLED` | master gate; unset ⇒ every read throws, every route 503/inert | off |
| `REDSTONE_ALLOWED_FEEDS` | comma list of readable feed ids (absent ⇒ nothing readable) | empty |
| `REDSTONE_DATA_SERVICE_ID` | RedStone data service | `redstone-primary-prod` |
| `REDSTONE_UNIQUE_SIGNERS` | min authorized signatures required | `2` (use ≥ 3 in prod) |
| `REDSTONE_STALE_AFTER_SEC` | max package age | `180` |
| `REDSTONE_BAND_<FEED>` | per-feed sanity band `min:max`, e.g. `REDSTONE_BAND_ETH=100:100000` | none |
| `REDSTONE_CHECK_INTERVAL_SEC` | per-trigger re-check throttle | `0` (every tick) |
| `REDSTONE_GATEWAYS` | override gateway urls (comma) | SDK default |

## Enable checklist (prod)

1. **Watchdog wiring.** Add the Vercel cron for `/api/cron/redstone-watcher` AND
   a `CRON_NAMES.REDSTONE_WATCHER` + `CRON_META` entry + `recordCronStatus` calls
   in the route. Intentionally unwired while OFF so a disabled feature never
   false-pages the watchdog — but a live money-moving cron with no watchdog can
   wedge silently. Wire all three together.
2. **Wallet caps.** Every wallet hosting a trigger must have BOTH `perTxMaxUsd`
   AND `dailyLimitUsd` set. `chargeAgainstDailyLimit` fails OPEN when no positive
   daily limit is configured (parity with recurring), so per-tx is the only
   backstop otherwise.
3. **Signer robustness.** `REDSTONE_UNIQUE_SIGNERS >= 3` so the median is robust
   to a single compromised signer. Set `REDSTONE_ALLOWED_FEEDS` and a
   `REDSTONE_BAND_*` per feed.
4. **Subscription.** Triggers are paid-Multichain-only on every chain (incl.
   BNB), same as recurring.

## Live demo — the on-narrative version (BlackRock/Apollo NAV → redemption)

RedStone's `redstone-primary-prod` already publishes real tokenized-fund NAV
feeds PUBLICLY (verified live 2026-07-03, signer-verified, ~12s fresh), so the
demo needs NOTHING from RedStone — just allowlist the feed id:

| feed id | fund | NAV | demo fit |
| --- | --- | --- | --- |
| `ACRED_FUNDAMENTAL` | Apollo Diversified Credit | ~1101.88 (MOVES) | best — NAV-crossing → redemption |
| `BUIDL_FUNDAMENTAL` | BlackRock BUIDL | 1.00 ($1 MMF, flat) | coupon via `BUIDL_DAILY_INTEREST_ACCRUAL` |
| `BENJI_ETHEREUM_FUNDAMENTAL` | Franklin Templeton | 1.00 | coupon |
| `VBILL_AVALANCHE_FUNDAMENTAL` | VanEck | 1.00 | coupon |

**Recommended demo env** (Apollo ACRED, `<=` redemption-floor semantics):

```
REDSTONE_ENABLED=1
REDSTONE_ALLOWED_FEEDS=ACRED_FUNDAMENTAL
REDSTONE_BAND_ACRED_FUNDAMENTAL=100:100000
REDSTONE_UNIQUE_SIGNERS=2   # 3+ in prod
# + CRON_SECRET, KV, relayer, and a funded BNB Agent Wallet on a paid sub
```

Seed ONE armed `once` trigger reading "when Apollo NAV is at/below 1105, send the
redemption" — with spot ~1101.88 the condition is MET, so `armed:true` fires it
on the first tick (`op:"<="`, `threshold:1105`, `feedId:"ACRED_FUNDAMENTAL"`,
`chain:"bnb"`, `token:"USDC"`, small `amount`). The story: "Apollo Diversified
Credit NAV crossed the floor → Q402 fired the gasless redemption payout."

Prereqs (generic / crypto feed variant): `REDSTONE_ENABLED=1`,
`REDSTONE_ALLOWED_FEEDS=ETH`, `REDSTONE_BAND_ETH=100:100000`, `CRON_SECRET` + KV +
relayer set, and a funded BNB Agent Wallet on a paid sub.

1. Seed ONE armed `once` trigger directly in KV with a threshold just below spot
   ETH (armed:true bypasses the create-time disarm so it fires on the first tick):

   - key `aw:rstrigger:{owner}:{walletId}:{id}` = the trigger JSON
     (`status:"active"`, `armed:true`, `crossingSeq:0`, `mode:"once"`,
     `feedId:"ETH"`, `op:">="`, `threshold:<just below spot>`, `chain:"bnb"`,
     `token:"USDC"`, `recipient`, `amount`).
   - `rpush aw:rstrigger:list:{owner}:{walletId} {id}`
   - `zadd aw:rstrigger:next-check {now} {owner}/{walletId}/{id}`

2. Tick the watcher:

   ```
   curl -H "Authorization: Bearer $CRON_SECRET" \
     "$BASE/api/cron/redstone-watcher"
   ```

   Expect exactly one `outcome:"fired"` with a real `txHash` (a gasless USDC
   settle on BNB, relayer-sponsored gas).

3. Tick again — the same trigger is now `fired-once` (dropped from the scan
   set): the second tick fires nothing. Proves the edge-latch and exactly-once.

## Verification done (build phase)

- `redstonePrice()` verified live read-only against the RedStone gateway
  (2 trusted signers, fresh, band + signer-count guards throw).
- Deterministic tests: `redstone.test.ts` (fail-closed reader branches),
  `redstone-trigger.test.ts` (edge-latch truth table, fire-lock idempotency,
  durable-marker recovery, once/repeat, cascade), `redstone-condition-source.test.ts`
  (RedStone oracle source allow / 412 / fail-closed / disabled).
- Full suite green, `tsc --noEmit` clean (landing + MCP), `next build --webpack`
  clean, eslint clean.
- Independent adversarial audit: all money-path invariants (double-fire,
  fail-closed, refund symmetry, uncertain-relay, auth, edge-latch) upheld; no
  CRITICAL/HIGH. The two enable-time concerns are captured in the checklist above.
