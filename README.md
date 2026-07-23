# Q402 - Gasless payments for AI agents and apps

> Pay USDC, USDT, RLUSD, or USDG across **12 EVM chains** with $0 in gas. A user or
> an AI agent signs once; the Q402 relayer submits the transaction and covers the gas,
> and the recipient receives 100%. Built on EIP-7702 + EIP-712, callable from a browser,
> a Node backend, or any MCP client (Claude, Codex, Cursor, Cline, Copilot, Hermes).

[![sdk](https://img.shields.io/badge/sdk-v1.9.0--base--x402-yellow)](public/q402-sdk.js)
[![mcp](https://img.shields.io/badge/npm-@quackai/q402--mcp-blue)](https://www.npmjs.com/package/@quackai/q402-mcp)
[![chains](https://img.shields.io/badge/chains-12-yellow)](#supported-chains)

**Live**: https://q402.quackai.ai &nbsp;·&nbsp; **MCP**: https://q402.quackai.ai/claude &nbsp;·&nbsp; **Free trial**: https://q402.quackai.ai/event &nbsp;·&nbsp; **Docs**: https://q402.quackai.ai/docs

---

## What is Q402

Users need a native gas token just to move stablecoins. Q402 removes that step: the
user (or an agent) signs an EIP-712 authorization off-chain, the relayer submits a
Type-4 (EIP-7702) transaction and pays the gas, and the recipient receives 100%.

```
User signs EIP-712 off-chain
  → Q402 relayer submits an EIP-7702 Type-4 tx (and pays the gas)
    → USDC / USDT / RLUSD / USDG moves to the recipient
      → recipient receives 100%, sender pays $0
```

The same primitive serves people (browser / backend) and AI agents (one API key, every
chain). Beyond one-shot transfers: payment requests (invoices), recurring rules,
cross-chain bridges (Chainlink CCIP for USDC, LayerZero OFT for USDT), stablecoin yield,
Q staking, non-custodial escrow, and RedStone price/NAV triggers. Every settlement leaves
a signed Trust Receipt.

---

## Quickstart

**Dashboard** - sign up at [q402.quackai.ai](https://q402.quackai.ai) with Google, email,
or a wallet for live + sandbox keys, transaction history, and Gas Tank balances.

**Browser SDK** - drop it into any page with `window.ethereum`:

```html
<script src="https://q402.quackai.ai/q402-sdk.js"></script>
<script>
  const q402 = new Q402Client({ apiKey: "q402_live_…", chain: "bnb" });
  await q402.pay({ to: recipient, amount: "10.00", token: "USDT" });
</script>
```

The SDK handles EIP-712 + EIP-7702 + the relay POST. The user signs once.

**AI agent (MCP)** - one line, then ask your agent to finish setup:

```bash
claude mcp add q402 -- npx -y @quackai/q402-mcp
# or: codex mcp add q402 -- npx -y @quackai/q402-mcp
```

Then say **"Set up Q402"**. The agent runs `q402_doctor`, creates `~/.q402/mcp.env`, and
walks you through pasting keys in your editor (never in chat). Per-client configs (Cursor,
Cline, Copilot, Hermes) and the full tool surface are on [/claude](https://q402.quackai.ai/claude).

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
| Base | 8453 | USDC, USDT | live |
| Robinhood Chain | 4663 | USDG | live |

RLUSD is Ethereum-only (issuer constraint, 18 decimals). Robinhood Chain is USDG-only
(Paxos, 6 decimals). Injective supports native Circle USDC (CCTP) + USDT.

---

## MCP tools

**46 tools across nine capabilities** (Payments & wallet, Treasury memory, Recurring,
Bridge, Yield, Staking, Payment requests, Escrow, Triggers). Read-only by default; live
mode needs a live API key, a signing path, and an explicit in-chat confirmation. The nine
fund-moving tools use two-phase consent: the first call returns a `needs_confirmation`
preview plus a `consentToken`, and only a re-call with that token executes.

Full grouped reference: the [`@quackai/q402-mcp` README](https://github.com/quackai-org/q402-mcp#tools-exposed)
and [/claude](https://q402.quackai.ai/claude).

---

## Security model

- **EIP-712 witness** (`TransferAuthorization`) proves the user authorized this exact transfer (owner / token / recipient / amount / nonce / deadline).
- **EIP-7702 authorization** delegates the EOA to the pinned Q402 impl for one tx, via ethers' native `Wallet.authorize()`. Reversible anytime with `q402_clear_delegation`; the next payment recreates it.
- **Authorization lock**: the relay route pins `authorization.chainId` + `address` to `contracts.manifest.json` at request time, so a client cannot smuggle a different impl contract.
- **Replay**: every settled tx hash is sealed in KV (`used_txhash:{hash}`); the same on-chain tx cannot activate a subscription twice.
- **Custody**: on user-signed payments the key signs locally and never leaves the device. Agent Wallets use an encrypted, server-managed key (Mode C) bounded by per-transaction and daily caps.

More: the [EIP-7702 delegation guide](https://q402.quackai.ai/docs#eip-7702-delegation) and `/docs`.

---

## Contract addresses

The single source of truth for chain × contract pinning is
[`contracts.manifest.json`](contracts.manifest.json): payment impls, bridge senders,
token addresses, and EIP-712 domains, per chain. Reference sender-contract sources
(kept verbatim as deployed) live in [`contracts/`](contracts/).

---

## Develop

```bash
git clone https://github.com/bitgett/Q402-Institutional.git
cd Q402-Institutional && npm install
cp .env.example .env.local   # fill in the values you have; .env* is gitignored
npm run dev                  # http://localhost:3000
```

`npm test` runs the vitest suite + drift guards. Architecture, the auth model, the
tech stack, and the repository layout are documented in `/docs`.

---

## Links

- SDK: [public/q402-sdk.js](public/q402-sdk.js)
- MCP: https://www.npmjs.com/package/@quackai/q402-mcp
- Docs: https://q402.quackai.ai/docs
- Live: https://q402.quackai.ai
- Free trial: https://q402.quackai.ai/event
- Contact: business@quackai.ai

---

© Quack AI. Apache-2.0 licensed (see [LICENSE](LICENSE)).
