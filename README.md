# Q402 — Gasless Payment Infrastructure

> Multi-chain ERC-20 gasless payment relay for DeFi applications.
> Users pay USDC/USDT with zero gas — Q402 relayer covers all transaction fees.

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
> EIP-3009 fallback still available — send `eip3009Nonce` instead of `authorization` to use it.

---

## Supported Chains

| Chain | ChainID | Relay Method | Contract / Notes |
|-------|---------|-------------|------------------|
| Avalanche C-Chain | 43114 | EIP-7702 | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699` |
| BNB Chain | 56 | EIP-7702 | `0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6` |
| Ethereum | 1 | EIP-7702 | `0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9` |
| X Layer | 196 | EIP-7702 | `0x31E9D105df96b5294298cFaffB7f106994CD0d0f` |

> X Layer EIP-7702 confirmed working (2026-03-12). Uses `Q402PaymentImplementationXLayer` with `TransferAuthorization` witness type (verifyingContract = user EOA).
> EIP-3009 fallback also supported.
> All RPCs are **public endpoints** — no API keys required.

---

## Tech Stack

- **Framework**: Next.js 14 App Router (TypeScript)
- **Styling**: Tailwind CSS + framer-motion
- **Blockchain**: ethers.js v6 + viem (EIP-7702 for all chains, EIP-3009 fallback for xlayer)
- **Wallet**: Custom WalletContext (MetaMask + OKX Wallet)
- **DB**: JSON file (`data/db.json`) — replace with PostgreSQL for production

---

## Requirements

- **Node.js 18+**
- MetaMask or OKX Wallet browser extension (for wallet connect features)

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
# NEVER expose this publicly
RELAYER_PRIVATE_KEY=0x_your_private_key_here

# Q402PaymentImplementation contract addresses
IMPLEMENTATION_CONTRACT=0xE5b90D564650bdcE7C2Bb4344F777f6582e05699
BNB_IMPLEMENTATION_CONTRACT=0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6
ETH_IMPLEMENTATION_CONTRACT=0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9
XLAYER_IMPLEMENTATION_CONTRACT=0x31E9D105df96b5294298cFaffB7f106994CD0d0f
```

> **Without `.env.local`:** The frontend (landing, dashboard UI, payment page) runs fine.
> Only `/api/relay` and `/api/payment/activate` will return errors.

### 3. Run dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Database (`data/db.json`)

The repo includes a pre-seeded `data/db.json`. No setup needed for local dev.

```json
{
  "subscriptions": {},
  "apiKeys": {},
  "gasDeposits": {},
  "relayedTxs": {}
}
```

The file is read/written at runtime via `app/lib/db.ts`.

> **Warning:** `data/db.json` does **not** work on Vercel or any serverless platform — the filesystem is read-only. Replace with PostgreSQL before deploying to production.

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/payment` | Quote builder — select chain, volume, token → send payment → activate |
| `/dashboard` | Developer dashboard (API key, Gas Tank, TX history) |
| `/docs` | API reference & integration guide |

---

## SDK Usage (3 lines)

```html
<script src="https://q402.io/q402-sdk.js"></script>
<script src="https://cdn.ethers.io/lib/ethers-5.7.2.umd.min.js"></script>
```

```javascript
// Avalanche / BNB / Ethereum — EIP-7702
const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
const result = await q402.pay({ to: "0xRecipient", amount: "5.00", token: "USDC" });
console.log(result.txHash); // method: "eip7702"

// X Layer — EIP-7702 (auto-detected, same API)
const q402xl = new Q402Client({ apiKey: "q402_live_xxx", chain: "xlayer" });
const result2 = await q402xl.pay({ to: "0xRecipient", amount: "1.00", token: "USDC" });
console.log(result2.txHash); // method: "eip7702_xlayer"
```

---

## Subscription Plans

| Plan | Price | Monthly Relay TX |
|------|-------|-----------------|
| Growth | $670 | 50,000 |
| Scale | $1,200 | 100,000 |
| Business | $3,000 | 100K–500K |
| Enterprise | Custom | 500K+ |

Prices shown for Ethereum mainnet. BNB Chain / Avalanche / X Layer start lower — use the [Quote Builder](/payment) for exact pricing per chain.

Payment flow: send USDC/USDT to the Q402 relayer address on any supported chain → wait ~3 min → click "Activate" on `/payment` → dashboard access granted + API key issued.

---

## Project Structure

```
Q402-Institutional/
├── app/
│   ├── api/
│   │   ├── payment/activate/   # Scan chain → activate subscription → issue API key
│   │   ├── keys/               # API key generate & verify
│   │   ├── gas-tank/           # Relayer balance & user deposits
│   │   └── relay/              # EIP-7702 relay endpoint
│   ├── lib/
│   │   ├── access.ts           # isPaid / setPaid / MASTER_ADDRESSES
│   │   ├── blockchain.ts       # On-chain Transfer event scanner (public RPCs)
│   │   ├── relayer.ts          # viem EIP-7702 transaction sender
│   │   └── wallet.ts           # MetaMask / OKX wallet connect
│   ├── context/WalletContext.tsx  # Global wallet state (localStorage restore)
│   ├── components/
│   ├── dashboard/page.tsx
│   ├── payment/page.tsx
│   └── docs/page.tsx
├── data/db.json                # Runtime DB (replace with PostgreSQL in prod)
├── public/q402-sdk.js          # Client SDK
└── .env.example                # Environment variable template
```

---

## What's Not Yet Implemented

| Item | Status |
|------|--------|
| Real gas cost tracking per relay TX | `gasCostNative` always recorded as 0 |
| Subscription expiry / renewal | Not implemented |
| Webhook / TX event notifications | Not implemented |
| PostgreSQL migration | Using JSON file (not suitable for production) |
| Vercel deployment | Not yet deployed |

---

## Full Technical Docs

See [Q402_IMPLEMENTATION.md](./Q402_IMPLEMENTATION.md) for complete implementation details, API specs, contract ABIs, and EIP-7702 relay internals (including X Layer `TransferAuthorization` witness type).
