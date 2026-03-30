# Q402 Gasless Payment Protocol — Stable
## Integration Specification v1.0

> **Status:** Testnet deployed (Chain ID: 2201) · Mainnet pending
> **Last updated:** 2026-03-30
> **Contact:** hello@quackai.ai

---

## Abstract

This document describes the integration of the Q402 Gasless Payment Protocol with the Stable blockchain. Q402 enables AI agents, dApps, and enterprise systems to authorize and settle USDT0 transfers without individual wallets needing to manage gas independently. On Stable, where USDT0 serves as both the native gas token and the primary transfer token, Q402 provides unified gas management infrastructure — a single Gas Tank covers all agent activity, with per-agent cost tracking built in.

---

## 1. Why Q402 on Stable

### 1.1 The Multi-Agent Gas Problem

Stable is purpose-built for USDT0 settlement at scale. As AI agent ecosystems grow, each agent requires USDT0 not just for payments but also for gas. Without Q402, operators must:

- Maintain individual USDT0 balances across hundreds or thousands of agent wallets
- Monitor each wallet independently for gas depletion
- Handle top-ups wallet by wallet

**Q402 solves this with a single Gas Tank.** The relayer wallet holds USDT0 and sponsors all agent transactions. Every relay is logged with per-agent attribution, so operators see exactly where gas is going — without distributing funds across wallets.

```
Without Q402:
  Agent 1 wallet → needs USDT0 for gas
  Agent 2 wallet → needs USDT0 for gas
  Agent 3 wallet → needs USDT0 for gas
  ...Agent N wallet → needs USDT0 for gas

With Q402:
  All agents → sign only (no USDT0 needed)
  Q402 Gas Tank (1 wallet) → sponsors all gas
  Dashboard → per-agent USDT0 cost breakdown
```

### 1.2 Unique Properties on Stable

| Property | Stable | Other chains |
|----------|--------|-------------|
| Gas token | USDT0 (same as payment token) | ETH / AVAX / BNB (separate) |
| Gas token decimals | 18 | varies |
| EIP-7702 support | ✅ Native | Chain-dependent |
| Sub-second finality | ✅ ~0.7s block time | Chain-dependent |
| Gas fee denomination | USD-pegged | Volatile native token |

Because gas is denominated in USDT0 (USD-pegged), relayer operating costs are predictable and dollar-denominated — no exposure to native token volatility.

---

## 2. Network Information

### 2.1 Testnet (Active)

| Parameter | Value |
|-----------|-------|
| Network Name | Stable Testnet |
| Chain ID | `2201` |
| RPC URL | `https://rpc.testnet.stable.xyz` |
| WebSocket | `wss://rpc.testnet.stable.xyz` |
| Block Explorer | `https://testnet.stablescan.xyz` |
| Faucet | `https://faucet.stable.xyz` |
| Native Gas Token | USDT0 (18 decimals) |
| USDT0 Contract | `0x78Cf24370174180738C5B8E352B6D14c83a6c9A9` |

### 2.2 Mainnet (Pending)

| Parameter | Value |
|-----------|-------|
| Network Name | Stable Mainnet |
| Chain ID | `988` |
| RPC URL | `https://rpc.stable.xyz` |
| WebSocket | `wss://rpc.stable.xyz` |
| Block Explorer | `https://stablescan.xyz` |
| Native Gas Token | USDT0 (18 decimals) |
| USDT0 Contract | `0x779ded0c9e1022225f8e0630b35a9b54be713736` |

---

## 3. Deployed Contracts

### 3.1 Q402PaymentImplementationStable

| Network | Address |
|---------|---------|
| Stable Testnet (Chain ID: 2201) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| Stable Mainnet (Chain ID: 988) | *Pending mainnet launch* |

