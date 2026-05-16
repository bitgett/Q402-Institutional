# Q402 — Gasless Payments on EVM

> Pay USDC, USDT, or RLUSD across **7 EVM chains** with $0 in gas.
> Built on EIP-7702 + EIP-712. Callable from a browser, a Node.js
> backend, or any MCP-compatible AI client (Claude Desktop, Claude
> Code, Cline).

[![sdk](https://img.shields.io/badge/sdk-v1.7.2-yellow)](public/q402-sdk.js)
[![mcp](https://img.shields.io/badge/npm-@quackai/q402--mcp-blue)](https://www.npmjs.com/package/@quackai/q402-mcp)
[![chains](https://img.shields.io/badge/chains-7-green)](#supported-chains)

**Live**: https://q402.quackai.ai &nbsp;·&nbsp; **Free trial**: https://q402.quackai.ai/event &nbsp;·&nbsp; **Docs**: https://q402.quackai.ai/docs

---

## Why

On every EVM chain, users need to hold a native gas token (BNB, ETH, AVAX, OKB, MNT, INJ, USDT0) just to move USDC/USDT. A user holding $100 of USDC on BNB Chain cannot transfer anything without first acquiring BNB — that's where Web3 onboarding collapses. Q402 removes that step entirely: the sender signs an EIP-712 authorization off-chain, Q402's relayer submits the on-chain transaction and pays the gas, and the recipient receives 100% of the stablecoin.

The same primitive serves AI agents. Managing gas across multiple chains for many autonomous agents is operationally painful; one Q402 account covers all of them through a single API key.

---

## What it does

```
User signs EIP-712 off-chain
  → Q402 relayer submits Type 4 (EIP-7702) transaction
    → on-chain: USDC/USDT/RLUSD moves from sender to recipient
      → recipient receives 100%, sender pays $0
```

All seven chains share the same witness type, the same signing rule (`verifyingContract = user EOA`), and the same on-wire body shape. The chain-specific parts are the deployed implementation contract and the EIP-712 domain name.

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
| Injective EVM | 1776 | USDT | live |

RLUSD (Ripple USD, NY DFS regulated, 18 decimals) is Ethereum-only by issuer design. Native USDC on Injective EVM is announced for Q2 2026 via Circle CCTP and will be added when it ships.

---

## Three ways to use Q402

### 1. End user — the dashboard

Sign up at [q402.quackai.ai](https://q402.quackai.ai) with Google, email, or a wallet. The dashboard surfaces your live + sandbox API keys, transaction history, gas-tank balances, and (during the BNB-focus event) the free-trial credit gauge.

### 2. Web developer — the browser SDK

Drop the public SDK in any page that already has `window.ethereum`:

```html
<script src="https://q402.quackai.ai/q402-sdk.js"></script>
<script>
  const q402 = new Q402Client({ apiKey: "q402_live_…", chain: "bnb" });
  await q402.pay({ to: recipientAddress, amount: "10.00", token: "USDT" });
</script>
```

The SDK handles the EIP-712 signature, the EIP-7702 authorization, and the POST to `/api/relay`. The user signs once in their wallet; the recipient receives the full amount.

### 3. AI agent — the MCP server

```bash
npx -y @quackai/q402-mcp@latest
```

Add to your Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp@latest"],
      "env": {
        "Q402_API_KEY": "q402_live_…",
        "Q402_PRIVATE_KEY": "0x…",
        "Q402_ENABLE_REAL_PAYMENTS": "1"
      }
    }
  }
}
```

The agent can now `q402_quote` (compare gas across all 7 chains), `q402_balance` (verify key + remaining credits), `q402_pay` (send a real gasless transfer), and `q402_receipt` (fetch + cryptographically verify a Trust Receipt). Sandbox mode is the default — only the simultaneous presence of all three live-mode env vars switches `q402_pay` into real on-chain settlement.

---

## Free trial event

During the BNB-focus event window (currently 2026-05-19 → 2026-06-30), any developer can sign up at [/event](https://q402.quackai.ai/event) and immediately receive:

- 2,000 sponsored transactions on BNB Chain
- Both a live (`q402_live_*`) and a sandbox (`q402_test_*`) API key
- 30-day window from the moment of signup

Trial credits are real settlements — the relayer's hot wallet pays the gas, the recipient receives the full amount, and the trial counter atomically decrements on every transfer. After the trial window or once credits are exhausted, the same key keeps working under a paid plan with a self-funded Gas Tank.

The trial is BNB-Chain-only by server-side policy (`TRIAL_BNB_ONLY` gate). Paid keys see the full 7-chain matrix.

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

- **API key** identifies the caller; rate-limited per key and per IP. Live keys (`q402_live_*`) and sandbox keys (`q402_test_*`) live side-by-side on every account — sandbox returns mock results without touching the chain.
- **EIP-712 witness** (`TransferAuthorization`) proves the user authorized this specific transfer (owner / facilitator / token / recipient / amount / nonce / deadline).
- **EIP-7702 authorization** delegates the user's EOA to execute the Q402 implementation contract for this one tx. Signed with `wallet.authorize(...)` (ethers v6.16+) which produces the protocol-correct `keccak256(0x05 || rlp([chainId, address, nonce]))` signature.
- **Wallet binding** (optional, for email users) links a wallet to an email account 1:1 via a signed challenge. See the bind-once contract documented in `app/api/auth/wallet-bind/route.ts`.

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

`.env.example` carries the complete list with comments. Never commit `.env.local` / `.env.preview` — `.gitignore` excludes the broad `.env*` glob.

---

## Tests

```bash
npm test               # vitest — source + behavior + drift guards
npx eslint . --max-warnings=0
npx next build --webpack
npm audit --omit=dev
```

Test files cover relay route ordering, EIP-7702 signing shape, trial-vs-paid key scope isolation, gas-deposit dedup invariants, identity-model state machine, and several drift guards (`contracts.manifest.json` ↔ relayer, MCP package ↔ landing SDK).

---

## Security highlights

- **Replay**: every settled tx hash is sealed in KV with `used_txhash:{hash}` (10y TTL). Same on-chain tx cannot be used to activate a subscription twice.
- **Authorization lock**: relay route pins `authorization.chainId` and `authorization.address` to `contracts.manifest.json` at request time — a client cannot smuggle a different impl contract.
- **Trial scope**: enforced by `keyRecord.plan`, not by the subscription's current plan. A paid user holding a legacy trial key still sees trial-scope policy (BNB only, trial expiry) on that key.
- **Identity 1:1**: wallet ↔ email is enforced bidirectionally via `wallet_email_link` + `email_to_wallet` indexes. Cross-session attempts to claim either side return `409`.
- **EIP-7702 spec**: authorization signatures use ethers' native `Wallet.authorize()` — protocol-correct RLP+keccak, validated by EVM ecrecover; no EIP-712 fallback.
- **Source-grep regression tests** lock the shape of each of the above so a refactor that silently weakens any of them fails CI.

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
