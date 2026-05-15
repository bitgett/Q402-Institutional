# BNB-Focus Sprint — Build Notes

**Branch**: `feat/bnb-focus-sprint`
**Sprint window**: 2026-05-13 → 2026-05-20
**Rollback anchor**: `v1.27-multichain` git tag

This file is the canonical source-of-truth for what shipped on the sprint
branch, what flag controls what, and what to flip when the event ends.

---

## 1 · Architecture in one screen

```
[ Main landing / ]            ← unchanged, full 7-chain product
[ /event ]                    ← single Connect CTA → ConnectModal → MY Page
[ /dashboard ]                ← left sidebar · Free Trial / Multichain views
[ Navbar Connect (global) ]   ← 3-way picker (Google / Email / Wallet)
```

Trial is granted server-side on first signup (Google / Email / Wallet)
and lives on either an `email:<sub>` pseudo-account OR a wallet address.
Same identity ≠ two trials — `trial_used_by_email:{email}` + per-wallet
`trial_used:{addr}` sentinels block Sybil farming.

---

## 2 · Feature flags

`app/lib/feature-flags.ts`

| Flag | Default on sprint branch | Meaning |
|---|---|---|
| `EVENT_MODE` | `true` | `/event` page is live, Navbar shows the Event link |
| `BNB_FOCUS_MODE` | `false` (legacy alias) | The narrowing-all-surfaces version was reverted; relay route still has BNB-only enforcement for `plan === "trial"` regardless of this flag |
| `TRIAL_CREDITS` | `2_000` | Sponsored TX granted on signup |
| `TRIAL_DURATION_DAYS` | `30` | Trial window |
| `TRIAL_PLAN_NAME` | `"trial"` | Plan key stored on subscription records |

**Post-sprint rollback**: Vercel UI → Settings → Git → Production Branch =
`main`. Zero code changes. Promote latest `main` deployment. The trial
backend stays callable but the `/event` page + Navbar Event link
disappear (controlled by `EVENT_MODE`).

---

## 3 · Auth & onboarding

### Three signup paths

| Path | Endpoint | Grant on first signup |
|---|---|---|
| Google OAuth | `POST /api/auth/google` | live key + sandbox key + 2k credits + `trialExpiresAt` |
| Email magic-link | `POST /api/auth/email/signup` → `GET /api/auth/email/callback?token=…` | same |
| Wallet | dashboard auto-prompt → `POST /api/trial/activate` | same |

### Sybil sentinels (10-year TTL)

- `trial_used_by_email:{email}` — set when Google/Email signup grants
  trial. Wallet flow inherits this via `trial_used_by_email` check when
  an email session is present.
- `trial_used:{addr}` — set when wallet flow activates via
  `/api/trial/activate`.

### Sessions

`app/lib/session.ts` — Vercel KV-backed, 30-day cookie `q402_sid`,
HttpOnly + Secure-in-prod + SameSite=lax, 32-byte hex ids.

### Google OAuth verification

`app/lib/google-auth.ts` — Google's `tokeninfo` endpoint (zero-dep);
checks `aud === GOOGLE_CLIENT_ID`, `iss ∈ {accounts.google.com,
https://accounts.google.com}`, `email_verified === true`, `exp` not
expired. 5-sec AbortSignal timeout.

---

## 4 · Dashboard layout (`/dashboard`)

Two views via toggle in the left sidebar:

### Free Trial view
- Source of truth: email pseudo-account when an email session exists,
  else the wallet's `subscription.trialApiKey` (+ `trialSandboxApiKey`).
- Cards: Sponsored TX (2k gauge) · Gas: Covered · Today's TX · Total
  Relayed
- API Key card: live key with `BNB only` badge
- Playground: chain dropdown locked to BNB; tokens USDC / USDT only
- Gas Tank tab: hidden (Q402 covers gas)
- Sidebar: credits gauge + days-left chip + ALL multichain tabs always
  visible (no view-gating on the tab list itself)