**Explorer:** [View on Stablescan Testnet](https://testnet.stablescan.xyz/address/0x2fb2B2D110b6c5664e701666B3741240242bf350)

**Compiler:** Solidity `0.8.20`, optimizer enabled (200 runs), EVM: london

**Source:** [Q402PaymentImplementationStable.sol](https://github.com/bitgett/Q402-Institutional)

---

## 4. Protocol Architecture

### 4.1 Payment Flow (EIP-7702)

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Q402 Payment Flow on Stable                      │
│                                                                      │
│  ┌───────────┐    ① Request resource (no payment header)            │
│  │   Agent   │ ────────────────────────────────────────▶ ┌────────┐ │
│  │  (User)   │    ② HTTP 402 Payment Required             │ Server │ │
│  │           │ ◀──────────────────────────────────────── │        │ │
│  │  No USDT0 │    paymentDetails: {token, amount, impl}  └────────┘ │
│  │  for gas  │                                                       │
│  └─────┬─────┘                                                       │
│        │  ③ signTypedData(TransferAuthorization)  [EIP-712]         │
│        │  ④ signAuthorization(implContract, nonce) [EIP-7702]       │
│        │                                                             │
│        └──────────────────────────▶ ┌────────────────────────────┐  │
│                  POST /api/relay     │     Q402 Relayer            │  │
│                                      │  (Gas Tank — USDT0)         │  │
│                                      │                             │  │
│                                      │  • Verify API key           │  │
│                                      │  • Check gas tank balance   │  │
│                                      │  • Submit Type-0x04 TX      │  │
│                                      └────────────┬───────────────┘  │
│                                                   │                  │
│                           ⑤ EIP-7702 Type-4 TX   │                  │
│                              from: Relayer        │                  │
│                              to: Agent EOA        ▼                  │
│                                      ┌────────────────────────────┐  │
│                                      │  Agent EOA (delegated)     │  │
│                                      │  USDT0.transfer(to, amt)   │  │
│                                      └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 Key Insight: EIP-7702 on Stable

Under EIP-7702, the agent's EOA temporarily executes the `Q402PaymentImplementationStable` bytecode for a single transaction. This means:

- `address(this)` inside the contract = the agent's EOA
- `IERC20(token).transfer(recipient, amount)` debits from the agent's own USDT0 balance
- No `approve()` call needed — the EOA is the token holder

The relayer pays USDT0 gas. The agent signs authorization. Tokens move from agent to recipient. One transaction, zero gas exposure for the agent.

---

## 5. EIP-712 Signature Specification

### 5.1 Domain

```json
{
  "name": "Q402 Stable",
  "version": "1",
  "chainId": 2201,
  "verifyingContract": "0x2fb2B2D110b6c5664e701666B3741240242bf350"
}
```

> **Note:** `verifyingContract` is the implementation contract address (not the agent's EOA). This differs from the X Layer deployment where `verifyingContract = agent's EOA`.

### 5.2 TransferAuthorization Type

```solidity
TransferAuthorization(
  address owner,       // Agent EOA (signer)
  address facilitator, // Q402 relayer wallet
  address token,       // USDT0: 0x78Cf24370174180738C5B8E352B6D14c83a6c9A9
  address recipient,   // Payment destination
  uint256 amount,      // In USDT0 atomic units (18 decimals)
  uint256 nonce,       // Random uint256 — replay protection
  uint256 deadline     // Unix timestamp expiry
)
```

### 5.3 Amount Encoding

USDT0 uses **18 decimals** on Stable (OFT standard, 1:1 peg with USDT).

```js
// 1.00 USDT0
const amount = BigInt(1 * 10**18) // = 1000000000000000000n

// 10.00 USDT0
const amount = BigInt(10 * 10**18) // = 10000000000000000000n
```

---

## 6. SDK Integration

### 6.1 Installation

```html
<script src="https://q402.io/q402-sdk.js"></script>
```

Or via npm (for agent environments):
```bash
npm install ethers
# q402-sdk.js is included in the Q402 API response or self-hosted
```

### 6.2 Basic Usage

```js
const q402 = new Q402Client({
  apiKey: "q402_live_your_key_here",
  chain:  "stable",
});

const result = await q402.pay({
  to:     "0xRecipientAddress",
  amount: "5.00",       // USDT0
  token:  "USDT",
});

console.log(result.txHash);
// → 0x... (Stable testnet TX hash)
```

### 6.3 Chain Configuration (SDK internals)

```js
stable: {
  name:         "Stable",
  chainId:      2201,
  mode:         "eip7702_stable",
  domainName:   "Q402 Stable",
  implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
  usdt: { address: "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9", decimals: 18 },
}
```

---

## 7. REST API

### 7.1 Submit a Relay

**`POST /api/relay`**

```json
{
  "apiKey":        "q402_live_xxx",
  "chain":         "stable",
  "token":         "USDT",
  "from":          "0xAgentEOA",
  "to":            "0xRecipient",
  "amount":        "5000000000000000000",
  "deadline":      1743600000,
  "witnessSig":    "0x...",
  "authorization": {
    "chainId": 2201,
    "address": "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    "nonce":   42,
    "yParity": 0,
    "r":       "0x...",
    "s":       "0x..."
  },
  "stableNonce":   "98237498237492834",
  "facilitator":   "0xRelayerWallet"
}
```

**Response:**

```json
{
  "success":      true,
  "txHash":       "0x...",
  "blockNumber":  "12345",
  "tokenAmount":  5.0,
  "token":        "USDT",
  "chain":        "stable",
  "gasCostNative": 0.000021,
  "method":       "eip7702_stable"
}
```

### 7.2 Facilitator Info

**`GET /api/relay/info`**

```json
{
  "facilitator": "0xRelayerWalletAddress"
}
```

---

## 8. Gas Tank

### 8.1 How It Works

The Q402 Gas Tank on Stable holds USDT0 on behalf of API key holders. When a relay is submitted, the relayer pays USDT0 gas from this pool. Every transaction is logged with actual gas cost.

**Gas Tank funding:** Send USDT0 to the relayer address and register via `POST /api/gas-tank/verify-deposit`.

### 8.2 Why This Matters for Agent Operators

| Scenario | Without Q402 | With Q402 |
|----------|-------------|-----------|
| 100 agents running | 100 wallets, each needs USDT0 | 1 Gas Tank, covers all |
| Gas monitoring | Check 100 wallets | 1 dashboard |
| Per-agent cost tracking | Manual | Automatic (by API key) |
| Refill | 100 transactions | 1 deposit |

---

## 9. Security Properties

The `Q402PaymentImplementationStable` contract enforces:

| Check | Implementation |
|-------|---------------|
| Facilitator enforcement | `if (msg.sender != facilitator) revert UnauthorizedFacilitator()` |
| Owner binding | `if (owner != address(this)) revert OwnerMismatch()` |
| Zero-address prevention | `if (owner == address(0)) revert InvalidOwner()` |
| Replay protection | `usedNonces[owner][nonce]` mapping |
| Deadline enforcement | `if (block.timestamp > deadline) revert SignatureExpired()` |
| ECDSA malleability | High-s rejection (`s > secp256k1n/2`) |
| ecrecover zero check | `if (signer == address(0)) revert InvalidSignature()` |

---

## 10. Roadmap

| Milestone | Target |
|-----------|--------|
| Testnet deployment | ✅ 2026-03-30 |
| SDK v1.3.0 with stable chain | ✅ 2026-03-30 |
| End-to-end testnet verification | In progress |
| Stable mainnet deployment | Pending Stable mainnet launch |
| Gas Waiver API integration | Evaluating (Stable partner program) |

---

## 11. About Q402

Q402 is a gasless payment protocol built by **Quack AI**. It enables AI agents, dApps, and enterprise systems to execute USDT/USDC transfers via signed authorizations — with no native gas token required on the user's side.

- **Website:** [q402.io](https://q402.io)
- **GitHub:** [github.com/bitgett/Q402-Institutional](https://github.com/bitgett/Q402-Institutional)
- **Contact:** hello@quackai.ai
- **X:** [@stable](https://x.com/stable) integration · [@quackai](https://x.com/quackai)

---

*This document is intended for Stable ecosystem partners, developers building on Stable, and the Stable core team. For technical questions or partnership inquiries, contact hello@quackai.ai.*
