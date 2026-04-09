# Q402 — Gasless Payment Infrastructure

> Multi-chain ERC-20 gasless payment relay for DeFi applications.
> Users pay USDC/USDT with zero gas — Q402 relayer covers all transaction fees.

**Current version: v1.3** · [Changelog](#changelog)

---

## Why We Built This

Every EVM blockchain requires users to hold a "native gas token" (BNB, ETH, AVAX, OKB, USDT0) just to move USDC or USDT. This is a massive UX friction point:

> A user with 100 USDC on BNB Chain **cannot send it** unless they also hold BNB for gas.  
> DeFi onboarding fails at this exact step — millions of users have stablecoins but no gas.

**4 reasons Q402 exists:**

1. **Web3 mass adoption is blocked by gas UX.** Every mainstream fintech app (Stripe, PayPal, Venmo) moves money without the sender worrying about network fees. Web3 must reach this standard.

2. **AI Agents need gasless payment rails.** Running 100+ autonomous agents that each need to hold and manage gas across 5 chains is an operational nightmare. Q402 solves this: fund a shared Gas Tank once, run all agents gaslessly.

3. **EIP-7702 is the right primitive.** Unlike account abstraction (ERC-4337), EIP-7702 works with existing EOAs — no contract wallet migration needed. Any standard wallet (MetaMask, OKX) can participate immediately.

4. **Multi-chain from day one.** Most gasless solutions support one chain. Q402 deployed identical contracts on 5 mainnet chains simultaneously.

---

## What is Q402?

Q402 is a **gasless payment infrastructure** built on EIP-7702 + EIP-712. External developers integrate the Q402 SDK into their dApp, and Q402's relayer wallet pays all on-chain gas costs so end users never need to hold native tokens.

**avax / bnb / eth / stable — EIP-7702 mode:**
```
User clicks "Pay USDC"
  → SDK generates EIP-712 witnessSig + EIP-7702 authorization (2 signatures)
    → POST /api/relay { witnessSig, authorization }
      → Q402 relayer submits Type 4 TX (pays gas)
        → Q402PaymentImplementation.pay() executes
          → USDC moves from user EOA to recipient
```

**xlayer — EIP-7702 mode** (confirmed working 2026-03-12):
```
User clicks "Pay USDC"
  → SDK fetches GET /api/relay/info (facilitator address)
    → SDK generates EIP-712 TransferAuthorization + EIP-7702 authorization (2 signatures)
      → POST /api/relay { witnessSig, authorization, xlayerNonce }
        → Q402 relayer submits Type 4 TX (pays OKB gas)
          → Q402PaymentImplementationXLayer.transferWithAuthorization() executes
            → USDC moves from user EOA to recipient
```
> EIP-3009 fallback still available for X Layer — send `eip3009Nonce` instead of `authorization`.

---

## Supported Chains

| Chain | ChainID | Relay Method | Contract |
|-------|---------|-------------|----------|
| Avalanche C-Chain | 43114 | EIP-7702 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` |
| BNB Chain | 56 | EIP-7702 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` |
| Ethereum | 1 | EIP-7702 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` |
| X Layer | 196 | EIP-7702 + EIP-3009 fallback | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` |
| **Stable** | **988** | **EIP-7702** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |

---

## Tech Stack

- **Framework**: Next.js 14 App Router (TypeScript)
- **Styling**: Tailwind CSS + framer-motion
- **Blockchain**: ethers.js v6 + viem
- **Wallet**: Custom WalletContext (MetaMask + OKX Wallet)
- **DB**: Vercel KV (Redis) — `app/lib/db.ts`
- **Deployment**: Vercel

---

## Requirements

- **Node.js 18+**
- MetaMask or OKX Wallet browser extension

---

## Local Development Setup

### 1. Clone & install

```bash
git clone https://github.com/bitgett/Q402-Institutional.git
cd Q402-Institutional
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Relayer wallet private key (pays gas on all chains)
RELAYER_PRIVATE_KEY=0x_your_private_key_here

# Contract addresses (v1.3)
IMPLEMENTATION_CONTRACT=0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c
BNB_IMPLEMENTATION_CONTRACT=0x6cF4aD62C208b6494a55a1494D497713ba013dFa
ETH_IMPLEMENTATION_CONTRACT=0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD
XLAYER_IMPLEMENTATION_CONTRACT=0x8D854436ab0426F5BC6Cc70865C90576AD523E73
STABLE_IMPLEMENTATION_CONTRACT=0x2fb2B2D110b6c5664e701666B3741240242bf350

# Vercel KV (required for all data persistence)
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...

# Admin secret for protected endpoints
ADMIN_SECRET=your_admin_secret_here

# Optional: Telegram bot for inquiry notifications
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### 3. Run dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page — Hero, HowItWorks, Pricing, Contact (Talk to Us popup) |
| `/payment` | 4-step on-chain payment: chain/volume → wallet → send → verify → API key |
| `/dashboard` | Developer dashboard (API key, Gas Tank, TX history) |
| `/docs` | API reference & integration guide |

---

## Payment Flow (v1.3)

The `/payment` page now uses a full **self-serve on-chain payment flow**:

1. **Select chain** — which chain will your product use?
2. **Select volume** — monthly transaction quota
3. **Connect wallet** — MetaMask or OKX Wallet
4. **Send & verify** — send USDC/USDT to the Q402 address, click "Verify", API key issues automatically

Accepted payment tokens: **BNB USDC, BNB USDT, ETH USDC, ETH USDT**  
Payment address: `0xfc77ff29178b7286a8ba703d7a70895ca74ff466`

> **Note — payment tokens are intentionally BNB/ETH only and will not change.**  
> The `/payment` page is the Q402 subscription billing page, not a relay demo.  
> It accepts only BNB Chain and Ethereum stablecoins for operational simplicity and reliability.  
> Stable (USDT0) is available as a *relay target chain* for developer integrations,  
> but is not used as a payment token for Q402 subscriptions.

---

## SDK Usage

```html
<script src="https://q402.io/q402-sdk.js"></script>
```

```javascript
// Avalanche / BNB / Ethereum / Stable — EIP-7702
const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
const result = await q402.pay({ to: "0xRecipient", amount: "5.00", token: "USDC" });
console.log(result.txHash); // method: "eip7702"

// X Layer — EIP-7702 (auto-detected, fetches facilitator via /api/relay/info)
const q402xl = new Q402Client({ apiKey: "q402_live_xxx", chain: "xlayer" });
const result2 = await q402xl.pay({ to: "0xRecipient", amount: "1.00", token: "USDC" });
console.log(result2.txHash); // method: "eip7702_xlayer"

// Stable chain (Chain ID 988, USDT0)
const q402s = new Q402Client({ apiKey: "q402_live_xxx", chain: "stable" });
const result3 = await q402s.pay({ to: "0xRecipient", amount: "10.00", token: "USDT0" });
```

SDK version: **v1.3.0** — supports 5 chains (avax, bnb, eth, xlayer, stable)

---

## API Overview

### POST /api/relay
Submit signed EIP-712 + EIP-7702 payload for gasless relay.
Requires valid `apiKey` in body. Enforces subscription expiry and key rotation checks.

**Supported chains:** `avax` | `bnb` | `eth` | `xlayer` | `stable`

### GET /api/relay/info
Returns the relayer (facilitator) address. Required for X Layer EIP-7702 signing.

### POST /api/payment/activate
Scan blockchain for USDC/USDT payment from caller's address, activate subscription, issue API key.

### POST /api/payment/check
Check if an address has an active subscription.

### POST /api/inquiry
Submit a project inquiry. Stored to Vercel KV + Telegram notification.

### POST /api/keys/verify
Validate an API key. Returns validity, plan, and expiry status.

### Admin endpoints (require `x-admin-secret` header)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/keys/generate` | POST | Regenerate API key (revokes old) |
| `/api/keys/topup` | POST | Add quota bonus to subscription |
| `/api/gas-tank/withdraw` | POST | Withdraw gas balance to address |
| `/api/inquiry` | GET | List all project inquiries |

---

## Project Structure

```
Q402-Institutional/
├── app/
│   ├── api/
│   │   ├── payment/activate/       # On-chain payment scan + API key issuance
│   │   ├── payment/check/          # Subscription status check
│   │   ├── keys/                   # API key generate, verify, topup, provision
│   │   ├── gas-tank/               # Relayer balance, user deposits, withdraw
│   │   ├── relay/                  # EIP-7702 / EIP-3009 relay endpoint
│   │   └── inquiry/                # Project inquiry form handler
│   ├── lib/
│   │   ├── access.ts               # MASTER_ADDRESSES whitelist
│   │   ├── blockchain.ts           # On-chain Transfer event scanner (5 chains)
│   │   ├── db.ts                   # Vercel KV data layer
│   │   ├── relayer.ts              # viem EIP-7702 transaction sender
│   │   └── wallet.ts               # MetaMask / OKX wallet connect
│   ├── context/WalletContext.tsx   # Global wallet state
│   ├── components/
│   │   ├── Hero.tsx                # Landing hero + animated terminal
│   │   ├── HowItWorks.tsx          # 3-step explainer + chain logos (5 chains)
│   │   ├── TrustedBy.tsx           # Scrolling chain marquee
│   │   ├── Pricing.tsx             # 4-tier pricing table
│   │   ├── Contact.tsx             # CTA section — "Talk to Us" opens popup
│   │   ├── WalletButton.tsx        # Connect wallet (MetaMask + OKX)
│   │   └── RegisterModal.tsx       # Project inquiry popup modal
│   ├── dashboard/page.tsx          # Dashboard (Overview, Gas Tank, Developer, Transactions)
│   ├── payment/page.tsx            # 4-step on-chain payment builder
│   └── docs/page.tsx               # Full API reference
└── public/
    ├── q402-sdk.js                 # Client SDK v1.3.0
    ├── bnb.png / eth.png / avax.png / xlayer.png / stable.jpg
    └── arbitrum.png / scroll.png
```

---

## Subscription Plans

| Plan | Monthly Relay TX | Note |
|------|-----------------|------|
| Starter | 500 | BNB Chain only |
| Growth | 10,000 | All 5 chains |
| Scale | 100,000 | All 5 chains |
| Enterprise | 500,000+ | Custom SLA |

Payment accepted: USDC or USDT on BNB Chain or Ethereum  
API key issued automatically after on-chain payment confirmation.

---

## Authentication Model

All user-facing API routes use **EIP-191 personal_sign** for ownership proof:

```
Message: "Q402 API Key Request\nAddress: 0xuser_address_lowercase"
```

1. Client signs once per session → cached in `sessionStorage["q402_sig_0xaddr"]`
2. Server: `ethers.verifyMessage(msg, sig)` → must match address

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| /api/relay | 60 req/60s per IP |
| /api/keys/provision | 10 req/60s per IP |
| /api/keys/rotate | 5 req/60s per IP |
| /api/payment/activate | 5 req/60s per IP |
| /api/payment/check | 30 req/60s per IP |
| /api/transactions | 30 req/60s per IP |
| /api/webhook | 10 req/60s per IP |
| /api/inquiry | 3 req/600s per IP |

---

## Webhook System

Register a webhook URL to receive `relay.success` events after every gasless TX.

```json
{
  "event": "relay.success",
  "sandbox": false,
  "txHash": "0x...",
  "chain": "avax",
  "from": "0xUSER",
  "to": "0xRECIPIENT",
  "amount": 5.0,
  "token": "USDC",
  "gasCostNative": 0.00042,
  "timestamp": "2026-04-08T12:00:00.000Z"
}
```

All webhook requests include `X-Q402-Signature: sha256=HMAC_HEX`.  
Verify on your server:
```javascript
const hmac = crypto.createHmac('sha256', process.env.Q402_WEBHOOK_SECRET);
hmac.update(rawBody);
const valid = 'sha256=' + hmac.digest('hex') === req.headers['x-q402-signature'];
```

**Endpoints:**
- `POST /api/webhook` — register URL, receive secret (shown once)
- `GET /api/webhook?address=0x&sig=0x` — check current config
- `DELETE /api/webhook` — remove webhook
- `POST /api/webhook/test` — fire a test event

---

## Sandbox Mode

Use `q402_test_` prefixed API keys to test integration without on-chain transactions:

```javascript
const q402 = new Q402Client({ apiKey: "q402_test_xxx", chain: "avax" });
const result = await q402.pay({ to: "0x...", amount: "5.00", token: "USDC" });
// result.success = true, result.txHash = random mock hash
// No gas spent, no on-chain TX
```

Sandbox keys are co-issued alongside live keys (see `/api/keys/provision`).  
Sandbox responses appear in the transactions log with `sandbox: true`.

---

## API Key Rotation

```
POST /api/keys/rotate
Body: { address, signature }
```

Revokes the current live key and issues a new one. Old key becomes immediately inactive.

---

## What's Not Yet in v1.4

| Item | Status |
|------|--------|
| PostgreSQL migration | Using Vercel KV |
| Separate gas address per project | Using single global relayer address |
| Automated tests | Not implemented |
| Webhook retry on failure | Fire-and-forget; no retry logic |
| Gas Tank auto-refill | UI toggle exists but no automated on-chain logic |

---

## Changelog

### v1.4 (2026-04-08)
- **Feature**: Sandbox mode — `q402_test_` prefixed API keys bypass on-chain, return mock TX
- **Feature**: Webhook system — `POST/GET/DELETE /api/webhook` + test endpoint, HMAC-signed payloads
- **Feature**: API key rotation — `POST /api/keys/rotate` revokes old key, issues new one
- **Fix**: `gasCostNative` now computed from actual receipt (`effectiveGasPrice * gasUsed`)
- **Fix**: Transactions tab now uses EIP-191 auth (`address + sig`) instead of bare API key
- **Fix**: Dashboard subscription expiry state properly initialized from `/api/payment/check`
- **Security**: SSRF protection on webhook register, test, and relay fire paths
- **Docs**: AI handoff sections merged into README + Q402_IMPLEMENTATION.md (no CODEX.md)

### v1.3 (2026-04-08)
- **Feature**: `/payment` page rebuilt as 4-step on-chain self-serve payment flow
- **Feature**: Payment accepted in BNB USDC/USDT or ETH USDC/USDT
- **Feature**: API key auto-issued after on-chain payment scan
- **Feature**: "Talk to Us" on landing page now opens RegisterModal popup (was mailto)
- **UX**: Payment page Steps 3 (wallet) + 4 (send+verify) added to left column as numbered steps
- **UX**: Wallet connect modal matches landing page (full MetaMask SVG, "Detected" badge)
- **UX**: HowItWorks section now shows all 5 chain logos including Stable
- **UX**: Dashboard "Not yet activated" → "Loading…" (key auto-provisions on connect)
- **UX**: Dashboard `userGasBalance` initial state includes `stable: 0`
- **Docs**: Chain list, EIP-7702 note, and CTA updated to reflect 5-chain support
- **Fix**: Build errors resolved (unused vars in payment page)

### v1.2 (2026-04-07)
- **Feature**: Stable chain (Chain ID 988, USDT0) added to relay, gas tank, SDK
- **Feature**: Telegram notifications for new inquiries
- **Security**: Contract addresses updated to v1.2 deployment
- **SDK**: Updated to v1.3.0 with Stable chain support

### v1.1 (2026-03-19)
- **Security**: Closed API key leakage on payment endpoints
- **Security**: Admin secret required for generate, topup, withdraw
- **Security**: Relay enforces subscription expiry + current-key match
- **Feature**: Payment paywall removed; Quote Builder + Direct Inquiry popup
- **Fix**: Gas cost now calculated from actual TX receipt
- **DB**: Migrated from JSON file to Vercel KV

### v1.0 (2026-03-14)
- Initial deployment with landing page, dashboard, relay API

---

## Security Properties

| Property | Implementation |
|----------|---------------|
| API key ownership proof | EIP-191 personal_sign required for provision/rotate/transactions |
| Replay protection | `usedNonces[owner][nonce]` on-chain |
| SSRF prevention | Webhook URLs checked against private IP ranges (RFC-1918 + loopback) |
| Rate limiting | KV sliding-window per IP per endpoint |
| Error sanitization | Internal errors logged server-side; generic messages to clients |
| Sandbox isolation | `q402_test_` keys never touch on-chain; `isSandbox` flag in KV |
| Webhook integrity | HMAC-SHA256 on every outgoing webhook payload |

---

## Full Technical Docs

See [Q402_IMPLEMENTATION.md](./Q402_IMPLEMENTATION.md) for complete implementation details, KV data model, EIP-712 domain matrix, and contract internals.  
See [HANDOFF.md](./HANDOFF.md) for setup guide (new machine / new dev).