### Multichain view
- Source of truth: wallet subscription's `apiKey` slot (paid only).
- API Key card ALWAYS renders. Trial-only / unpaid users see a Locked
  placeholder with a Pricing CTA (the card shell stays so the surface
  feels complete; only the key value is hidden).
- Gas Tank tab: visible (user funds in BNB / ETH / etc.)
- Subscription banner: only renders when `amountUSD > 0` (no fake
  "Subscription Active" for trial-only users)
- Sidebar: same view sections, Multichain selected

### Trial vs paid key isolation

The two scopes live in separate `Subscription` slots so a paid upgrade
never touches the trial keys:

| Slot                  | Written by                                  | Read by                                  |
|-----------------------|---------------------------------------------|------------------------------------------|
| `apiKey`              | `/api/payment/activate` only                | Multichain view, paid relay scope        |
| `sandboxApiKey`       | provision / payment-activate                | Multichain view sandbox                  |
| `trialApiKey`         | `/api/trial/activate`, Google/email signup  | Trial view, trial relay scope            |
| `trialSandboxApiKey`  | trial activate, Google/email signup         | Trial view sandbox                       |

The Transactions tab filters by which key was used (`tx.apiKey ∈ view's
key set`), so flipping views shows only the history that scope produced.
Pre-migration trial accounts (where the trial key lived in `apiKey`) are
caught by a fallback path in `/api/keys/provision` and the dashboard's
`trialKeySet` builder.

### Auto-prompt rules

- Wallet connects + no trial + no email session → `TrialActivationModal`
  fires once (per page load, via `useRef` sentinel)
- Email session exists → skip the auto-prompt entirely (would
  otherwise 409 due to `trial_used_by_email`)

---

## 5 · Server-side enforcement

### Relay route (`/api/relay`)

- Section 4 — subscription expiry: trial subs gated on `trialExpiresAt`
  (not `paidAt + 30d`)
- Section 4b — trial plan → BNB only: any non-BNB chain on a
  `plan === "trial"` key returns 403 with code `TRIAL_BNB_ONLY`
- Sandbox keys bypass both

### Email-sandbox (`/api/keys/email-sandbox`)

Session-gated read of trial state: returns `apiKey`, `sandboxApiKey`
(legacy fields, populated from `trialApiKey`/`trialSandboxApiKey`),
`trialApiKey`, `trialSandboxApiKey`, `credits`, `totalCredits`,
`trialExpiresAt`, `hasWallet`. Provisioning happens at signup; this
endpoint is pure read.

### Trial activate email handling (`/api/trial/activate`)

`body.email` is a hint, never a credential. The route only writes
`subscription.email` when the session cookie resolves to a verified
email AND (no `body.email` was sent OR `body.email` matches the
session email). Otherwise the value is dropped — stops a wallet-signed
request with a forged email from poisoning the reminder cron.

### Expiry reminder cron

`/api/cron/usage-alert` has two legs:
1. Existing — 20% / 10% credit-low alerts for paying users
2. New — 7d / 3d / 1d trial-expiry reminders, sourced from
   `TRIAL_INDEX_SET` (`trial_alert:_index`). Email template
   `renderTrialExpiryHtml` in `app/lib/email.ts`.

---

## 6 · MCP `@quackai/q402-mcp`

- Published: **v0.3.6** on npm (`latest`)
- `BNB_FOCUS_MODE = false` in `src/chains.ts` → 7-chain registry intact
- Source repo: `github.com/bitgett/q402-mcp`
- The npm-published v0.3.5 had BNB-only narrowing baked in (legacy from
  sprint start); v0.3.6 corrected that. v0.3.5 is still on the registry
  for inspection but `latest` skips past it.

---

## 7 · Vercel env state

| Env | Scopes | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Production · Preview(sprint) · Development | |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | same | Same value as `GOOGLE_CLIENT_ID` — Next requires the prefix to embed in client bundle |
| `RESEND_API_KEY` | Production · Preview | Sensitive; value not visible in CLI pull |
| `RESEND_FROM_ADDRESS` | Production · Preview | `Q402 <alerts@quackai.ai>` (verified domain) |
| `CRON_SECRET` | Production | Existing |
| Vercel KV (`KV_*` / `REDIS_URL`) | all 3 | Existing |

