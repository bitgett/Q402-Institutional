# Q402 — Gasless Payment Infrastructure

> Multi-chain ERC-20 gasless payment relay for DeFi applications and AI agents.  
> Users pay USDC/USDT with zero gas — Q402 relayer covers all transaction fees.

**Version: v1.3.1** · **Docs revision: v1.16** · **Last updated: 2026-04-17**  
**GitHub:** https://github.com/bitgett/Q402-Institutional  
**Live:** https://q402-institutional.vercel.app  
**Contact:** davidlee@quackai.ai

---

## Table of Contents

1. [Why We Built This](#1-why-we-built-this)
2. [What is Q402](#2-what-is-q402)
3. [Supported Chains](#3-supported-chains)
4. [Tech Stack](#4-tech-stack)
5. [Quick Start (Local Development)](#5-quick-start)
6. [Pages & Project Structure](#6-pages--project-structure)
7. [Payment Flow](#7-payment-flow)
8. [SDK Usage](#8-sdk-usage)
9. [API Reference](#9-api-reference)
10. [Authentication Model](#10-authentication-model)
11. [Subscription Plans & Rate Limits](#11-subscription-plans--rate-limits)
12. [KV Data Model](#12-kv-data-model)
13. [Relay Internals (EIP-7702 / EIP-3009)](#13-relay-internals)
14. [Webhook System](#14-webhook-system)
15. [Sandbox Mode](#15-sandbox-mode)
16. [Gas Tank](#16-gas-tank)
17. [v1.6 New Features](#17-v16-new-features)
18. [Stable Chain Integration](#18-stable-chain-integration)
19. [Contracts & Token Addresses](#19-contracts--token-addresses)
20. [Security (v1.2 Audit + Properties)](#20-security)
21. [Vercel Deployment](#21-vercel-deployment)
22. [Relayer Wallet](#22-relayer-wallet)
23. [Test Scripts & Agent SDK](#23-test-scripts--agent-sdk)
24. [Remaining Work / Roadmap](#24-remaining-work--roadmap)
25. [Changelog](#25-changelog)

---

## 1. Why We Built This

On every EVM chain, users need to hold a native gas token (BNB, ETH, AVAX, OKB, USDT0) just to move USDC/USDT.

> A user holding $100 of USDC on BNB Chain **cannot transfer anything without BNB.**  
> Web3 onboarding collapses right here.

**Four reasons Q402 exists:**

1. **Gas UX is what's blocking Web3 adoption.** Stripe, PayPal, and Venmo don't push fees onto users. Web3 needs to meet that bar.

2. **AI agents need a gasless payment rail.** Managing gas for 100 agents across 5 chains individually is an operational nightmare. One Gas Tank top-up covers all of them.

3. **EIP-7702 is the right primitive.** Unlike ERC-4337 (Account Abstraction), existing EOAs work as-is — no wallet migration required. MetaMask and OKX Wallet participate out of the box.

4. **Multi-chain on day one.** Most gasless solutions cover a single chain. Q402 ships on 5 mainnets simultaneously.

---

## 2. What is Q402

Q402 is **gasless payment infrastructure built on EIP-7702 + EIP-712**. Integrate the SDK and the Q402 relayer covers every on-chain gas fee on your behalf.

**All 5 chains — unified EIP-7702 flow:**
```
User clicks "Pay USDC"
  → SDK: GET /api/relay/info (fetch facilitator address)
    → EIP-712 TransferAuthorization witnessSig (verifyingContract = user EOA)
    → EIP-7702 authorization signature (2 sigs total)
      → POST /api/relay { witnessSig, authorization }
        → Q402 relayer: submit Type 4 TX (pays gas)
          → delegated Q402PaymentImplementation.transferWithAuthorization() runs
            → USDC/USDT(0): user EOA → recipient
```

> All 5 chains share the same witness type `TransferAuthorization(owner, facilitator, token, recipient, amount, nonce, deadline)`
> and the same `verifyingContract = user EOA` rule. The only per-chain differences are `domainName` (e.g. "Q402 Avalanche")
> and the impl address.
>
> X Layer additionally supports legacy EIP-3009 fallback — selected automatically when `eip3009Nonce` is passed (**USDC only**).

---

## 3. Supported Chains

| Chain | ChainID | Relay Method | Contract | Status |
|-------|---------|--------------|----------|--------|
| Avalanche C-Chain | 43114 | EIP-7702 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | ✅ |
| BNB Chain | 56 | EIP-7702 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | ✅ |
| Ethereum | 1 | EIP-7702 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | ✅ |
| X Layer | 196 | EIP-7702 + EIP-3009 USDC fallback | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | ✅ |
| **Stable** | **988** | **EIP-7702** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | ✅ |

> Stable is special: USDT0 is both the gas token and the payment token (native coin = USD-pegged).

> **Single source of truth**: per-chain contracts, domains, witness types, and token mappings
> are canonicalized in [`contracts.manifest.json`](./contracts.manifest.json).
> If server (`app/lib/relayer.ts`), SDK (`public/q402-sdk.js`), or this doc drifts,
> the manifest is authoritative, and `__tests__/contracts-manifest.test.ts` enforces consistency.

---

## 4. Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 App Router (React 19, TypeScript) |
| Styling | Tailwind CSS + framer-motion |
| Blockchain | ethers.js v6 + viem |
| Wallet | Custom WalletContext (MetaMask + OKX Wallet) |
| Database | Vercel KV (Redis) |
| Deployment | Vercel (git push → auto deploy) |
| Contract | Solidity 0.8.20, EIP-7702, EIP-712 |

---

## 5. Quick Start

### Clone & Install

```bash
git clone https://github.com/bitgett/Q402-Institutional.git
cd Q402-Institutional
npm install
```

### Environment Variables (`.env.local`)

```env
# Relayer wallet private key — never expose
RELAYER_PRIVATE_KEY=0x...   # DEPLOYER_PRIVATE_KEY from q402-avalanche/.env

# Contract addresses (v1.3). AVAX accepts the historical name `IMPLEMENTATION_CONTRACT` as well.
AVAX_IMPLEMENTATION_CONTRACT=0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c
BNB_IMPLEMENTATION_CONTRACT=0x6cF4aD62C208b6494a55a1494D497713ba013dFa
ETH_IMPLEMENTATION_CONTRACT=0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD
XLAYER_IMPLEMENTATION_CONTRACT=0x8D854436ab0426F5BC6Cc70865C90576AD523E73
STABLE_IMPLEMENTATION_CONTRACT=0x2fb2B2D110b6c5664e701666B3741240242bf350

# Vercel KV — copy from Vercel dashboard → Storage → Q402 KV
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...

# Admin endpoint protection
ADMIN_SECRET=your_admin_secret_here

# Optional: Telegram inquiry notifications
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Optional: for tests
TEST_PAYER_KEY=0x...
ETH_RPC_URL=https://eth.llamarpc.com
```

### Run Dev Server

```bash
npm run dev
# → http://localhost:3000 (falls back to 3001~3004 if the port is taken)
```

### Contract Deployment (when adding a new chain)

```bash
cd q402-avalanche/q402-avalanche
npm install
npx hardhat run scripts/deploy.ts --network avalanche
npx hardhat run scripts/deploy-bnb.ts --network bnb
npx hardhat run scripts/deploy-eth.ts --network eth
npx hardhat run scripts/deploy-xlayer.ts --network xlayer
npx hardhat run scripts/deploy-stable.ts --network stable
```

---

## 6. Pages & Project Structure

### Page Index

| Route | Description |
|-------|-------------|
| `/` | Landing — Hero, HowItWorks, Pricing, Contact |
| `/agents` | AI Agent plans — SVG network animation, live TX feed, Contact modal |
| `/payment` | 4-step on-chain payment → automatic API Key issuance |
| `/dashboard` | Developer dashboard (API Key, Gas Tank, Transactions, Webhook) |
| `/docs` | API Reference & integration guide |

### Directory Structure

```
Q402-Institutional/
├── app/
│   ├── api/
│   │   ├── payment/
│   │   │   ├── activate/route.ts   # POST — scan on-chain payment + issue API Key
│   │   │   └── check/route.ts      # POST — check subscription status
│   │   ├── keys/
│   │   │   ├── provision/route.ts  # POST — manually create subscription (Admin)
│   │   │   ├── generate/route.ts   # POST — reissue API Key (Admin)
│   │   │   ├── verify/route.ts     # POST — validate API Key
│   │   │   ├── topup/route.ts      # POST — add bonus credits (Admin)
│   │   │   └── rotate/route.ts     # POST — rotate API Key (EIP-191 auth)
│   │   ├── gas-tank/
│   │   │   ├── route.ts            # GET  — relayer on-chain balance
│   │   │   ├── verify-deposit/route.ts # POST — scan user deposits
│   │   │   ├── user-balance/route.ts   # GET  — user deposit balance
│   │   │   └── withdraw/route.ts   # POST — withdraw gas balance (Admin)
│   │   ├── relay/
│   │   │   ├── route.ts            # POST — EIP-7702 / EIP-3009 relay
│   │   │   └── info/route.ts       # GET  — facilitator address (for SDK)
│   │   ├── webhook/
│   │   │   ├── route.ts            # POST/GET/DELETE — webhook management
│   │   │   └── test/route.ts       # POST — send test event
│   │   ├── transactions/route.ts   # GET  — relay TX history
│   │   ├── wallet-balance/route.ts # GET  — user wallet balance (5 chains)
│   │   └── inquiry/route.ts        # POST/GET — project inquiries
│   ├── lib/
│   │   ├── db.ts                   # Vercel KV CRUD helpers (monthly TX sharding)
│   │   ├── blockchain.ts           # ERC-20 Transfer event scan
│   │   ├── relayer.ts              # viem EIP-7702 settle functions
│   │   ├── access.ts               # MASTER_ADDRESSES / isPaid()
│   │   ├── ratelimit.ts            # KV fixed-window rate limiter
│   │   └── wallet.ts               # MetaMask / OKX connectWallet
│   ├── context/WalletContext.tsx   # global wallet state (instant localStorage restore)
│   ├── components/
│   │   ├── Hero.tsx                # landing hero + terminal animation
│   │   ├── HowItWorks.tsx          # 3-step explainer + 5 chain logos
│   │   ├── Pricing.tsx             # pricing tiers
│   │   ├── Contact.tsx             # CTA — "Talk to Us" popup
│   │   ├── Navbar.tsx              # navigation + Agents link
│   │   ├── Footer.tsx              # 5+ chains, Stable badge
│   │   ├── WalletButton.tsx        # MetaMask + OKX wallet modal
│   │   └── RegisterModal.tsx       # project inquiry popup
│   ├── agents/page.tsx             # AI Agent plan page
│   ├── dashboard/page.tsx          # dashboard (4 tabs)
│   ├── payment/page.tsx            # on-chain payment Builder
│   ├── docs/page.tsx               # API Reference
│   └── page.tsx                    # landing
├── scripts/
│   ├── test-eip7702.mjs            # unified EIP-7702 E2E test (--chain avax|bnb|eth|xlayer|stable)
│   └── agent-example.mjs           # Node.js Agent SDK (unified 5-chain example — TransferAuthorization)
└── public/
    ├── q402-sdk.js                 # client SDK v1.3.1
    ├── bnb.png / eth.png / avax.png / xlayer.png / stable.jpg
    └── arbitrum.png / scroll.png
```

---

## 7. Payment Flow

The `/payment` page drives a self-serve on-chain checkout → automatic API Key issuance flow:

1. **Select chain** — which chain will you relay on? (prices vary per chain)
2. **Select TX count** — how many gasless transactions to purchase
3. **Connect wallet** — MetaMask or OKX Wallet
4. **Send + verify** — transfer USDC/USDT to the Q402 address (`0xfc77...`), click "Verify" → API Key issued automatically

**Billing model (v1.9):**
- **First purchase** → sets plan tier + grants TX credits + starts 30-day window
- **Subsequent purchases** → top up credits + extend 30 days (plan tier preserved, access days stack)
- TX credits decrement by 1 per successful relay. Service stops at expiry or when credits hit zero.

**Per-chain pricing (BNB baseline, with per-chain multipliers):**
| TX count | BNB/XLayer/Stable (1.0×) | AVAX (1.1×) | ETH (1.5×) |
|----------|--------------------------|-------------|------------|
| 500      | $30 | $30 | $40 |
| 1,000    | $50 | $50 | $70 |
| 5,000    | $90 | $100 | $130 |
| 10,000   | $150 | $160 | $220 |
| 50,000   | $450 | $490 | $670 |
| 100,000  | $800 | $880 | $1,200 |

Accepted payment tokens: **BNB USDC, BNB USDT, ETH USDC, ETH USDT** (subscription settlement is intentionally limited to BNB/ETH chains).  
Payment address: `0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` (SUBSCRIPTION cold wallet — revenue-only).

---

## 8. SDK Usage

### Browser

```html
<script src="https://q402-institutional.vercel.app/q402-sdk.js"></script>
<script src="https://cdn.ethers.io/lib/ethers-5.7.2.umd.min.js"></script>
```

```javascript
// AVAX / BNB / ETH / Stable — EIP-7702
const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
const result = await q402.pay({ to: "0xRecipient", amount: "5.00", token: "USDC" });
console.log(result.txHash); // method: "eip7702"

// X Layer — EIP-7702 (facilitator auto-resolved)
const q402xl = new Q402Client({ apiKey: "q402_live_xxx", chain: "xlayer" });
const result2 = await q402xl.pay({ to: "0xRecipient", amount: "1.00", token: "USDC" });
console.log(result2.txHash); // method: "eip7702_xlayer"

// Stable — token key is "USDT" (resolves to USDT0 on-chain), amount in USDT0 units
const q402s = new Q402Client({ apiKey: "q402_live_xxx", chain: "stable" });
const result3 = await q402s.pay({ to: "0xRecipient", amount: "10.00", token: "USDT" });
```

SDK: **v1.3.1** — supports all 5 chains (avax, bnb, eth, xlayer, stable).

> **⚠ `amount` parameter rule** — always pass a **human-readable decimal string** ("5.00", "0.123456").
> It is converted internally via `ethers.parseUnits(amount, decimals)`. Precision that exceeds the
> token's decimals (e.g. "5.1234567" for a 6-dec USDC) or numeric/exponential notation is rejected
> with an explicit throw. Passing a JS `Number` would lose IEEE-754 precision on 18-decimal tokens.

### Node.js Agent

Import `scripts/agent-example.mjs` as a module:

```javascript
import { sendGaslessPayment } from "./scripts/agent-example.mjs";

const result = await sendGaslessPayment({
  chain:      "avax",   // "avax" | "bnb" | "eth" | "xlayer" | "stable"
  recipient:  "0x...",
  amount:     "10.0",   // decimal string — Number is rejected (IEEE-754 safety)
});
console.log(result.txHash);
```

### SDK Internals

**All 5 chains — EIP-7702 (`method: "eip7702" | "eip7702_xlayer" | "eip7702_stable"`)**
```
q402.pay() invoked
  ├─ 0. GET /api/relay/info → facilitator address
  ├─ 1. EIP-712 witnessSig signature
  │      domain: { name: "Q402 <Chain>", version: "1", chainId, verifyingContract: user EOA }
  │      types:  TransferAuthorization { owner, facilitator, token, recipient, amount, nonce, deadline }
  ├─ 2. EIP-7702 authorization signature
  │      { address: implContract, nonce: EOA_nonce }
  └─ 3. POST /api/relay { witnessSig, authorization, <chain-specific nonce field> }
         avax/bnb/eth → nonce   |   xlayer → xlayerNonce   |   stable → stableNonce
```

**X Layer EIP-3009 fallback (USDC only)** — selected only when `eip3009Nonce` is supplied.

---

## 9. API Reference

### POST /api/relay

Submit an EIP-712 + EIP-7702 payload → gasless relay.  
Requires `apiKey`; validates subscription expiry and key rotation state.

**Common fields** (all chains):
- `token`: **symbol string** `"USDC"` or `"USDT"` — never an address. The server resolves the address via `CHAIN_CONFIG[chain][token]`.
- `amount`: atomic uint256 string (e.g. 0.05 USDC at 6 decimals → `"50000"`)
- `witnessSig`: EIP-712 TransferAuthorization signature
- `authorization`: EIP-7702 delegation proof `{ chainId, address, nonce, yParity, r, s }`
- **The nonce field name differs per chain** (see below).

**avax / bnb / eth request** (nonce field: `nonce`):
```json
{
  "apiKey":        "q402_live_xxx",
  "chain":         "avax",
  "token":         "USDC",
  "from":          "0xPayerEOA",
  "to":            "0xRecipient",
  "amount":        "50000",
  "deadline":      1712345678,
  "nonce":         "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 43114, "address": "0x96a8...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**xlayer EIP-7702 request** (nonce field: `xlayerNonce`):
```json
{
  "apiKey": "q402_live_xxx", "chain": "xlayer", "token": "USDC",
  "from": "0x...", "to": "0x...", "amount": "50000", "deadline": 1712345678,
  "xlayerNonce":   "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 196, "address": "0x8D85...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**stable EIP-7702 request** (nonce field: `stableNonce`; both "USDC" and "USDT" token symbols route to USDT0):
```json
{
  "apiKey": "q402_live_xxx", "chain": "stable", "token": "USDC",
  "from": "0x...", "to": "0x...", "amount": "50000000000000000", "deadline": 1712345678,
  "stableNonce":   "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 988, "address": "0x2fb2...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**xlayer EIP-3009 fallback:** send `eip3009Nonce` (bytes32 hex) instead of `authorization`/`xlayerNonce`. **USDC only** — USDT must use the EIP-7702 path.

> **Authorization lock (v1.3+)**: the server returns 400 unless `authorization.chainId` and
> `authorization.address` exactly match the official impl contract for that chain as declared
> in `contracts.manifest.json`.

**Response:**
```json
{
  "success":      true,
  "txHash":       "0x...",
  "blockNumber":  "54540550",
  "tokenAmount":  "5.0",
  "token":        "USDC",
  "chain":        "avax",
  "gasCostNative": 0.00042,
  "method":       "eip7702"
}
```
> `tokenAmount` is a **string** (`ethers.formatUnits` output) — not narrowed to a JS `number` so that precision is preserved for 18-decimal tokens (USDT0). Parse as a `string` and re-convert via `BigInt`, or treat as human-readable only.

> method values: `"eip7702"` / `"eip7702_xlayer"` / `"eip3009"`

### GET /api/relay/info

Returns the relayer (facilitator) wallet address. Required when signing X Layer EIP-7702 payloads.
```json
{ "facilitator": "0xfc77ff29178b7286a8ba703d7a70895ca74ff466" }
```

### POST /api/payment/activate

Scans the chain for an incoming USDC/USDT payment → activates subscription + issues API Key.  
**Prerequisite**: payment intent must be recorded via `POST /api/payment/intent`.  
**Auth**: requires a signed one-time fresh challenge (`GET /api/auth/challenge`).

```json
// request
{
  "address": "0x...",
  "challenge": "<value from GET /api/auth/challenge>",
  "signature": "0x...",
  "txHash": "0x..."   // optional — when provided, verifies a single TX directly instead of scanning blocks
}
// response (shared shape)
{
  "status": "activated",
  "plan": "starter",
  "addedTxs": 500,
  "totalTxs": 500,
  "expiresAt": "2026-05-13T00:00:00.000Z"
}
```
- First purchase: sets `plan` + grants `addedTxs` + starts the 30-day window
- Subsequent purchases: preserve existing `plan` + accumulate `totalTxs` + extend by 30 days
- The challenge is single-use (consumed after one call — prevents replay)

### POST /api/payment/check

Check subscription status.

### POST /api/inquiry

Submit a project inquiry → stored in Vercel KV + Telegram notification.

```json
{
  "appName": "MyDApp", "website": "https://...", "email": "dev@...",
  "telegram": "@handle", "category": "DeFi", "targetChain": "avax",
  "expectedVolume": "1000-5000", "description": "..."
}
```

### POST /api/keys/verify

Validate API Key, check expiry/rotation state.
```json
{ "valid": true, "address": "0x...", "plan": "growth", "expired": false, "expiresAt": "..." }
```

### POST /api/keys/rotate

Revoke the current live key and issue a new one. Requires an EIP-191 signature.

### Admin-only (header: `x-admin-secret`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/keys/provision` | POST | Manually create subscription + issue API Key |
| `/api/keys/generate` | POST | Reissue API Key |
| `/api/keys/topup` | POST | Add bonus credits |
| `/api/gas-tank/withdraw` | POST | Withdraw gas balance |
| `/api/inquiry` | GET | List inquiries |

---

## 10. Authentication Model

**Hybrid EIP-191 personal_sign** — session nonce (1h TTL) + fresh challenge for high-risk actions:

```
Signed message: "Q402 Auth\nAddress: {address_lowercase}\nNonce: {nonce}"
nonce: GET /api/auth/nonce?address=0x...  → { nonce, expiresIn: 3600 }
```

**Flow:**
1. `GET /api/auth/nonce?address=0x...` → server persists nonce in KV (1h TTL — `app/lib/auth.ts` `NONCE_TTL_SEC`).
2. Client signs → cached in `sessionStorage["q402_auth_0xaddr"]` as `{nonce, signature}` (55-minute TTL, 5 minutes shorter than the server TTL to avoid race — `app/lib/auth-client.ts` `CLIENT_NONCE_TTL_MS`).
3. Every protected request carries `{address, nonce, signature}`.
4. Server: `verifyNonceSignature(addr, nonce, sig)` — KV nonce check + ECDSA verify.
5. On 401 `NONCE_EXPIRED`: client clears the cache → the next request re-signs.

**After key rotation**, call `invalidateNonce(addr)` → the next sensitive request is forced to re-sign.

**Protected endpoints:**
- `POST`: `/api/keys/provision`, `/api/keys/rotate`, `/api/payment/activate`, `/api/payment/intent`
- `POST`: `/api/webhook` (create/update/delete), `/api/webhook/test`
- `GET` (query string): `/api/transactions?address=&nonce=&sig=`, `/api/webhook?address=&nonce=&sig=`

---

## 11. Subscription Plans & Rate Limits

### TX Credit Model (v1.9)

A subscription is managed by three values: **plan tier + remaining TX credits + expiration date**.

- **Plan tier**: set based on the amount of your first purchase; cannot change after that.
  - Plan only affects the daily burst cap (Gas Tank fairness).
- **TX credits**: added with every purchase. Each successful relay consumes 1. Returns 429 at 0.
- **Expiration**: extended by +30 days per purchase (days stack if you renew before expiry).

| Plan (based on first payment) | TX Credits | Daily Burst Cap |
|-------------------------------|------------|-----------------|
| Starter ($30~) | 500 | 50/day |
| Basic ($50~) | 1,000 | 100/day |
| Growth ($90~) | 5,000 | 1,000/day |
| Pro ($150~) | 10,000 | 1,000/day |
| Scale ($450~) | 50,000 | 10,000/day |
| Business ($800~) | 100,000 | 10,000/day |
| Enterprise Flex ($2,000~) | 500,000 | Unlimited |
| **Agent** | **Unlimited** | **Unlimited** | Gas Tank prepaid, see `/agents` |

Daily cap exceeded: `HTTP 429 Daily relay cap reached for plan {plan}` (86400s window).  
TX credits exhausted: `HTTP 429 No TX credits remaining`.  
Sandbox keys are exempt from caps and credits.

### API Rate Limits

| Endpoint | Per IP | Per API Key |
|----------|--------|-------------|
| /api/relay | 60 req/60s | **30 req/60s** (added in v1.8) |
| /api/keys/provision | 10 req/60s |
| /api/keys/rotate | 5 req/60s |
| /api/payment/activate | 5 req/60s |
| /api/payment/check | 30 req/60s |
| /api/transactions | 30 req/60s |
| /api/webhook | 10 req/60s |
| /api/inquiry | 3 req/600s |
| /api/inquiry (GET admin) | **5 req/60s** (added in v1.9) |
| /api/grant (GET admin) | **5 req/60s** (added in v1.9) |
| /api/gas-tank/withdraw | **5 req/60s** (added in v1.9) |
| /api/gas-tank/user-balance | 30 req/60s (added in v1.9) |

---

## 12. KV Data Model

**Vercel KV (Redis)** — `app/lib/db.ts`

### Key Schema

```
kv.get("sub:{address}")                  → Subscription
kv.get("apikey:{apiKey}")                → ApiKeyRecord
kv.get("gasdep:{address}")               → GasDeposit[]
kv.get("relaytx:{address}:{YYYY-MM}")    → RelayedTx[]   ← monthly shard (v1.6)
kv.get("gasused:{address}")              → Record<chain, number>  ← running totals (v1.6)
kv.get("webhook:{address}")              → WebhookConfig
kv.get("inquiries")                      → Inquiry[]
```

**KV capacity strategy (v1.6):**
- TX history: sharded by month under `relaytx:{addr}:{YYYY-MM}` — capped at 10,000 per month (relay continues, recording stops if exceeded).
- Gas usage: `gasused:{addr}` kept as a running total — no need to scan the full TX array.
- **Credit check (v1.9):** single predicate `subscription.quotaBonus > 0` (no monthly count required).
- Balance computation: `getGasBalance()` → 2 reads (deposit array + running totals).

### Data Structures

**Subscription**
```json
{
  "paidAt":        "2026-04-09T00:00:00.000Z",  // anchor for expiry (refreshed per purchase)
  "apiKey":        "q402_live_xxx",
  "sandboxApiKey": "q402_test_xxx",
  "plan":          "growth",                     // set on first purchase, immutable afterwards
  "txHash":        "0xOnChainPaymentTxHash",     // most recent payment TX
  "amountUSD":     150,
  "quotaBonus":    9850                          // remaining TX credits (-1 per relay)
}
```
> `paidAt` + 30 days = expiry. Each purchase extends the current expiry by 30 days.  
> `quotaBonus` = remaining relayable TX count. Relay returns 429 at 0 or below.

**ApiKeyRecord**
```json
{
  "address":   "0xOwnerAddress",
  "createdAt": "2026-04-09T00:00:00.000Z",
  "active":    true,
  "plan":      "growth",
  "isSandbox": false
}
```

**RelayedTx**
```json
{
  "apiKey":        "q402_live_xxx",
  "address":       "0xOwner",
  "chain":         "avax",
  "fromUser":      "0xPayer",
  "toUser":        "0xRecipient",
  "tokenAmount":   "5.0",
  "tokenSymbol":   "USDC",
  "gasCostNative": 0.00042,
  "relayTxHash":   "0x...",
  "relayedAt":     "2026-04-09T12:00:00.000Z"
}
```

### DB Helper Functions

| Function | Role |
|----------|------|
| `getSubscription(address)` | Fetch subscription |
| `setSubscription(address, data)` | Save/update subscription |
| `getApiKeyRecord(apiKey)` | API Key → record |
| `generateApiKey(address, plan)` | Issue new live key |
| `generateSandboxKey(address, plan)` | Issue new sandbox key |
| `deactivateApiKey(apiKey)` | Deactivate key |
| `rotateApiKey(address)` | Revoke existing key + issue new + update sub |
| `getGasDeposits(address)` | List deposit events |
| `addGasDeposit(address, deposit)` | Record deposit (txHash dedup) |
| `getGasBalance(address)` | Sum deposits − sum usage = current balance |
| `getRelayedTxs(address, months?)` | Relay history (default: current + previous month) |
| `getThisMonthTxCount(address)` | Current-month TX count (O(1) quota check) |
| `getGasUsedTotals(address)` | Per-chain cumulative gas usage |
| `recordRelayedTx(address, tx)` | Record TX (update monthly shard + running total atomically) |
| `getWebhookConfig(address)` | Fetch webhook config |
| `setWebhookConfig(address, config)` | Save webhook config |
| `addQuotaBonus(address, n)` | Add bonus credits |
| `isSubscriptionActive(address)` | Subscription validity check |
| `getPlanQuota(plan)` | Per-plan monthly quota |

---

## 13. Relay Internals

### 13-A. EIP-7702 (shared across all 5 chains)

```
User EOA ──(EIP-7702 authorization)──▶ Q402PaymentImplementation
                                         When .transferWithAuthorization() runs,
                                         address(this) inside _domainSeparator()
                                         resolves to the user's EOA (hence verifyingContract = EOA)
```

**EIP-712 domain (uniform rule across all 5 chains):**
```javascript
{
  name:              "Q402 Avalanche",   // per chain: Avalanche | BNB Chain | Ethereum | X Layer | Stable
  version:           "1",
  chainId:           43114,              // per chain
  verifyingContract: userEOA,            // ⭐ same for every chain — NEVER the impl address
}

// types — identical across all 5 chains
TransferAuthorization: [
  { name: "owner",       type: "address" },
  { name: "facilitator", type: "address" },
  { name: "token",       type: "address" },
  { name: "recipient",   type: "address" },
  { name: "amount",      type: "uint256" },
  { name: "nonce",       type: "uint256" },
  { name: "deadline",    type: "uint256" },
]
```

**Contract-side invariants:**
- `owner == address(this)` check (Owner Binding, addresses P0 audit finding)
- `msg.sender == facilitator` check (Unauthorized Facilitator defense, addresses P1 audit finding)
- `usedNonces[owner][nonce]` mapping prevents replay
- `_domainSeparator()` uses `address(this)` → resolves to user EOA under EIP-7702 delegation

**viem Type 4 TX submission (`app/lib/relayer.ts`):**
```typescript
const txHash = await walletClient.sendTransaction({
  chain: null,
  to:   params.owner,                    // user EOA
  data: callData,                        // transferWithAuthorization() calldata
  gas:  BigInt(300000),
  authorizationList: [{ ...params.authorization }],
});
```

**Gas cost calculation:**
```typescript
const gasCostNative = parseFloat(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));
```

### 13-B. Per-chain Differences

| Item | avax / bnb / eth | xlayer | stable |
|------|------------------|--------|--------|
| Contract class | `Q402PaymentImplementation` | `Q402PaymentImplementationXLayer` | `Q402PaymentImplementationStable` |
| Entry function | `transferWithAuthorization()` | `transferWithAuthorization()` | `transferWithAuthorization()` |
| Witness type | TransferAuthorization | TransferAuthorization | TransferAuthorization |
| `verifyingContract` | User EOA | User EOA | User EOA |
| Domain name | "Q402 Avalanche" / "Q402 BNB Chain" / "Q402 Ethereum" | "Q402 X Layer" | "Q402 Stable" |
| EIP-3009 fallback | ✗ | ✓ (USDC only, legacy) | ✗ |
| Relay API `method` | `"eip7702"` | `"eip7702_xlayer"` / `"eip3009"` | `"eip7702_stable"` |

> Historical note: prior to v1.3.0 the docs claimed avax/bnb/eth used a separate `PaymentWitness` type,
> but the actually deployed contracts all use the unified `TransferAuthorization` + `_domainSeparator(address(this))`
> scheme. The v1.14 docs revision aligned the SDK, manifest, tests, and docs with that deployment reality.

**Verified X Layer EIP-7702 test result (2026-03-12):**

| Item | Value |
|------|-------|
| TX Hash | `0xd121c23c6313e2f73751b3735f5a9c934386930ef1ca0ba04578de1bfddfd9a0` |
| Block | 54540550 |
| Payer OKB | 0 OKB ✅ |
| USDC transferred | 0.05 USDC ✅ |

### 13-C. EIP-3009 (xlayer fallback)

Selected automatically when `eip3009Nonce` (bytes32) is provided. Backwards-compatible with SDK v1.1.x.

```json
{
  "chain": "xlayer",
  "witnessSig": "0x...",
  "eip3009Nonce": "0xrandomBytes32..."
}
```

**Verified EIP-3009 test result (2026-03-12):**
- TX: `0xb21a10be318e7893d9246ae49a141c18152040b1ceb68eb3e799b62c953fbc3c`
- Block: 54523313 / USDC transferred: 0.05 ✅

### 13-D. Processing Steps (shared)

1. Validate API Key (`getApiKeyRecord`, `active` flag).
2. Check subscription expiry + key rotation state (30-day expiry, `sub.apiKey !== apiKey` → 401).
3. **Daily burst cap** check (per-plan KV fixed window, 86400s) — v1.6.
4. **TX credit check** (`subscription.quotaBonus > 0`, else 429) — v1.9.
5. Gas Tank balance check (`getGasBalance[chain] > 0.0001`).
6. Chain dispatch:
   - xlayer + `authorization+xlayerNonce` → `settlePaymentXLayerEIP7702()`
   - xlayer + `eip3009Nonce` → `settlePaymentEIP3009()`
   - other → `settlePayment()`
7. Record TX (`recordRelayedTx` — monthly shard + running total) + **decrement credit by 1** (fire-and-forget).
8. Dispatch webhook (if registered).

---

## 14. Webhook System

Every successful relay TX dispatches an HMAC-SHA256 signed event to the registered endpoint.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhook` | Register URL (secret is returned only on first registration) |
| GET | `/api/webhook?address=0x&sig=0x` | Read current config (secret not included) |
| DELETE | `/api/webhook` | Remove config |
| POST | `/api/webhook/test` | Send a test event |

### Payload

```json
{
  "event":        "relay.success",
  "sandbox":      false,
  "txHash":       "0x...",
  "chain":        "avax",
  "from":         "0xUSER",
  "to":           "0xRECIPIENT",
  "amount":       5.0,
  "token":        "USDC",
  "gasCostNative": 0.00042,
  "timestamp":    "2026-04-09T12:00:00.000Z"
}
```

### Signature Verification (Node.js)

```javascript
const hmac = crypto.createHmac('sha256', process.env.Q402_WEBHOOK_SECRET);
hmac.update(rawBody);
const valid = 'sha256=' + hmac.digest('hex') === req.headers['x-q402-signature'];
```

### SSRF Defense

Validated on registration, test, and dispatch (hardened in v1.8):
```
RFC-1918:       10.x, 172.16-31.x, 192.168.x, 127.x, localhost, 0.0.0.0
IPv6 internal:  ::1, ::ffff:, fe80:, fc00:, fd__:
Cloud metadata: metadata.google.internal, 169.254.169.254, fd00:ec2::254
Octal IP:       rejects forms like 0177.0.0.1
Production:     non-HTTPS (HTTP) blocked
```

---

## 15. Sandbox Mode

API Keys prefixed with `q402_test_` return mock responses without submitting any on-chain TX.

```javascript
const q402 = new Q402Client({ apiKey: "q402_test_xxx", chain: "avax" });
const result = await q402.pay({ to: "0x...", amount: "5.00", token: "USDC" });
// result.success = true, result.txHash = random mock hash
// No gas consumption, no on-chain TX
```

- `/api/keys/provision` issues a sandbox key alongside the live key automatically.
- Relay detects `isSandbox`: returns a mock response after a 400 ms delay.
- DB record includes `sandbox: true`.
- Sandbox keys are exempt from daily caps.

---

## 16. Gas Tank

### Platform-wide Relayer Balance (shared)

`GET /api/gas-tank` — live on-chain balance of the relayer wallets.

```json
{
  "tanks": [
    { "key": "bnb",   "chain": "BNB Chain", "token": "BNB",  "balance": "1.2340", "usd": "$865.31" },
    { "key": "eth",   "chain": "Ethereum",  "token": "ETH",  "balance": "0.1200", "usd": "$456.00" },
    { "key": "avax",  "chain": "Avalanche", "token": "AVAX", "balance": "25.4000","usd": "$812.80" },
    { "key": "xlayer","chain": "X Layer",   "token": "OKB",  "balance": "0.0000", "usd": "$0.00"   }
  ]
}
```

### Per-User Deposit Balance

Users deposit native tokens to the **GASTANK** cold address (`GASTANK_ADDRESS`) → consumed against relay costs. The relayer hot wallet is a separate address; GASTANK→RELAYER transfers are performed manually or via an operator script.

**Deposit scan (default):** `POST /api/gas-tank/verify-deposit` — `{ address }`
- Batch RPC block scan across all 5 chains (BNB/AVAX/XLayer: 200 blocks, ETH: 50 blocks, Stable: 500 blocks).
- Filter `from=user, to=GASTANK, value≠0` → `addGasDeposit()`.
- Users who come back outside the scan window (~10 minutes on ETH, up to tens of minutes elsewhere) are not credited by this path — use the direct-lookup path below.

**Deposit direct lookup (recovery path):** `POST /api/gas-tank/verify-deposit` — `{ address, txHash, chain }`
- `chain`: `"bnb" | "eth" | "avax" | "xlayer" | "stable"`.
- Validates a single TX via `eth_getTransactionByHash` (confirmed + `to=GASTANK` + `from=address` + `value>0`).
- Works outside the block window. Duplicate txHashes are rejected automatically by `addGasDeposit`'s SADD guard (`alreadyCredited: true`).
- Surfaced in the dashboard Deposit modal's "not_found" state.

**Balance read:** `GET /api/gas-tank/user-balance?address=0x...&nonce=...&sig=0x...`

> **Auth required since v1.17 (Q402-SEC-003):** requires a session nonce + EIP-191 signature. Closes the prior anonymous `?address=` path that let anyone read another wallet's Q402 gas-tank posture (per-chain balance + deposit history). Obtain a nonce via `GET /api/auth/nonce?address={addr}`; signature verification follows the same `requireAuth()` path as `/api/transactions` and `/api/webhook`.

```json
{
  "balances": { "bnb": 0.5, "eth": 0.0, "avax": 2.1, "xlayer": 0.0, "stable": 0.0 },
  "deposits": [...]
}
```

**Balance computation:**
```
getGasBalance(address) = Σ(deposits.amount) − Σ(gasused running total)
```

> v1.6: the separate `gasused:{addr}` running-total key enables O(1) computation without scanning the array.

**Stable-chain note:** USDT0 is both the gas token and the payment token. Gas Tank top-ups on Stable must be in USDT0 (no native coin).

---

## 17. v1.6 New Features

### A. Monthly Sharding of KV TX History

**Problem:** a single `relayedtxs:{address}` array would exceed KV's 1 MB write limit once a high-traffic customer accumulated thousands of rows.

**Solution:**
- `relaytx:{addr}:{YYYY-MM}` — one key per month.
- Cap at 10,000 records per month (recording stops beyond the cap; relay continues).
- Separate `gasused:{addr}` running-total key → O(1) gas balance computation.

### B. Preserve API Key on Renewal

**Problem:** renewals always issued a new key → instantly broke existing integrations.

**Solution:**
- Keep the existing key on renewal (issue a new one only when `active=false`).
- Expiry: extend by +30 days from the current expiry (days stack when renewed before expiry).

```typescript
// Renewal before expiry → current expiry + 30 days
const currentExpiry = new Date(new Date(existing.paidAt).getTime() + 30*24*60*60*1000);
const base = currentExpiry > new Date() ? currentExpiry : new Date();
newPaidAt = base.toISOString();
```

### C. Per-Plan Daily Relay Burst Cap

**Problem:** a Starter key could submit tens of thousands of TXs per day → monopolizes the shared relayer.

**Solution:** KV fixed window (86400s) with per-plan daily caps (see §11).

### D. Test Scripts

| File | Description |
|------|-------------|
| `scripts/test-eip7702.mjs` | Unified EIP-7702 E2E test — `--chain avax\|bnb\|eth\|xlayer\|stable` |
| `scripts/agent-example.mjs` | Node.js Agent SDK — unified 5-chain example (TransferAuthorization + module export) |

---

## 18. Stable Chain Integration

### Why Q402 on Stable

Stable is a Layer 1 where USDT0 is the native gas token. In an AI agent ecosystem this means:
- No per-agent USDT0 balance bookkeeping overhead.
- A single Gas Tank can cover hundreds of agents.
- USD-pegged gas → predictable relayer operating cost (no volatility).

### Network Info

| Item | Mainnet (used) | Testnet |
|------|----------------|---------|
| Chain ID | `988` | `2201` |
| RPC | `https://rpc.stable.xyz` | `https://rpc.testnet.stable.xyz` |
| Explorer | `https://stablescan.org` | `https://testnet.stablescan.xyz` |
| Gas token | USDT0 (18 dec) | USDT0 |
| USDT0 address | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | `0x78Cf24370174180738C5B8E352B6D14c83a6c9A9` |

### Deployed Contracts

| Network | Address |
|---------|---------|
| Stable Mainnet (988) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| Stable Testnet (2201) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |

> Identical address — same deployer address + nonce, deterministic deployment.

### EIP-712 Domain

```javascript
{
  name:              "Q402 Stable",
  version:           "1",
  chainId:           988,
  verifyingContract: userEOA,   // shared across all 5 chains — _domainSeparator uses address(this)
}
```

### Partnership

- Partner: Stable team (Eunice, @eunicecyl)
- Announcement: joint Twitter post on 2026-04-04 ✅
- Mainnet deployment complete: 2026-04-04 ✅
- Contract verification: ✅ verified on stablescan.xyz (2026-04-13)

---

## 19. Contracts & Token Addresses

### Relay Contracts

| Chain | ChainID | Address | EIP-712 NAME | Verified |
|-------|---------|---------|--------------|----------|
| Avalanche | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | Q402 Avalanche | ✅ Routescan |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | Q402 BNB Chain | ✅ Sourcify |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | Q402 Ethereum | ✅ Sourcify |
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | Q402 X Layer | ✅ OKLink |
| **Stable** | **988** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Q402 Stable | ✅ Stablescan |

### Token Addresses

#### Avalanche
| Token | Address | Dec |
|-------|---------|-----|
| USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 |
| USDT | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | 6 |

#### BNB Chain
| Token | Address | Dec | Notes |
|-------|---------|-----|-------|
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | Binance-peg, no EIP-2612 |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 | |

#### Ethereum
| Token | Address | Dec |
|-------|---------|-----|
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |

#### X Layer
| Token | Address | Dec | Notes |
|-------|---------|-----|-------|
| USDC | `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | 6 | Supports EIP-2612 + EIP-3009 |
| USDT | `0x1E4a5963aBFD975d8c9021ce480b42188849D41D` | 6 | |

#### Stable
| Token | Address | Dec | Notes |
|-------|---------|-----|-------|
| USDT0 | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | 18 | Both `USDC` and `USDT` API keys resolve to this address |

### Contract ABI Summary (shared across all 5 chains)

```solidity
// Executed from an EIP-7702-delegated EOA — msg.sender = facilitator (relayer), address(this) = owner (user EOA)
function transferWithAuthorization(
  address owner,            // payer EOA (must equal address(this))
  address facilitator,      // relayer address (must equal msg.sender)
  address token,            // USDC/USDT (USDT0 on Stable) address
  address recipient,        // recipient
  uint256 amount,           // atomic (per-chain decimals)
  uint256 nonce,            // random uint256 (usedNonces mapping guards replay)
  uint256 deadline,         // expiration timestamp
  bytes calldata witnessSignature  // EIP-712 TransferAuthorization signature
) external;
```

---

## 20. Security

### Security Properties

| Property | Implementation |
|----------|----------------|
| API Key ownership proof | EIP-191 personal_sign (provision/rotate/transactions/activate/user-balance) |
| Replay prevention | `usedNonces[owner][nonce]` on-chain mapping |
| Owner Binding | `owner != address(this)` → `OwnerMismatch()` revert |
| Facilitator check | `msg.sender != facilitator` → `UnauthorizedFacilitator()` revert (xlayer) |
| SSRF defense | Webhook URL registration/dispatch blocks RFC-1918 + IPv6 internal + cloud metadata |
| Rate limiting | KV fixed-window per IP **and per API key** (/api/relay: 30 req/60s per key) |
| Error surface | Internal errors stay in server logs; clients receive generic messages |
| Sandbox isolation | Trust only the KV `isSandbox` flag — key-prefix bypass blocked. Webhook dispatch is live-only (v1.17, Q402-SEC-002) |
| TX reuse prevention | `used_txhash:{hash}` KV flag (90-day TTL) — the same TX cannot reactivate twice |
| Webhook integrity | HMAC-SHA256 on every outbound payload |
| ECDSA hardening | Enforced low-s + zero-address check |

### v1.17 Security Audit Record (2026-04-18, external reviewer)

Pre-launch 3rd-party review. 3 findings raised; all fixed with regression tests landed.

**[P0] Q402-SEC-001 — Relay check-ordering bug (High)**  
`loadRelayerKey()` ran after `decrementCredit()`. A misconfigured `RELAYER_PRIVATE_KEY` would return 503 while credits/daily-cap had already been decremented → silent quota drain for every caller.
- Fix: reorder as `chain → auth lock → gas tank → loadRelayerKey → dailyCap → decrement → relay` ([`app/api/relay/route.ts`](app/api/relay/route.ts), section 6a).
- Regression: [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts) with 9 landmark assertions.

**[P0] Q402-SEC-002 — Sandbox webhook forgery (Medium, Priority High)**  
Sandbox relays fabricate txHash/blockNumber yet still emitted HMAC-signed `relay.success` webhooks → a sandbox key could be used to forge signature-valid "settlement" events.
- Fix: `webhookCfg = isSandbox ? null : await getWebhookConfig(...)` ([`app/api/relay/route.ts`](app/api/relay/route.ts)).
- Regression: final 2 assertions in [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts).

**[P1] Q402-SEC-003 — Anonymous gas-tank posture read (Low-Medium)**  
`GET /api/gas-tank/user-balance?address=0x...` was unauthenticated; anyone could trivially scrape another wallet's balance + deposit history.
- Fix: added `requireAuth(address, nonce, sig)` ([`app/api/gas-tank/user-balance/route.ts`](app/api/gas-tank/user-balance/route.ts)) + dashboard caller uses `getAuthCreds()` ([`app/dashboard/page.tsx`](app/dashboard/page.tsx)).
- Regression: [`__tests__/user-balance-auth.test.ts`](__tests__/user-balance-auth.test.ts) with 5 assertions.

---

### v1.2 Security Audit Record (2026-03-23, Marin)

**[P0] Missing Owner Binding — Critical**  
`transferWithAuthorization` did not check `owner != address(this)` → arbitrary third-party assets could be moved.
```solidity
if (owner == address(0)) revert InvalidOwner();
if (owner != address(this)) revert OwnerMismatch();
```

**[P1] Facilitator Not Verified — High**  
No `msg.sender == facilitator` check → an intercepted payload could be executed by a third party.
```solidity
if (msg.sender != facilitator) revert UnauthorizedFacilitator();
```

**[P2-A] ECDSA Hardening — Medium**  
Added zero-address check after `ecrecover` + low-s malleability defense.

**[P2-B] EIP-7702 Context Caveat Documented**  
`address(this)` differs inside `domainSeparator()`/`hashTransferAuthorization()` when executed under delegation → added `@dev WARNING` comments.

**v1.2 redeploy:** all 4 chains redeployed; verified on Sourcify / Routescan / OKLink.

---

## 21. Vercel Deployment

```bash
npm install -g vercel
cd Q402-Institutional
vercel link --project q402-institutional --scope bitgett-7677s-projects --yes

# Example: add an env var
echo "0xAddress" | vercel env add STABLE_IMPLEMENTATION_CONTRACT production

# Deploys happen automatically on git push
git push origin main
```

---

## 22. Operational Wallets — 3-Role Separation (v1.16+)

Three wallets, three roles, zero commingling. The split ensures a single key compromise cannot drain revenue and user deposits at once.

| Role | Address | Key Storage | Responsibility |
|------|---------|-------------|----------------|
| `SUBSCRIPTION_ADDRESS` | `0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` | **Cold** (no key on server) | Receives subscription payments ($29/$49/$149…). Periodically swept manually from a cold device. |
| `GASTANK_ADDRESS`      | `0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a` | **Cold** (no key on server) | Receives user gas deposits (BNB/ETH/AVAX/OKB/USDT0). Cold→hot top-ups to the relayer are done manually. |
| `RELAYER_ADDRESS`      | `0xfc77ff29178b7286a8ba703d7a70895ca74ff466` | **Hot** (Vercel `RELAYER_PRIVATE_KEY`) | Signs/submits EIP-7702 TXs. Holds only a minimal operational float (BNB/ETH/AVAX/OKB/USDT0). |

The constants are exported from a single module ([`app/lib/wallets.ts`](app/lib/wallets.ts)) — every route/page imports only from there.

### Core Security Invariants

1. **`RELAYER_ADDRESS` never receives user funds.** Gas deposits go to `GASTANK_ADDRESS`, subscription payments go to `SUBSCRIPTION_ADDRESS`. A server compromise only exposes the RELAYER's operational gas float.
2. **`GASTANK_ADDRESS`'s private key is never placed in Vercel env.** Cold signing only — user withdrawals (`/api/gas-tank/withdraw`) are record-only: the operator signs from a cold device and records the txHash on the server.
3. **On-chain GASTANK balance == sum(KV `gas:` ledger)** per chain. Verified periodically via [`scripts/migrate-split-wallets.mjs`](scripts/migrate-split-wallets.mjs).
4. **`RELAYER_ADDRESS` constant == address derived from `RELAYER_PRIVATE_KEY`.** `loadRelayerKey()` in `app/lib/relayer-key.ts` verifies this immediately before every signing call; fail-closed with 503 on mismatch. Regression: [`__tests__/relayer-key.test.ts`](__tests__/relayer-key.test.ts).

### Known Limitation — Per-User Gas Custody

This split protects the **aggregate user gas pool** (held in the cold GASTANK), but **per-user balance attribution** is still managed via the KV ledger (`gas:<userAddr>` keys). If KV is lost / corrupted / written without authorization:
- It may become impossible to tell which portion of the on-chain GASTANK balance belongs to which user.
- An individual user's recorded balance could be inflated or deflated independently of on-chain reality.

**Total liability vs on-chain GASTANK balance** can be verified from chain history (via script). But **per-user balance reconstruction** requires re-scanning every deposit/relay event from chain logs. There are no per-user on-chain subaccounts today. Introducing a CREATE2 vault per user is an intentional non-goal at the current TVL — see §22 tradeoffs for the cost/benefit analysis.

### Alerts

`/api/cron/gas-alert` → `/api/gas-tank?check_alerts=1` (requires admin secret) monitors the RELAYER hot balance and fires a Telegram alert below the operational threshold. When alerted, the operator tops up cold (GASTANK) → hot (RELAYER).

### Master Accounts (always treated as paid)
```
0xfc77ff29178b7286a8ba703d7a70895ca74ff466  (RELAYER hot)
0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28  (Owner)
0x3717d6ed5c2bce558e715cda158023db6705fd47  (Owner)
```
Hardcoded in the `MASTER_ADDRESSES` array of `app/lib/access.ts` — Quote page / dashboard whitelist.

---

## 23. Test Scripts & Agent SDK

```bash
# Unified EIP-7702 E2E test — pick a chain
node scripts/test-eip7702.mjs --chain avax   [--amount 0.05] [--to 0x...]
node scripts/test-eip7702.mjs --chain bnb
node scripts/test-eip7702.mjs --chain eth
node scripts/test-eip7702.mjs --chain xlayer
node scripts/test-eip7702.mjs --chain stable

# 5-chain Agent SDK example (unified TransferAuthorization flow)
node scripts/agent-example.mjs
```

`agent-example.mjs` can be imported as a module:
```javascript
import { sendGaslessPayment, CHAINS } from "./scripts/agent-example.mjs";

// Single payment — amount MUST be a **string** (Number is rejected, IEEE-754 safety)
await sendGaslessPayment({ chain: "bnb", recipient: "0x...", amount: "10.0" });

// Multi-chain sequential payments
for (const chain of ["avax", "bnb", "eth"]) {
  await sendGaslessPayment({ chain, recipient: "0x...", amount: "0.05" });
}
```

Env vars: `Q402_API_KEY` and `TEST_PAYER_KEY` required in `.env.local`.

---

## 24. Remaining Work / Roadmap

| Item | Status | Priority |
|------|--------|----------|
| Stable contract verification | ✅ stablescan.xyz complete (2026-04-13) | Done |
| Gas Tank top-up (all chains low) | BNB / ETH / AVAX / XLayer / Stable running low | Immediate |
| quackai.ai/q402 domain wiring | Not done | Medium |
| Webhook retry on failure | fire-and-forget | Medium |
| Per-project dedicated relayer address | Single global wallet | High (P1) |
| SDK npm package | CDN file only | Low |
| Automated tests (Jest/Vitest) | Vitest — `__tests__/` 8 files / 122 tests (contracts-manifest · relay-body-shape · auth · blockchain · intent · quote · rotate · ratelimit) | Done |
| PostgreSQL migration | Vercel KV is sufficient | Low |
| Gas Tank auto top-up | UI toggle exists, logic unimplemented | Medium |

---

## 25. Changelog

### v1.17 (2026-04-18)

> **External security review response — Q402-SEC-001 / Q402-SEC-002 / Q402-SEC-003.** All 3 findings from the external reviewer (2026-04-18) pinned down. Canonical flow (5 chains + TransferAuthorization witness + decimal-string `amount`) unchanged. Only the check ordering, sandbox isolation, and anonymous read blocking were modified.

#### Pre-launch 3rd-party security audit response

**[P0] Q402-SEC-001 — Relay check ordering rework blocks silent quota drain (`app/api/relay/route.ts`)**
- Before: if `loadRelayerKey()` failed after `decrementCredit()`, the handler returned 503 but the credit/daily-cap had already been decremented — meaning a misconfigured `RELAYER_PRIVATE_KEY` would silently drain every caller's quota.
- Fix: reorder as `chain validation → auth lock → gas tank funding → loadRelayerKey() → daily cap → decrementCredit → relay`. Charging only happens after relay infrastructure is confirmed operational.
- New section 6a (`app/api/relay/route.ts`):
  ```ts
  // Q402-SEC-001: verify relay infra is usable BEFORE charging.
  let relayerAddress: Address = "0x" as Address;
  if (!isSandbox) {
    const key = loadRelayerKey();
    if (!key.ok) return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
    relayerAddress = key.address as Address;
  }
  ```
- Regression test: [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts) — 9 invariants via source grep for landmark order (CHAIN_CFG → AUTH_LOCK → GAS_TANK → LOAD_RELAYER_KEY → DAILY_CAP → DECREMENT → RELAY_CALLS). Any future refactor that reorders these will be blocked by the suite.

**[P0] Q402-SEC-002 — Sandbox webhook dispatch fully blocked (`app/api/relay/route.ts`)**
- Before: sandbox relays (which fabricate txHash/blockNumber) still emitted HMAC-signed `relay.success` webhooks — a sandbox key holder could forge "signature-valid settlement events". Downstream accounting that trusts HMAC alone could be poisoned with phantom revenue.
- Fix: guard `getWebhookConfig()` itself with `isSandbox ? null : ...` — sandbox never even reads webhook config. Prevents accidental regression at later dispatch steps.
- Regression test: [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts) last 2 assertions — exact match on `webhookCfg = isSandbox ? null : await getWebhookConfig` + ban on prior "sandbox included" phrasings.

**[P1] Q402-SEC-003 — `/api/gas-tank/user-balance` anonymous read blocked (`app/api/gas-tank/user-balance/route.ts`)**
- Before: anyone with `?address=0x...` could read an arbitrary wallet's Q402 gas-tank posture (per-chain balance + deposit txHash history) without limit. While the underlying data is partly derivable from on-chain GASTANK logs, the **address → Q402 customer** mapping was trivially scrapeable at 30 req/60s.
- Fix: `requireAuth(address, nonce, sig)` inserted right after rate-limit, before balance reads. Same nonce+signature path as `/api/transactions` and `/api/webhook` (1h session-nonce TTL, `getAuthCreds()` cache).
- Dashboard call site updated ([`app/dashboard/page.tsx`](app/dashboard/page.tsx)): `refreshUserBalance()` now async, reuses cached session nonce via `getAuthCreds(addr, signMessage)` → wallet popup fires only on first use, subsequent refresh/polling is silent. Cache invalidates on `NONCE_EXPIRED`.
- Regression test: [`__tests__/user-balance-auth.test.ts`](__tests__/user-balance-auth.test.ts) — 5 assertions covering requireAuth import, nonce/sig query parsing, `authResult` running before `getGasBalance()`/`getGasDeposits()`, error status propagation, and per-IP rate-limit retained as defense-in-depth.

**Verification**: `npx vitest run` — 169/169 pass (155 prior + 14 new). `npm run lint` clean. `npm run build` ✓ 4.3s. Existing v1.15~v1.16 infrastructure constraints preserved (webpack-pinned build, opengraph Node runtime, etc.).

#### Severity calibration (documented)

| Finding | Reviewer | Internal | Rationale |
|---------|----------|----------|-----------|
| Q402-SEC-001 | High | **High** accepted | Silent quota drain → refund storm + trust collapse. Low trigger bar (env typo). |
| Q402-SEC-002 | High | **Medium, Priority High** | Accounting-poisoning risk for sandbox webhook consumers. No real fund movement (sandbox is simulated). Fix cost low → applied immediately. |
| Q402-SEC-003 | Medium | **Low-Medium** | Data is partly derivable from on-chain GASTANK logs, but removing trivial address→customer mapping and zero-cost scraping is still worthwhile. Also aligns with `/api/transactions` auth model. |

---

### v1.16 (2026-04-17)

> **Canonical flow unchanged from v1.15:** 5 chains + TransferAuthorization witness + decimal-string `amount`. v1.16 focused on user-visible surface (SSRF defense, wallet flows, UI cleanup) as part of pre-launch hardening.

#### Pre-launch audit response — SSRF hardening / UX fixes / dead code removal

Following the v1.15 pipeline cleanup, a full module-by-module audit (payment, API, SDK, UI, config) was run to resolve every remaining pre-launch issue. 56 findings → 15 actual changes.

**[P0] Webhook SSRF defense overhaul — `app/lib/webhook-validator.ts` + new `app/lib/safe-fetch.ts`**
- Closed six bypass paths the previous validator missed:
  - 2-/3-octet short-form IPv4 (`127.1`, `10.0.1`) — rejected by a numeric-only host regex.
  - DNS wildcard services: `nip.io`, `sslip.io`, `xip.io`, `traefik.me`, `localtest.me`.
  - Post-DNS-resolution re-check: reject if the resolved IP is private/loopback (`validateWebhookUrlResolved`).
  - IPv6-embedded IPv4 (`::ffff:127.0.0.1`) and cloud-metadata IPv6 (`fd00:ec2::254`).
  - Added AWS/GCP/Alibaba metadata hosts (`metadata.google.internal`, `100.100.100.200`).
- New `safeWebhookFetch()`: single entry point for every webhook call. `redirect: "manual"` blocks following the redirect chain, plus pre-resolve DNS validation. Shared by `/api/webhook/test` and `/api/relay` (dispatchWebhook).
- `/api/webhook/test`: on failure, returns a generalized `"Webhook delivery failed"` (no internal error leakage). Original error is logged via `console.error` server-side only.

**[P0] `RegisterModal` payment flow fix — `app/components/RegisterModal.tsx`**
- Step 1 "Connect Wallet (MetaMask)" → "Choose Wallet" using the shared `WalletModal` → OKX wallet support.
- Removed the false "WalletConnect coming soon" text.
- Rewrote `handlePay()`: obtains nonce + signature via `getAuthCreds()`, then calls `/api/keys/provision`. Step 3 shows a `role="alert"` error UI per failure case (signature rejected, server error, network error).
- Guard the `step` state transition with `useRef` so it advances to step 2 when async connection completes (previously users had to click "Next" again after wallet connect).

**[P1] Shared `WalletModal` component extracted — new `app/components/WalletModal.tsx`**
- Unified the duplicated MetaMask-only modals that `WalletButton` and `payment/page.tsx` each maintained.
- Added a11y attributes: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`.
- ESC-key close + focus management (useRef/useEffect).
- OKX icon unified to the real `/okx.jpg` logo (`payment/page.tsx` had been using a generic grid SVG).
- `onConnected?: (address: string) => void` callback so the parent can advance steps immediately after connection.

**[P1] Removed Gas Tank "Auto Top-up" toggle — `app/dashboard/page.tsx`**
- Dead UI; the feature was never implemented (toggle only, refills are still manual). Gave users a false impression of "auto-refilled".
- Removed `autoTopup` state + UI block + active badge. Will re-add once actually implemented.

**[P1] Footer X Layer brand color unified — `app/components/Footer.tsx`**
- `#7B61FF` (purple, unrelated to the brand) → `#CCCCCC` (silver, the actual X Layer logo color). Consistent with Hero / payment / docs.

**[P1] Dead code cleanup — removed `app/lib/access.ts` + `WalletContext.isPaidUser`**
- `access.ts`: legacy paywall leftover. `isPaid()` always returned true, `setPaid()` was a no-op, 0 imports.
- `WalletContext.isPaidUser`: all consumers had been removed but the field lingered in the type → removed from both type and provider.

**[P2] Code-comment currency — `app/lib/relayer.ts`**
- Header comment `v1.2` → `v1.3` reflecting the 5-chain unification (stable included).
- `transferWithAuthorization()` comments `v1.2+` → `v1.3`; calldata encoding comments synced.

**[P0] 3-role operational wallet split — new `app/lib/wallets.ts` + 6 routes/pages migrated**
- Before: a single wallet `0xfc77ff29...c466` handled (a) subscription revenue, (b) user gas deposits, (c) hot relayer signing — three roles commingled. A Vercel env key compromise would expose revenue + deposits + operational gas with a single key.
- New split (see §22 for details):
  - `SUBSCRIPTION_ADDRESS = 0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` (cold, revenue-only)
  - `GASTANK_ADDRESS      = 0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a` (cold, user gas deposits)
  - `RELAYER_ADDRESS      = 0xfc77ff29...c466` (hot, EIP-7702 signing only)
- Files changed:
  - `app/payment/page.tsx` — display address for subscription payments → `SUBSCRIPTION_ADDRESS`.
  - `app/lib/blockchain.ts` — subscription-payment scanner target → `SUBSCRIPTION_ADDRESS` (`Transfer(from, SUBSCRIPTION)` filter).
  - `app/api/gas-tank/route.ts` — dashboard reads GASTANK balance; Telegram alerts monitor the RELAYER hot balance (separated).
  - `app/api/gas-tank/verify-deposit/route.ts` — user-deposit scanner target → `GASTANK_ADDRESS`.
  - `app/api/gas-tank/withdraw/route.ts` — **redesigned as record-only**. Removed prior auto-sign-from-RELAYER logic. Operators send GASTANK→user from a cold device, then POST the txHash; the server verifies on-chain (from=GASTANK, to=user, value>0, status=1) before decrementing the KV ledger. Verification failure → rejected; duplicate txHash → 409.
  - `app/dashboard/page.tsx` — Deposit modal display address → `GASTANK_ADDRESS`, labeled "Q402 Gas Tank Address".
- New `scripts/migrate-split-wallets.mjs` — read-only migration plan. Computes per-chain (legacy balance − KV gas liability − operating reserve) and prints a transfer spec for the operator to sign from a cold device. Holds no keys, broadcasts nothing.
- **Invariant**: `RELAYER` never receives user funds. A server compromise only exposes RELAYER's small operational gas float — revenue and deposits remain safe.

**Verification**: `pnpm lint && pnpm build && pnpm test` all green. Added 10 new webhook-validator regression cases (nip.io, 2-octet IPv4, metadata host, DNS resolve). Existing 138 tests all pass.

### v1.15 (2026-04-17)

> **Canonical flow (v1.15):** all 5 chains use the `TransferAuthorization` witness + `amount` parameter (decimal string only). Terms like `PaymentWitness`, `paymentId`, `amountUSD` that appear in older changelog entries below are **legacy** and do not exist in the current code.

#### Production hardening — Next 16 / React 19 / lint pipeline / SDK amount precision / legacy-field removal

Pre-launch cleanup done the same day as the v1.14 chain unification. Brought the compile/lint pipeline up to current-generation tooling, started rejecting legacy inputs that the relay contract no longer uses, and removed all floating-point paths from SDK amount conversion.

**[P0] SDK amount conversion precision restored — `public/q402-sdk.js` (commit `85c8851`)**
- Before: `BigInt(Math.round(parseFloat(amount) * 10 ** decimals))` — IEEE-754 double only preserves 15~17 significant digits, so on 18-dec tokens (BNB USDC/USDT, Stable USDT0) dust was silently rounded, e.g. `"1.000000000000000001"` → `1000000000000000000`.
- Fix: extracted a `toRawAmount(amount, decimals)` helper → precise decimal-string parsing via `ethers.parseUnits`.
- Stricter input validation: throws a human-readable error for empty / whitespace / non-decimal / exponential / signed / 0 / negative / precision-above-token-decimals inputs.
- Behavior change (breaking for misuse): precision-overrun inputs that used to be silently rounded (e.g. `"5.1234567"` on 6-dec USDC) now raise an explicit error. Public API (`pay()`, relay payload shape) unchanged.
- `__tests__/sdk-amount.test.ts` pins 14 cases against regression (5 precision + 9 validation).

**[P1] Legacy `paymentId` field removed from `/api/relay` (commit `749aec4`)**
- SDK v1.3+ uses `nonce` (uint256 string) only — no active caller for months.
- Replaced the server's silent `paymentId → keccak-truncate` fallback with an explicit 400 rejection (`"paymentId is deprecated — upgrade SDK (v1.3+) to use nonce"`).
- Added 2 assertions in `__tests__/relay-body-shape.test.ts` that block fallback revival.

**[P1] Next.js 14.2 → 16.2 upgrade + React 18 → 19 (commits `e88880e`, `5c5a7c7`)**
- `next` 14.2.35 → 16.2.4, `react` / `react-dom` 18 → 19.
- React 19 rule compliance: hoisted `Spinner` out of `DepositModal` scope (`no-component-definition-in-render`); refactored `useEffect` setState cascades in the payment flow into derived state (`set-state-in-effect`).
- Replaced `<a>` with `next/link` for internal route prefetching (dashboard / Navbar / docs / grant).
- `tsconfig.json` auto-rewrites from Next 16 (`jsx: "react-jsx"`, `.next/dev/types/**/*.ts`).
- Pinned the build to `next build --webpack` (Turbopack build throws `PageNotFoundError` on some API routes — dev keeps Turbopack).
- Switched `opengraph-image.tsx` runtime from `edge` → `nodejs`: the Next 16 / React 19 bundle exceeded Vercel's Edge Function 1 MB limit (1.06 MB), and OG image generation is not latency-sensitive.

**[P2] ESLint pipeline restored + 22 latent warnings cleaned (commit `103773a`)**
- Next 16 removed `next lint` → the `lint` script now runs `eslint .`.
- Migrated `.eslintrc.json` (legacy) → `eslint.config.mjs` (flat config, required by ESLint 9).
- Pinned ESLint to 9 because ESLint 10 removes `context.getFilename()`, which `eslint-plugin-react` relies on (and `eslint-config-next@16`'s peer range).
- Tolerate intentional unused params with `argsIgnorePattern: "^_"` + `varsIgnorePattern: "^_"`.
- Cleared 22 latent warnings (unused vars, deprecated patterns) — lint output is now 0 issues.
- Bumped the picomatch vulnerability flagged by `npm audit` to dev-only.

**[P3] Vercel KV — retained**
- `@vercel/kv` shows a deprecation warning but works correctly on the current platform. It has been in production for several days, so there is no immediate migration pressure. Captured as a roadmap item only (see "Remaining Work" below).

Commit order: `e88880e` Next 16 upgrade → `5c5a7c7` OG runtime fix → `103773a` lint recovery → `749aec4` paymentId rejection → `85c8851` SDK amount precision. 138/138 tests pass, webpack build clean.

### v1.14 (2026-04-17)

> **⚠ Below is a historical record from v1.14.** Terms like `PaymentWitness` and `paymentId` were removed in v1.14 and do not exist in the current code.

#### 5-chain unification — single TransferAuthorization witness + user-EOA verifyingContract

By reading the deployed Q402PaymentImplementation bytecode directly, we confirmed that all 5 chains (avax/bnb/eth/xlayer/stable) use the same witness type `TransferAuthorization(owner, facilitator, token, recipient, amount, nonce, deadline)` and the same `_domainSeparator() → address(this)` scheme. Under EIP-7702 delegation, `address(this)` resolves to the user's EOA, so every chain's `verifyingContract` is the user EOA.

Earlier docs/SDK/tests claimed avax/bnb/eth used a separate `PaymentWitness` type with `verifyingContract = impl` — that path does not exist in the deployed contracts. v1.14 realigned the entire codebase to this deployment reality.

**[P0] `public/q402-sdk.js` unification**
- Removed three type definitions: `Q402_WITNESS_TYPES` / `Q402_XLAYER_TRANSFER_TYPES` / `Q402_STABLE_TRANSFER_TYPES`.
- Replaced with a single `Q402_TRANSFER_AUTH_TYPES` (shared across all 5 chains).
- Pinned `verifyingContract` to `owner` (user EOA) on every chain; only `domainName` differs per chain.
- Unified domain + witness across `_payEIP7702()` / `_payStableEIP7702()` / `_payXLayerEIP7702()`.

**[P0] `contracts.manifest.json` corrected**
- Changed `witness.verifyingContractRule` for avax/bnb/eth/stable from `implContract` → `userEOA`.
- Added explicit `domainName` per chain (`Q402 Avalanche` / `Q402 BNB Chain` / `Q402 Ethereum` / `Q402 X Layer` / `Q402 Stable`).
- Manifest note states: "verifyingContract = user's own EOA under EIP-7702 delegation".

**[P0] `__tests__/contracts-manifest.test.ts` strengthened**
- Asserts `witness.type === "TransferAuthorization"` + `verifyingContractRule === "userEOA"` for all 5 chains.
- Verifies each chain's `domainName` is embedded in the SDK source.
- Negative test: fails if legacy `PaymentWitness` / `Q402_WITNESS_TYPES` keywords remain anywhere in the SDK.
- 112/112 tests pass (`tsc --noEmit` clean)

**[P1] `app/docs/page.tsx` EIP-712 section rewritten**
- Dropped per-chain split specs → unified into a single spec shared across 5 chains
- Pinned `verifyingContract` in signing examples to `userAddress`

**[P1] `scripts/` fully replaced**
- Deleted: `test-bnb-eip7702.mjs` / `test-eth-eip7702.mjs` / `test-xlayer-eip7702.mjs` / `test-relay.mjs` (all used the old PaymentWitness + old X Layer impl address)
- New: `scripts/test-eip7702.mjs` — covers all 5 chains via a single `--chain <key>` CLI arg
  - Corrected X Layer impl `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` (not the old `0x31E9D105...`)
  - Corrected Stable RPC `https://rpc.stable.xyz` + USDT0 token `0x779ded0c9e1022225f8e0630b35a9b54be713736` (18 dec)
- Rewritten: `scripts/agent-example.mjs` — removed `isXLayer` branching, unified TransferAuthorization scheme + correct Stable address

**[P2] `app/lib/relayer.ts` comments corrected**
- Runtime code was already correct (8-param `transferWithAuthorization` + facilitator/nonce); no code change
- Only stale comments referencing PaymentWitness were updated to describe TransferAuthorization

**Audit note — "left as is"**
- `authorizationGuard` (server verifies chainId + impl address match) — already working correctly, no change
- X Layer's separate `xlayerNonce` field — retained for legacy API compatibility (server treats it identically to `nonce`)

Commit: `6cbb406 unify all 5 chains on single TransferAuthorization + user-EOA verifyingContract`

### v1.13 (2026-04-16)

#### Full audit hardening — tier consistency + per-layer atomicity + security model documentation

**[P1] Credit tier UI ↔ server consistency restored**
- `app/payment/page.tsx` VOLUMES updated
  - `{ label: "100K~500K", value: 300_000, basePrice: 1999 }` → `{ label: "500,000", value: 500_000, basePrice: 1999 }`
  - `{ label: "500K+", value: 500_000, basePrice: 0 }` → `{ label: "500K+", value: 1_000_000, basePrice: 0 }`
  - Simplified the Enterprise gate inside `calcPrice` to a single `basePrice === 0` condition
  - Shifted the UI threshold `>= 500_000` → `>= 1_000_000` (server `TIER_CREDITS[6] = 500_000` unchanged)
- Why: the server grants 500K credits on a $1999 payment but the UI showed a "100K~500K" range — UI realigned to match the server's grant

**[P2] Relay daily cap refund — atomicity on credit underflow**
- `app/api/relay/route.ts`
  - If `decrementCredit()` fails, restore the already-charged `dailyCapCharged` counter via `refundRateLimit(dailyCapKey, "daily", 86400)`
  - Closes the race where requests with zero credits consumed the daily cap
- Why: credit race conditions were pre-burning the daily cap, causing legitimate users to hit 429 early

**[P2] Admin keys generate — safe rotation order**
- `app/api/keys/generate/route.ts`
  - Before: deactivate old key → issue new key → update subscription (lockout on old-key failure)
  - Now: issue new key → update subscription → deactivate old key (fire-and-forget)
  - Matches the public rotate endpoint's order (`app/lib/db.ts` `rotateApiKey`)
- Why: "dangling-active > lockout" — prevents lockout incidents caused by reversed ordering

**[P2] Grant applications — race removed via RPUSH**
- `app/api/grant/route.ts`
  - POST: `kv.get + kv.set` read-modify-write → `kv.rpush("grant_applications", application)` (atomic)
  - GET: reads via `kv.lrange("grant_applications", 0, -1)`, keeps legacy JSON-array fallback
  - Legacy `kv.get/kv.set` path preserved in the catch block — zero-downtime migration
- Why: concurrent submissions were being lost to last-write-wins

**[P3] Gas tank verify-deposit — security model documented**
- `app/api/gas-tank/verify-deposit/route.ts`
  - Added a security-model comment to the top of the POST handler:
    - Rationale for not requiring a signature (addGasDeposit SADDs txHash to dedupe; only real on-chain TXs are recorded)
    - An attacker calling with another address still only reflects that user's real deposits → no privilege escalation or forgery
    - Rate limit 5/60s fail-closed prevents public-RPC abuse

**[P3] Payment intent route cleanup**
- `app/api/payment/intent/route.ts`
  - `planChain` comment: "for display/reference" → "determines plan/credit thresholds; falls back to chain if omitted"
  - Error message `Unsupported plan chain: ${chain}` → `${planChainResolved}` (reflects the actually-validated value)
- Why: clears up legacy wording left behind after the planChain split

**[P3] Payment security copy updated**
- `app/payment/page.tsx`
  - "Pay in USDC / USDT on BNB or Ethereum" → "Pay in USDC / USDT on BNB Chain or Ethereum — credits apply to your selected plan chain (BNB · AVAX · ETH · X Layer · Stable)"
- Why: communicates the new model where intent/activate decouple planChain from payment chain

**Items the audit left as is**
- `api/cron/gas-alert` cron's internal fetch self-call — negligible execution cost, keeps caller-auth separation
- `rateLimit` fail-open default — keeps the critical payment path up during KV outages; only admin/payment endpoints are explicitly fail-closed
- `verify-deposit` no-signature design — rationale documented in the P3 above

### v1.12 (2026-04-15)

#### P0 security hardening — nonce-based auth + sandbox-only provisioning + payment intent

**[P0] Nonce-based EIP-191 auth system (all endpoints)**
- New `app/lib/auth.ts` — server-side nonce core
  - `createOrGetNonce(addr)` — stored in KV `auth_nonce:{addr}` with a 1-hour TTL, idempotent (`NONCE_TTL_SEC = 60 * 60`)
  - `verifyNonceSignature(addr, nonce, sig)` — signed message: `"Q402 Auth\nAddress: {addr}\nNonce: {nonce}"`
  - `invalidateNonce(addr)` — forces a re-sign after key rotation
  - `requireAuth(address, nonce, signature)` — shared helper used by every protected route
- New `app/lib/auth-client.ts` — client-side nonce cache
  - `getAuthCreds(addr, signFn)` — sessionStorage cache for 55 minutes (`CLIENT_NONCE_TTL_MS`), expires 5 minutes before the server's 1h → avoids races, limits wallet popup to once per session
  - `clearAuthCache(addr)` — called when a NONCE_EXPIRED response is received
- New `app/api/auth/nonce/route.ts` — `GET /api/auth/nonce?address=0x...`
  - 20 req/60s rate limit, fail-closed

**[P0] New accounts only get a sandbox key (live key is issued only by activate after payment)**
- `app/api/keys/provision/route.ts` refactored
  - Replaced the old static signature (`Q402 API Key Request\nAddress: {addr}`) with `requireAuth()`
  - New accounts: `apiKey: null`, `sandboxApiKey: "q402_test_..."`, `hasPaid: false`
  - Existing paid accounts: live key returned normally

**[P1] Payment intent — bind chain + amount before payment**
- New `app/api/payment/intent/route.ts` — `POST /api/payment/intent`
  - body: `{address, nonce, signature, chain, expectedUSD}`
  - Intent stored in KV with a 2-hour TTL (`payment_intent:{addr}`)
- `app/api/payment/activate/route.ts` updated
  - Missing intent → 402 (`NO_INTENT` code)
  - Detected TX's chain differs from intent → 402 (`CHAIN_MISMATCH`)
  - Paid amount < 95% of intent → 402 (`AMOUNT_LOW`)
  - `clearPaymentIntent(addr)` — intent is deleted on successful activation (replay protection)
- `app/lib/blockchain.ts` — `checkPaymentOnChain(from, intentChain?)` gains an optional chain filter

**Remaining server routes migrated to nonce auth:**
- `app/api/keys/rotate/route.ts` — `requireAuth()` + `invalidateNonce(addr)` after rotation
- `app/api/transactions/route.ts` — GET params now include `nonce`
- `app/api/webhook/route.ts` (GET/POST/DELETE) — GET uses a query-param nonce, POST/DELETE use the body
- `app/api/webhook/test/route.ts` — swapped to `requireAuth()`

**Frontend (dashboard, payment)**
- `app/dashboard/page.tsx` — swept away the `q402_sig_*` sessionStorage pattern in favor of `getAuthCreds()`
  - provision, transactions, webhook GET, rotateKey, saveWebhook, testWebhook all updated
  - On 401 NONCE_EXPIRED → `clearAuthCache()` triggers an automatic re-sign on the next load
  - Handles `apiKey: null` responses (unpaid accounts no longer display a live key)
- `app/payment/page.tsx` — swapped to `getAuthCreds()` + POSTs intent before activate

### v1.11 (2026-04-15)

#### Codex second-audit fixes
- **Fix [P2]**: `/api/inquiry` KV storage — switched from `get→set` array pattern to Redis `rpush/lrange` (prevents last-write-wins loss on concurrent submissions)
- **Docs [P1]**: `docs/page.tsx` Quick Start code fixed
  - `Q402.sign()` (never existed) → `new Q402Client({apiKey, chain}).pay({to, amount, token})`
  - amount format: atomic units `"50000000"` → human-readable `"50.00"`
  - 2-step flow (sign + backend relay) → unified into a single `pay()` call the SDK handles end-to-end
- **Docs [P1]**: EIP-712 witness types clarified per chain
  - avax/bnb/eth: `PaymentWitness` (6 fields: owner, token, amount, to, deadline, paymentId)
  - xlayer/stable: `TransferAuthorization` (7 fields: owner, facilitator, token, recipient, amount, nonce, deadline)
- **Docs**: version badge `v1.7.0 → v1.10`, `QUOTA_EXCEEDED` error code updated for the TX-credits model, Gas Pool alert email → Telegram

### v1.10 (2026-04-15)

#### Security audit fixes (Codex audit response)
- **Security [P0]**: Free-provisioned accounts now use an empty `paidAt` string — blocks misuse of `isSubscriptionActive()`
  - `relay/route.ts`: expiry check only applies to paid accounts with `amountUSD > 0 && paidAt`; sandbox skipped
  - `payment/check/route.ts`: free accounts return `not_found` (routes them to the payment page)
  - `db.ts`: defensive handling for empty `paidAt` in `isSubscriptionActive()` / `getSubscriptionExpiry()`
- **Security [P1]**: Added `failOpen` parameter to rate limit — `/api/relay` and `/api/gas-tank/verify-deposit` are fail-closed (block on KV outage)
- **Fix [P1]**: Gas Tank withdraw now awaits `tx.wait(1)` — debits balance only after a 1-confirmation receipt (prevents dropped-TX loss)
- **Fix [P2]**: Dashboard `PLAN_QUOTA` starter `1_000 → 500`, and the missing plans (basic/pro/scale/business/enterprise_flex) were added
- **Fix [P3]**: `/api/gas-tank/verify-deposit` `newDeposits` count fixed — uses `addGasDeposit()`'s return value to exclude duplicate TXs

### v1.9 (2026-04-13)

#### Payment model overhaul
- **Refactor**: Introduced the TX-credits model — every payment adds +30 days + N TX credits (plan tier is locked at the first payment)
- **Refactor**: `blockchain.ts` — added `txQuotaFromAmount(usd, chain)` with per-chain price thresholds
- **Refactor**: `activate/route.ts` — dropped the first/additional branching; unified into a single path
- **Refactor**: `relay/route.ts` — replaced the monthly quota check with a `quotaBonus > 0` credit check; decrements 1 credit on success
- **Fix**: Removed the payment page's auto-redirect — existing subscribers can make additional purchases
- **UI**: Payment page copy updated — "+30 days · N TXs per payment"

#### Stricter per-chain price validation
- **Fix**: Added a chain parameter to `planFromAmount()` / `txQuotaFromAmount()`
  - BNB / XLayer / Stable 1.0×, AVAX 1.1×, ETH 1.5×
  - Fixed the bug where a $30 payment on ETH passed under the BNB threshold ($30) — ETH threshold now applied at $39

#### Security audit fixes (2026-04-13)
- **Security**: `TEST_MODE` env var fully removed — deleted from `.env.local` and Vercel production; removed the `planFromAmount()` bypass
- **Security**: Added rate limits on admin endpoints — `GET /api/grant`, `GET /api/inquiry`, `POST /api/gas-tank/withdraw` all 5 req/60s per IP (before admin-secret check)
- **Fix**: `/api/gas-tank/user-balance` parameter changed from `?apiKey=` → `?address=` (stops API key leakage in URL; fixes the Gas Tank $0 bug)

### v1.8 (2026-04-13)

#### Security fixes
- **Security**: Fully removed the `TEST_MODE` backdoor — eliminated the `$1 → starter` bypass in `planFromAmount()`
- **Security**: Fixed sandbox-key detection — no longer trusts the key prefix (`q402_test_`); relies solely on the KV `isSandbox` flag
- **Security**: Prevent payment TX reuse — `used_txhash:{hash}` KV flag (90-day TTL) blocks reactivation using the same TX
- **Security**: Strengthened webhook SSRF defenses — added blocks for IPv6 loopback (`::1`, `::ffff:`) and GCP/AWS/Azure metadata endpoints
- **Security**: Added per-API-key rate limit on `/api/relay` — 30 req/60s (layered on top of the existing IP limit)

#### UX / bug fixes
- **Fix**: Wallet connection drop on page navigation — removed the localStorage wipe triggered when `getConnectedAccount()` returns null
- **Fix**: My Page paywall Activate button — `<a href>` → `router.push()` (proper Next.js client-side navigation)
- **Feature**: Subscription expiry banner on My Page — yellow 7 days before expiry, red after expiry + Renew button
- **Fix**: Unified Pricing page prices to the payment page baseline ($30/$150/$800 on BNB); Starter "BNB Chain only" → "All 5 EVM chains"
- **Fix**: Relay TX recording is now fire-and-forget — KV write failures no longer block the success response

#### Grant program
- **Feature**: `/grant` page — Seed/$500, Builder/$2K, Ecosystem tiered grants
- **Feature**: Grant application form → stored in Vercel KV + Telegram `@kwanyeonglee` notification
- **Feature**: "Why build with Q402" section — 01/02/03 numbering, copy focused on technical strengths
- **Feature**: Grant link added to the navbar

### v1.7 (2026-04-11)
- **Feature**: Terms of Service (`/terms`) + Privacy Policy (`/privacy`) pages added
- **Feature**: Terms / Privacy links added to the footer
- **Feature**: Gas Tank low-balance Telegram alert system (`/api/gas-tank?check_alerts=1`)
- **Feature**: Vercel Cron daily 09:00 UTC auto-alert (`vercel.json`)
- **Feature**: `TEST_MODE=true` env var — maps $1+ payments to the starter plan (E2E testing) ⚠️ fully removed in v1.9
- **Feature**: `scripts/test-api.mjs` — automates API-key validity, Gas Tank, sandbox relay, and security checks
- **Fix**: `checkPaymentOnChain` gained 5 BNB RPC fallbacks (works around `bsc.publicnode.com` rate limiting)
- **Fix**: `anyQuerySucceeded` flag — falls back to the next RPC when every token query fails
- **Fix**: BNB blockWindow 2000 → 8000 (~7 hour range)
- **Fix**: `TEST_MODE` value trailing-newline trim (`"true\n"` → `.trim() === "true"`)
- **Fix**: Sandbox key was not passing the relay-route subscription check — fixed
- **Fix**: Gas Tank UI — 5-chain grid (`xl:grid-cols-5`), removed the `Pool:` line, shows a "Deposit" button when balance is 0
- **E2E validation**: full flow passes — 1 USDT on BNB Chain → API key issuance → My Page → sandbox relay

### v1.6 (2026-04-09)
- **Fix**: KV TX history sharded by month — avoids 1MB blow-up; cumulative gas totals stored in a separate key
- **Fix**: Preserves existing API key on subscription renewal (prevents integration breakage)
- **Fix**: Renewal expiry now extends +30 days from the current expiry (cumulative renewal)
- **Fix**: Added per-plan daily relay burst limit (86400s window)
- **Fix**: Gas Tank Stable chain UI clarifies USDT0-only deposits
- **Scripts**: `test-bnb-eip7702.mjs`, `test-eth-eip7702.mjs`, `agent-example.mjs`

### v1.5 (2026-04-09)
- **Page**: `/agents` — SVG agent-network animation, live TX feed, Contact Sales modal
- **UX**: Navbar "Agents" link (green)
- **Pricing**: Replaced the Agent plan card with a CTA strip linking to `/agents`

### v1.4 (2026-04-08)
- **Feature**: Sandbox mode (`q402_test_` prefix, mock relay)
- **Feature**: Webhook system (HMAC-SHA256, SSRF defenses)
- **Feature**: API key rotation (`POST /api/keys/rotate`)
- **Fix**: `gasCostNative` computed from the actual receipt (`effectiveGasPrice × gasUsed`)
- **Fix**: Transactions tab auth switched to EIP-191 signature
- **Fix**: Dashboard subscription-expiry initialization bug
- **Docs**: Deleted CODEX.md; content merged into README + Q402_IMPLEMENTATION.md

### v1.3 (2026-04-08)
- **Feature**: `/payment` 4-step self-serve on-chain payment flow
- **Feature**: API key is auto-issued after on-chain payment
- **UX**: Improved wallet-connect modal; Dashboard "Not yet activated" → "Loading…"

### v1.2 (2026-04-07)
- **Feature**: Stable chain (Chain ID 988, USDT0) added to relay / Gas Tank / SDK
- **Feature**: Telegram inquiry notifications
- **Security**: All 4 chains' contracts redeployed with the v1.2 audit fixes

### v1.1 (2026-03-19)
- **Security**: Fixed an API-key leakage vulnerability
- **Security**: Admin endpoints protected by `x-admin-secret`
- **Security**: Strengthened relay subscription-expiry + key-rotation validation
- **DB**: Migrated from JSON files to Vercel KV
- **Feature**: Removed the payment paywall; added Quote Builder + Direct Inquiry popups

### v1.0 (2026-03-14)
- Initial deployment of landing page, dashboard, and Relay API (4 chains)
