# Q402 — Gasless Payment Infrastructure

> Multi-chain ERC-20 gasless payment relay for DeFi applications.
> Users pay USDC/USDT with zero gas — Q402 relayer covers all transaction fees.

**Current version: v1.1** · [Changelog](#changelog)

---

## What is Q402?

Q402 is a **gasless payment infrastructure** for Web3. External developers integrate the Q402 SDK into their dApp, and Q402's relayer wallet pays all on-chain gas costs so end users never need to hold native tokens.

**avax / bnb / eth — EIP-7702 mode:**
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
> EIP-3009 fallback still available — send `eip3009Nonce` instead of `authorization`.

---

## Supported Chains

| Chain | ChainID | Relay Method | Contract |
|-------|---------|-------------|----------|
| Avalanche C-Chain | 43114 | EIP-7702 | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699` |
| BNB Chain | 56 | EIP-7702 | `0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6` |
| Ethereum | 1 | EIP-7702 | `0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9` |
| X Layer | 196 | EIP-7702 + EIP-3009 fallback | `0x31E9D105df96b5294298cFaffB7f106994CD0d0f` |

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

# Contract addresses
IMPLEMENTATION_CONTRACT=0xE5b90D564650bdcE7C2Bb4344F777f6582e05699
BNB_IMPLEMENTATION_CONTRACT=0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6
ETH_IMPLEMENTATION_CONTRACT=0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9
XLAYER_IMPLEMENTATION_CONTRACT=0x31E9D105df96b5294298cFaffB7f106994CD0d0f

# Vercel KV (required for all data persistence)
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...

# Admin secret for protected endpoints
ADMIN_SECRET=your_admin_secret_here
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
| `/` | Landing page |
| `/payment` | Quote Builder — select chain & volume → inquiry popup form |
| `/dashboard` | Developer dashboard (API key, Gas Tank, TX history) |
| `/docs` | API reference & integration guide |

---

## SDK Usage

```html
<script src="https://q402.io/q402-sdk.js"></script>
```

```javascript
// Avalanche / BNB / Ethereum — EIP-7702
const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
const result = await q402.pay({ to: "0xRecipient", amount: "5.00", token: "USDC" });
console.log(result.txHash); // method: "eip7702"

// X Layer — EIP-7702 (auto-detected)
const q402xl = new Q402Client({ apiKey: "q402_live_xxx", chain: "xlayer" });
const result2 = await q402xl.pay({ to: "0xRecipient", amount: "1.00", token: "USDC" });
console.log(result2.txHash); // method: "eip7702_xlayer"
```

---

## API Overview

### POST /api/relay
Submit signed EIP-712 + EIP-7702 payload for gasless relay.
Requires valid `apiKey` in body. Enforces subscription expiry and key rotation checks.

### GET /api/relay/info
Returns the relayer (facilitator) address. Required for X Layer EIP-7702 signing.

### POST /api/inquiry
Submit a project inquiry. Stored to Vercel KV.

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
│   │   ├── payment/activate/       # Subscription activation
│   │   ├── keys/                   # API key generate, verify, topup, provision
│   │   ├── gas-tank/               # Relayer balance, user deposits, withdraw
│   │   ├── relay/                  # EIP-7702 / EIP-3009 relay endpoint
│   │   └── inquiry/                # Project inquiry form handler
│   ├── lib/
│   │   ├── access.ts               # isPaid (always true in v1.1) / MASTER_ADDRESSES
│   │   ├── blockchain.ts           # On-chain Transfer event scanner
│   │   ├── db.ts                   # Vercel KV data layer
│   │   ├── relayer.ts              # viem EIP-7702 transaction sender
│   │   └── wallet.ts               # MetaMask / OKX wallet connect
│   ├── context/WalletContext.tsx   # Global wallet state
│   ├── components/
│   ├── dashboard/page.tsx
│   ├── payment/page.tsx            # Quote Builder + inquiry popup
│   └── docs/page.tsx
└── public/q402-sdk.js              # Client SDK v1.2.0
```

---

## Subscription Plans

| Plan | Monthly Relay TX | Note |
|------|-----------------|------|
| Starter | 500 | BNB Chain |
| Basic | 1,000 | |
| Growth | 10,000 | All chains |
| Pro | 10,000 | All chains |
| Scale | 100,000 | All chains |
| Business | 100,000 | All chains |
| Enterprise Flex | 500,000 | Custom |

> In v1.1, the paywall is temporarily removed. Users get dashboard access immediately upon wallet connection. Plans are managed manually via inquiry form.

---

## What's Not Yet in v1.1

| Item | Status |
|------|--------|
| Subscription payment flow | Temporarily removed (Direct Inquiry system in place) |
| Webhook / TX event notifications | UI exists (email input in dashboard); sending not implemented |
| PostgreSQL migration | Using Vercel KV |
| Separate gas address per project | Using single global relayer address |
| Automated tests | Not implemented |

---

## Changelog

### v1.1 (2026-03-19)
- **Security**: Closed API key leakage on payment/check and payment/activate
- **Security**: Admin secret required for keys/generate, keys/topup, gas-tank/withdraw
- **Security**: Relay enforces subscription expiry + current-key match; old keys revoked on rotation
- **Security**: transactions and gas-tank/user-balance require apiKey (no address enumeration)
- **Feature**: Payment paywall removed; replaced with Quote Builder + Direct Inquiry popup form
- **Feature**: Project inquiry form stored to Vercel KV (`/api/inquiry`)
- **Fix**: Gas cost now calculated from actual TX receipt (was always 0)
- **Fix**: PLAN_QUOTA expanded to cover all plan names
- **Fix**: Removed Arbitrum/Scroll from supported chain lists
- **Fix**: Docs corrected (removed getNonce, /v1/send, Permit2 references)
- **DB**: Migrated from JSON file to Vercel KV

### v1.0 (2026-03-14)
- Initial deployment with OG image, landing page, dashboard, relay API

---

## Full Technical Docs

See [Q402_IMPLEMENTATION.md](./Q402_IMPLEMENTATION.md) for complete implementation details, API specs, contract ABIs, and EIP-7702 relay internals.