---

## 8 · Known gaps (for follow-up after sprint)

- Wallet + Email same person — two separate sub records. Trial view
  defaults to email pseudo (correct), but a `pairSessionWithWallet`
  call on any wallet connect (not just trial activation) would let the
  two sides merge cleanly.
- Auto-prompt fires once per page load. If user cancels, no manual
  "Activate Trial" CTA on the wallet view to recover.
- Email-only branch on dashboard does NOT show the sidebar yet (was
  scoped out of the sidebar refactor). When wallet is connected the
  sidebar takes over.

---

## 9 · Tag map

| Tag | Branch | Meaning |
|---|---|---|
| `v1.27-multichain` | `main` HEAD pre-sprint | Frozen 7-chain + RLUSD + 372 settled TX |

Sprint commits live on `feat/bnb-focus-sprint`; not merged into `main`.
Vercel branch swap is the rollback lever.

---

## 10 · Identity model — Phase 1 (bind-once)

The dashboard used to route by "whichever wallet is connected in the
browser right now," which created the dual-identity sharp edge the
external audit flagged ("Trial view = email pseudo, Multichain view =
arbitrary connected wallet, banner says they're NOT the same"). Phase 1
closes that. Phase 2 (in a separate PR after sprint launch) will add
account migration + a recovery flow.

### Principle
Email account is a TEMPORARY identity. The first wallet that signs
`/api/auth/wallet-bind` becomes the account's permanent canonical
wallet. After that point the dashboard always renders based on the
bound wallet — never on whatever wallet happens to be connected.

### Server contracts

`POST /api/auth/wallet-bind`
- Body: `{ address, challenge, signature }` — fresh single-use
  challenge, same gate as `/api/payment/activate`
- 200 `{ ok: true, bound: true, address }` — first bind or idempotent
  re-bind
- 409 `{ ok: false, code: "WALLET_ALREADY_BOUND", boundAddress }` —
  different wallet attempted. NEVER silently overwrites session.address
- 401 if no session cookie

`GET /api/auth/me`
- `{ authenticated, email, boundAddress, bindState: "bound" | "unbound",
   address (legacy alias of boundAddress), expiresAt }`
- Front-end MUST read `boundAddress` / `bindState` for routing
  decisions — `address` is preserved only for old clients

### Dashboard 4-state machine

| State | emailSession | bound | connected | match | UI |
|---|---|---|---|---|---|
| A | no | — | no | — | bounce to `/` |
| B | no | — | yes | — | regular wallet-only dashboard |
| C | yes | unbound | no | — | email-only view — "Connect a wallet to claim" |
| D | yes | unbound | yes | — | **ClaimWalletPrompt** — signed bind |
| E | yes | bound | no | — | email-only view + "Reconnect 0x…X" |
| F | yes | bound | yes | ✓ | regular Multichain dashboard |
| G | yes | bound | yes | ✗ | **WrongWalletHardBlock** — no data fetch |

States D + G are the new ones. The provision + transactions useEffects
also bail when `walletMatches` is false — belt-and-suspenders against a
brief flash between mount and the early-return paint.

### What Phase 1 explicitly does NOT do
- Migrate trial credits / API key owner / tx history from the email
  pseudo-account onto the wallet subscription — Phase 2
- Provide a UI for re-pairing after wallet loss — Phase 2 (support
  email only today; WrongWalletHardBlock surfaces the support address)
- Tombstone the email pseudo-account on bind — Phase 2

### Migration safety
Pre-Phase-1 sessions that already had `session.address` populated by the
legacy unsigned auto-bind path continue to work — `/api/auth/me` reads
`session.address` as `boundAddress` and the bind-once gate treats it as
"already bound." A user who connects a different wallet to such a
session will hit State G immediately rather than the old
"Different wallet detected" banner. There is no schema migration.

### Tests
- `__tests__/wallet-bind.test.ts` — signed-bind ordering, 409 mismatch,
  idempotent re-bind, no silent overwrite
- `__tests__/dashboard-state-machine.test.ts` — State D / G early
  returns, provision + tx useEffect gating, Sidebar lock, no auto-bind

---

## 11 · Identity model — Phase 2 (account merge)

Phase 1 stopped the dual-identity UI bleed. Phase 2 finishes the model
by merging the email pseudo-account into the wallet principal on bind /
first-paid-activation.

### Why this still matters

After Phase 1:
- Email signup creates `email:<sub>` pseudo-subscription (trial + keys)
- Wallet bind sets `session.address` and persists the binding
- BUT the email pseudo and the wallet sub stay as TWO separate records
- A user who signs in via wallet-only later sees their wallet's own
  (likely empty) account, not the trial they got via email — operations
  + support + analytics now reason about one human as two records

### Phase 2 scope (deferred to v1.28)

When `/api/auth/wallet-bind` succeeds OR `/api/payment/activate` runs
for a wallet that has a paired email session, migrate the email pseudo
onto the wallet principal:

| Field / KV | Source (email pseudo) | Target (wallet) | Policy |
|---|---|---|---|
| `subscription` | `sub:email:<sub>` | `sub:0xabc...` | Merge trial keys + credits into wallet sub; preserve any pre-existing wallet sub fields (paid plan etc.) |
| `quota:{addr}` | counter | counter | INCRBY by pseudo's remaining credits, then delete pseudo's counter |
| `apikey:{key}.address` | `email:<sub>` | `0xabc...` | Reassign owner — existing keys keep working, dashboard surfaces them under the wallet |
| `relaytx:{pseudo}:{YYYY-MM}` | per-month lists | append into `relaytx:0xabc...:{YYYY-MM}` | Concat trial history into wallet history so Transactions tab shows unified scope |
| `email_to_addr:{email}` | `email:<sub>` | `0xabc...` | Repoint so future signup with same email arrives at the wallet |
| `account_alias:email:<sub>` | (new) | `0xabc...` | 30d tombstone for debugging / rollback |

### Recovery flow (also deferred)

The Phase 1 hard-block surfaces a support email for users who lost
access to the bound wallet. Phase 2 adds a deliberate OTP-gated
re-pair endpoint:
- User clicks "I lost my wallet" in WrongWalletHardBlock
- Server emails a magic-link OTP to the verified address
- 7-day cooldown enforced + alert email to the old wallet owner via
  reverse-lookup (best-effort, since `wallet_to_email` index doesn't
  exist pre-Phase-2)
- On confirm: clear `session.address`, allow a fresh signed bind to a
  new wallet, repeat the migration steps above

### What doesn't change

- `/api/auth/wallet-bind` 's bind-once contract stays. Phase 2 only
  changes what happens AFTER bind succeeds — the bind itself remains
  signed + single-attempt + 409 on mismatch.
- The dashboard's 4-state machine keeps its early-return shape. After
  migration, State F still renders for bound+matching wallets — the
  difference is the wallet sub now carries the trial data.

---

## 12 · Phase 1.5 — Read-side wallet ↔ email bridge

Phase 1 stopped the dual-identity UI bleed. Phase 2 (the real migration)
is deferred to v1.28. In between, Phase 1.5 closes the most visible UX
gap from Phase 1: a wallet-only login (no `q402_sid` cookie) couldn't
see the trial credits + keys that lived on the email pseudo-account
because the dashboard only read the wallet's own subscription record.

### The bridge

One KV reverse index:

```
wallet_email_link:{wallet_addr} → "user@x.com"
```

Written on:
- `/api/auth/wallet-bind` success (the canonical bind path)
- `/api/trial/activate` when an email session was adopted (defence in depth)

10-year TTL — mirrors `trial_used:{addr}` and `trial_used_by_email:{email}`
so the bridge survives subscription churn.

### How `/api/keys/provision` uses it

After loading the wallet's own subscription, provision calls
`loadBoundEmailTrial(addr)` which:

```
walletEmailLink[wallet] → email
  → emailToAddr[email] → pseudoAddr
  → getSubscription(pseudoAddr) → pseudo sub
  → getQuotaCredits(pseudoAddr) → trial credit balance
```

The response then unions the pseudo's trial state into:
- `trialApiKey` / `trialSandboxApiKey` (when the wallet has no own trial slot)
- `boundEmailTrial: { email, credits, totalCredits, trialExpiresAt }` (explicit bridge field)
- `isTrialActive` (true if the bridged trial is still in window)

Three null-return guards inside `loadBoundEmailTrial` protect against
drift — missing link, missing email_to_addr, missing pseudo sub.

### What this is NOT

- **Not a migration.** The pseudo's data stays on `sub:email:<sub>`.
  Its quota counter, tx history, API key owners, trial reminder
  registration all stay pseudo-keyed.
- **Not a write path.** `loadBoundEmailTrial` is read-only; no
  `kv.set`, no `kv.del`, no subscription writes.
- **Not a recovery flow.** A wallet that loses access still falls
  into WrongWalletHardBlock → support email.

### What Phase 2 will still do

Phase 2 (v1.28) does the actual data merge — moves the pseudo's
subscription, quota counter, key ownership, tx history, alert/reminder
registration onto the wallet principal and tombstones the pseudo. After
Phase 2 lands, `loadBoundEmailTrial` becomes a no-op (the pseudo
either doesn't exist or its `trialApiKey`/credits are 0). The bridge
key can either be repurposed as a "merged_from" marker or removed.

---

## 13 · Strict 1:1 wallet ↔ email contract

Phase 1 closed per-session bind-once. Phase 1.5 added the read-side
bridge (§12). But the bridge introduced a new failure mode: a second
email session could silently overwrite `wallet_email_link:{wallet}`
when binding the same wallet. The session-scoped check on
`session.address` only catches "this session tries to switch wallet"
— it doesn't see cross-session attacks/mistakes. This §13 closes both
cross-session directions.

### The 1:1 contract

Strict one-wallet-per-email and one-email-per-wallet, enforced by
TWO global KV indexes (both 10-year TTL):

```
wallet_email_link:{wallet}  → email      // wallet-side claim
email_to_wallet:{email}     → wallet     // email-side claim
```

### Three-step check in `/api/auth/wallet-bind`

1. **Idempotency** — accept if EITHER `session.address === verifiedAddr`
   OR both global indexes already point at this exact pair. Lets a
   user who logged out + back in re-bind the same wallet without
   re-signing.
2. **Session direction** — 409 `WALLET_ALREADY_BOUND` (with bound
   wallet address) when `session.address` is set to a different
   wallet. Unchanged from Phase 1.
3. **Wallet direction** — 409 `WALLET_TAKEN` when
   `wallet_email_link:{wallet}` points at a different email. Response
   intentionally omits the colliding email to avoid an existence
   oracle.
4. **Email direction** — 409 `EMAIL_ALREADY_BOUND` (with bound wallet
   address) when `email_to_wallet:{email}` points at a different
   wallet. Catches the cross-session re-bind case.

Only after all three pass does `pairSessionWithWallet` run and BOTH
indexes get written (Promise.all, best-effort — bind itself is already
committed).

### Why "leak nothing" on WALLET_TAKEN

Echoing the bound email would let any wallet owner enumerate
"does this email have a Q402 account?" The reverse case
(EMAIL_ALREADY_BOUND echoing the bound wallet) is fine: wallet
addresses are public, the user already knows their own wallets.

### Client UX (`bindWallet` + ClaimWalletPrompt)

The helper's tagged result distinguishes all three 409 paths so the
prompt can render concrete recovery copy:
- WALLET_ALREADY_BOUND → "Sign out and back in with that wallet"
- WALLET_TAKEN → "Sign in with that email, or use a different wallet"
- EMAIL_ALREADY_BOUND → "Switch your wallet extension to 0x…X"

### Operator notes

If a legitimate user gets stuck (e.g. lost wallet, lost email access),
recovery is still support-only — Phase 2 will add a dedicated OTP-
gated re-pair endpoint. The global indexes are deliberately permanent
so support can deterministically resolve "who claimed what when".
