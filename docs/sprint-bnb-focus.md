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
  else the wallet's `plan="trial"` sub.
- Cards: Sponsored TX (2k gauge) · Gas: Covered · Today's TX · Total
  Relayed
- API Key card: live key with `BNB only` badge
- Playground: chain dropdown locked to BNB; tokens USDC / USDT only
- Gas Tank tab: hidden (Q402 covers gas)
- Sidebar: credits gauge + days-left chip

### Multichain view
- Source of truth: wallet subscription (paid plan)
- Trial-only / unpaid users see 0 / empty state with no API Key card
  (no "upgrade" placeholder, just clean empty)
- Gas Tank tab: visible (user funds in BNB / ETH / etc.)
- Subscription banner: only renders when `amountUSD > 0` (no fake
  "Subscription Active" for trial-only users)
- Sidebar: same view sections, Multichain selected

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

Session-gated read of trial state: returns `apiKey`, `sandboxApiKey`,
`credits`, `totalCredits`, `trialExpiresAt`, `hasWallet`. Provisioning
happens at signup; this endpoint is pure read.

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
