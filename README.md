# Q402 — Gasless Payments on EVM

> Pay USDC, USDT, or RLUSD across **10 EVM chains** with $0 in gas.
> Built on EIP-7702 + EIP-712. Callable from a browser, a Node.js
> backend, or any MCP-compatible AI client — first-class support for
> Claude (Desktop / Code), OpenAI Codex CLI, Cursor, and Cline.

[![sdk](https://img.shields.io/badge/sdk-v1.8.0-yellow)](public/q402-sdk.js)
[![mcp](https://img.shields.io/badge/npm-@quackai/q402--mcp-blue)](https://www.npmjs.com/package/@quackai/q402-mcp)
[![chains](https://img.shields.io/badge/chains-10-green)](#supported-chains)

**Live**: https://q402.quackai.ai &nbsp;·&nbsp; **Free trial**: https://q402.quackai.ai/event &nbsp;·&nbsp; **Docs**: https://q402.quackai.ai/docs

---

## Why

Users need a native gas token (BNB, ETH, AVAX, …) just to move stablecoins.
Q402 removes that step: user signs off-chain, relayer submits + pays gas,
recipient gets 100%. Same primitive serves AI agents — one API key, every chain.

---

## What it does

```
User signs EIP-712 off-chain
  → Q402 relayer submits Type 4 (EIP-7702) transaction
    → on-chain: USDC/USDT/RLUSD moves from sender to recipient
      → recipient receives 100%, sender pays $0
```

All 10 chains share the witness type, the signing rule (`verifyingContract = user EOA`),
and the on-wire body. Chain-specific: impl contract + EIP-712 domain name.

---

## Supported chains

| Chain | Chain ID | Tokens | Status |
|---|---|---|---|
| BNB Chain | 56 | USDC, USDT | live |
| Ethereum Mainnet | 1 | USDC, USDT, RLUSD | live |
| Avalanche C-Chain | 43114 | USDC, USDT | live |
| X Layer | 196 | USDC, USDT | live |
| Stable Chain | 988 | USDT0 (aliased to USDC/USDT) | live |
| Mantle | 5000 | USDC, USDT (USDT0) | live |
| Injective EVM | 1776 | USDC, USDT | live |
| Monad | 143 | USDC, USDT (USDT0) | live |
| Scroll | 534352 | USDC, USDT | live |
| Arbitrum One | 42161 | USDC, USDT | live |

RLUSD is Ethereum-only (issuer constraint, 18 decimals). Injective supports native Circle USDC (CCTP) + USDT.

---

## Three ways to use Q402

### 1. End user — the dashboard

Sign up at [q402.quackai.ai](https://q402.quackai.ai) with Google, email, or a wallet.
Live + sandbox keys, TX history, Gas Tank balances, trial credit gauge.

### 2. Web developer — the browser SDK

Drop the SDK in any page with `window.ethereum`:

```html
<script src="https://q402.quackai.ai/q402-sdk.js"></script>
<script>
  const q402 = new Q402Client({ apiKey: "q402_live_…", chain: "bnb" });
  await q402.pay({ to: recipientAddress, amount: "10.00", token: "USDT" });
</script>
```

The SDK handles EIP-712 + EIP-7702 + relay POST. User signs once.

### 3. AI agent — the MCP server

Register with your MCP client (one-liner per client — secrets go in a separate file, not in this config):

```bash
# Claude Code / Claude Desktop
claude mcp add q402 -- npx -y @quackai/q402-mcp

# OpenAI Codex CLI
codex mcp add q402 -- npx -y @quackai/q402-mcp

# Cursor / Cline: paste { "mcpServers": { "q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] } } }
# into ~/.cursor/mcp.json (Cursor) or Cline → Settings → MCP Servers → Edit JSON.
```

Then ask your AI: **"Set up Q402"**. The agent runs `q402_doctor` → creates
`~/.q402/mcp.env` → walks you through pasting keys in your editor, **never in chat**.

Auto-routes by chain: `chain="bnb"` + trial key → Trial (free 2k TX). Anything else → Multichain.
6+ BNB batches return `status="ambiguous"` so the agent asks the user how to split.

**27 tools** (all sandbox by default; live needs an API key + a signing path):

| Tool | Auth | What it does |
|---|---|---|
| `q402_doctor` | none | First-install onboarding + health check |
| `q402_quote` | none | Compare gas across 10 chains |
| `q402_balance` | api key | Verify key + remaining quota |
| `q402_pay` | live mode | Single-recipient gasless transfer |
| `q402_batch_pay` | live mode | Up to 20 recipients per call (trial: 5) |
| `q402_receipt` | none | Fetch + verify a Trust Receipt |
| `q402_wallet_status` | private key | Per-chain EIP-7702 state |
| `q402_clear_delegation` | private key | Reset EIP-7702 delegation; Q402 sponsors the on-chain TX on every chain |
| `q402_agentic_info` | api key | Agent Wallet info (caps, ERC-8004) |
| `q402_recurring_list` | api key | List scheduled rules |
| `q402_recurring_create` | api key | Author a rule (paid Multichain only) |
| `q402_recurring_fires` | api key | Last 50 fires per rule |
| `q402_recurring_pause` | api key | Pause a rule (reversible) |
| `q402_recurring_resume` | api key | Resume a paused / stopped rule |
| `q402_recurring_skip_next` | api key | Skip only the next fire |
| `q402_recurring_cancel` | api key | Permanently stop a rule |
| `q402_bridge_quote` | none | Quote a CCIP USDC bridge (LINK + native fee) |
| `q402_bridge_send` | live key | Execute a cross-chain USDC bridge from the Agent Wallet (Mode C, since MCP 0.8.10). Sandbox-by-default; `sandbox: false` + live Multichain key fires a real on-chain bridge. |
| `q402_bridge_history` | not yet wired | Returns a dashboard pointer (`{ implemented: false, dashboardUrl }`). Live MCP execution needs session-bound owner-sig auth (follow-up). View at /dashboard → Wallets → Bridge. |
| `q402_bridge_gas_tank` | not yet wired | Returns static guidance + the canonical Gas Tank deposit address. Live balance lookup needs owner-sig auth (dashboard for now). |
| `q402_yield_reserves` | none | List Q402 Yield (Aave V3) lending markets + live supply APY. BNB-only today. |
| `q402_yield_positions` | api key | The Agent Wallet's current Q402 Yield positions (value + APY). Read-only. |
| `q402_yield_deposit` | live key | Supply the Agent Wallet's USDC / USDT into Aave (Mode C). **Paid Multichain plan only — Trial cannot deposit.** Confirm + sandbox-by-default. |
| `q402_yield_withdraw` | live key | Withdraw the Agent Wallet's supplied stablecoin out of Aave (`amount="max"` for the full position). Always allowed, even after downgrade. |

The three fund-moving tools — `q402_pay`, `q402_batch_pay`, and `q402_bridge_send` — use **two-phase consent**. Call them first WITHOUT a `consentToken`: the tool does not send, it returns a `needs_confirmation` preview (recipient, amount, chain) plus a `consentToken`. Relay that preview to the user, get an explicit yes, then re-call with the same args **plus** the `consentToken` to execute. The token is re-derived from the parameters about to run, so a previewed payment can't be swapped for a different one — `confirm: true` alone no longer fires a payment.

Q402 Yield is a **paid-only** feature: depositing requires a live Multichain plan, Trial accounts cannot supply, and withdrawals are always allowed so deposited funds can always be recovered.

---

## Cross-chain USDC bridge (Chainlink CCIP)

Phase 1: **3-chain triangle** — ETH ↔ AVAX ↔ Arbitrum (6 directed lanes).
The other 7 Q402 chains stay native-gasless only — Circle hasn't deployed
CCIP-routable USDC pools there yet.

- Source: Q402CCIPSender contract on each of eth/avax/arbitrum
- Destination: USDC arrives directly at the user's Agentic Wallet (same EOA across chains)
- Fee: paid in LINK (~10% cheaper) or native, from the user's Gas Tank
- Markup: **zero** — user pays only the actual Chainlink CCIP cost

| Lane | Sample fee (1 USDC) |
|---|---|
| arb → avax | ~$0.60 native / ~$0.36 LINK |
| arb → eth  | ~$4.65 native (L1 gas dominates) |
| eth → arb / avax | ~$1.20 |
| avax → eth | ~$9 (L1 gas) |
| avax → arb | ~$1.14 |

API + MCP surfaces:
- `GET /api/ccip/lanes` — public 6-lane matrix
- `POST /api/ccip/quote` — live fee quote (LINK + native)
- `POST /api/ccip/send` — intent-bound bridge execution (Mode C, server-managed Agentic Wallet)
- `POST /api/ccip/confirm` — destination ExecutionStateChanged poll
- `GET /api/ccip/bridge-history` — per-owner history
- MCP tools: `q402_bridge_quote`, `q402_bridge_send`, `q402_bridge_history`, `q402_bridge_gas_tank`

---

## Free trial event

Sign up at [/event](https://q402.quackai.ai/event):

- 2,000 sponsored TX on BNB Chain
- Live (`q402_live_*`) + sandbox (`q402_test_*`) keys
- 30-day window

Trial credits are real settlements — gas from the relayer wallet, recipient gets the full amount.
Trial credentials live in their own key slot (`trialApiKey`); upgrading on [/payment](https://q402.quackai.ai/payment)
provisions a separate paid key with self-funded Gas Tank.

Trial = BNB-only (server-side `TRIAL_BNB_ONLY` gate). Paid = all 10 chains.

---

## Architecture in one screen

```
┌─────────────────────────────────────────────────────────────┐
│ Client (browser SDK / Node SDK / Q402 MCP)                  │
│   - Builds EIP-712 TransferAuthorization                     │
│   - Builds EIP-7702 Authorization                            │
│   - POST /api/relay { apiKey, witnessSig, authorization }    │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ Q402 Backend (Next.js on Vercel)                             │
│   - /api/auth/*              email / Google / wallet auth    │
│   - /api/keys/*              provision / verify / rotate     │
│   - /api/payment/*           paid plan checkout              │
│   - /api/trial/activate      free trial signup               │
│   - /api/relay               EIP-7702 settlement gateway     │
│   - /api/transactions        per-account TX history          │
│                                                              │
│   - Vercel KV: subscriptions, api keys, quota counter,       │
│     tx history, gas deposits, webhooks, alerts               │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ Relayer hot wallet                                           │
│   - Submits Type 4 (EIP-7702) tx on the target chain         │
│   - User EOA temporarily executes the deployed               │
│     Q402PaymentImplementation contract code via              │
│     authorizationList delegation                             │
│   - transferWithAuthorization(...) moves the token           │
└──────────────────────────────────────────────────────────────┘
```

---

## Authentication model

- **API key** — identifies the caller, rate-limited per key + IP. Live (`q402_live_*`) and sandbox (`q402_test_*`) coexist on every account.
- **EIP-712 witness** (`TransferAuthorization`) — proves the user authorized this exact transfer (owner / facilitator / token / recipient / amount / nonce / deadline).
- **EIP-7702 authorization** — delegates the user's EOA to the Q402 impl contract for one TX. Signed via `wallet.authorize(...)` (ethers v6.16+).
- **Wallet binding** (optional) — links a wallet to an email account 1:1 via signed challenge. See `app/api/auth/wallet-bind/route.ts`.

---

## Tech stack

- Next.js 16.2 + React 19 + TypeScript
- Tailwind CSS, framer-motion
- ethers.js v6.16+ (EIP-7702 native via `Wallet.authorize`)
- Vercel KV (Upstash Redis) for KV-backed state
- viem on the relayer side for `sendTransaction({ authorizationList })`
- Hardened build: `next build --webpack` (Turbopack build has been observed to PageNotFoundError some API routes on Next 16.2)

---

## Repository layout

```
app/                  Next.js App Router
  api/                Backend routes (auth, keys, payment, relay, transactions, …)
  components/         Shared UI (Navbar, Footer, Hero, WalletButton, …)
  dashboard/          Authenticated dashboard surfaces
  event/              BNB-focus campaign page
  claude/             MCP-targeted explainer page
  docs/               Public developer docs
  lib/                Server + shared modules (relayer.ts, db.ts, session.ts, …)
public/
  q402-sdk.js         Browser-compatible client SDK
contracts.manifest.json   Single source of truth for chain × contract pinning
__tests__/            Vitest source + drift guards
mcp-server/           Standalone `@quackai/q402-mcp` package (separate repo, gitignored)
```

---

## Local development

```bash
git clone https://github.com/bitgett/Q402-Institutional.git
cd Q402-Institutional
npm install
cp .env.example .env.local   # fill in the values you actually have
npm run dev                  # → http://localhost:3000
```

Required env vars (the rest are optional / Vercel-managed):

| Var | What |
|---|---|
| `RELAYER_PRIVATE_KEY` | Hot wallet that submits relays + pays gas |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel KV |
| `GOOGLE_CLIENT_ID` + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth client (same value) |
| `RESEND_API_KEY`, `RESEND_FROM_ADDRESS` | Email magic-link sender |
| `CRON_SECRET` | Shared header that authorizes Vercel cron POSTs |

Full list with comments in `.env.example`. `.gitignore` blocks the `.env*` glob — never commit secrets.

---

## Tests

```bash
npm test               # vitest — source + behavior + drift guards
npx eslint . --max-warnings=0
npx next build --webpack
npm audit --omit=dev
```

Coverage: relay ordering, EIP-7702 signing, trial/paid scope isolation, gas-deposit dedup, identity state machine, and drift guards (`contracts.manifest.json` ↔ relayer, MCP package ↔ landing SDK).

---

## Wallet delegation (EIP-7702)

EIP-7702 lets your EOA settle gasless payments without a per-user smart-account deploy.
Persists across payments, reversible anytime.

- **MCP**: ask `"Show my Q402 wallet status"` or `"Clear my Q402 delegation on BNB Chain"`. Local signing; Q402 sponsors the clear TX.
- **CLI**:

  ```bash
  PRIVATE_KEY=0x<yourKey> node scripts/undelegate-7702.mjs \
    --chain <bnb|eth|avax|xlayer|stable|mantle|injective|monad|scroll|arbitrum>
  ```

Clearing is optional — the next payment recreates the delegation. Full guide: [docs#eip-7702-delegation](https://q402.quackai.ai/docs#eip-7702-delegation).

---

## Security highlights

- **Replay**: every settled tx hash is sealed in KV with `used_txhash:{hash}` (10y TTL). Same on-chain tx cannot be used to activate a subscription twice.
- **Authorization lock**: relay route pins `authorization.chainId` and `authorization.address` to `contracts.manifest.json` at request time — a client cannot smuggle a different impl contract.
- **Trial scope**: enforced by `keyRecord.plan`, not by the subscription's current plan. A paid user holding a legacy trial key still sees trial-scope policy (BNB only, trial expiry) on that key.
- **Identity 1:1**: wallet ↔ email is enforced bidirectionally via `wallet_email_link` + `email_to_wallet` indexes. Cross-session attempts to claim either side return `409`.
- **EIP-7702 spec**: authorization signatures use ethers' native `Wallet.authorize()` — protocol-correct RLP+keccak, validated by EVM ecrecover; no EIP-712 fallback.

---

## Roadmap

- **Multi-agent infrastructure**: one Q402 account, many delegated agent identities sharing a single Gas Tank. Each agent gets its own wallet, scoped spending policy, and isolated activity log. *(In planning.)*
- **Account merge**: pseudo-account ↔ wallet principal migration job. Today's read-side bridge keeps the UX clean; the migration physically consolidates the records.
- **Wallet recovery**: OTP-gated re-pair endpoint for lost-wallet cases. Today's flow is support-only.

---

## Links

- 📦 SDK: [public/q402-sdk.js](public/q402-sdk.js)
- 📦 MCP: https://www.npmjs.com/package/@quackai/q402-mcp
- 📖 Docs: https://q402.quackai.ai/docs
- 🌐 Live: https://q402.quackai.ai
- 🎟️ Free trial: https://q402.quackai.ai/event
- 📧 Contact: business@quackai.ai

---

© Quack AI. Apache-2.0 licensed (see [LICENSE](LICENSE)).
