# Q402 Escrow x Agent Wallet — server-signed funding (design + plan)

> Goal: an **Agent Wallet can be the escrow buyer/funder**, with the SERVER signing
> the lock/release/dispute on its behalf — exactly the model `POST
> /api/wallet/agentic/send` already uses (server decrypts the wallet key, signs
> the EIP-712 witness + EIP-7702 authorization, relayer sponsors gas). Today the
> escrow buyer is hard-forced to the account owner and the lock is only ever
> client-signed, so a server-managed Agent Wallet cannot fund an escrow. This
> closes that gap and, as a bonus, makes the **dashboard fully self-service**
> (server-signed funding needs no browser 7702).

## Why this is the right altitude
Escrow-lock IS an agentic spend: the Agent Wallet moves its own balance into the
vault. So it must ride the SAME rails a send does — ownership, per-tx + daily
spend caps, intent-bound consent, EIP-7702 — not a bespoke path. Release/dispute
are the buyer authorizing a vault action on already-locked funds (no new spend).
Refund is permissionless (no signer). We reuse the audited agentic-send infra
rather than re-implement signing.

## Precedent we mirror (already shipped + audited)
- `app/lib/agentic-wallet-sign.ts` — `account = privateKeyToAccount(decryptPrivateKey(wallet))`,
  `witnessSig = account.signTypedData(...)`, `auth = account.signAuthorization({chainId, address: impl, nonce: txCount})`, returns `{witnessSig, authorization}`.
- `app/lib/agentic-wallet.ts` — `getAgenticWallet(owner, walletId)` (ownership),
  `decryptPrivateKey(record)` (AAD-bound), `checkDailyLimit(owner, walletId, usd)` + `dailySpendKey` (spend cap), `perTxMaxUsd`.
- `app/api/wallet/agentic/send/route.ts` — Mode A/B (owner-sig, intent-bound challenge) vs Mode C (apiKey, server-mediated); per-tx + daily-cap check + debit; idempotency claim.

## Model
- **buyer resolution (create):** `POST /api/escrow` accepts an optional `walletId`.
  If present, resolve `getAgenticWallet(creatorOwner, walletId)`; require it exists
  + is owned by `creatorOwner` + is active + not archived → `buyer = wallet.address`.
  If absent → `buyer = creatorOwner` (today's behavior, unchanged). A client
  `body.buyer` stays ignored. **Invariant preserved:** the buyer is always the
  creator OR a wallet the creator provably owns — never an arbitrary address.
  Record gains `fundingWalletId?` (the agent wallet id) so the action routes know
  to server-sign.
- **lock (agent-wallet buyer) = server-signed spend:**
  1. Auth = owner session-sig (dashboard) or apiKey (MCP) proving ownership of the
     escrow (creatorOwner == the escrow's creator) AND of the funding wallet.
  2. Spend gates (lock moves the wallet's balance): reject if `amountUsd >
     perTxMaxUsd`; `checkDailyLimit` then debit `dailySpendKey` (USDC/USDT = 1:1
     USD). Same helper + ordering send uses.
  3. Server signs: `signAgenticEscrowLock(chain, wallet, params)` — mirrors send
     but (a) witness = `ESCROW_LOCK_TYPES` over domain `{name:"Q402 Escrow Lock",
     verifyingContract: wallet.address}`, (b) `signAuthorization({address:
     lockImpl})` (NOT the payment impl). Then `settleEscrowLock(...)` broadcasts.
  4. Same durable-marker + reconcile as the client path (unchanged).
- **release / dispute (agent-wallet buyer) = server-signed vault action:** owner
  authorizes; server signs the `EscrowRelease` / `EscrowDispute` vault message with
  the wallet key (no spend recheck — funds already locked). Refund stays
  permissionless (no signer, no gate).
- **owner-EOA buyer:** unchanged — client-signed (MCP local key / browser 7702).

## Surfaces / files
1. `app/lib/escrow.ts` — record + `fundingWalletId?`, `toPublicEscrow` exposes a
   `fundedBy` hint (owner|agent) but NOT the walletId internals.
2. `app/api/escrow/route.ts` (create) — resolve `walletId` → verified agent-wallet
   buyer; store `fundingWalletId`.
3. `app/lib/escrow-agentic-sign.ts` (NEW) — `signAgenticEscrowLock` +
   `signAgenticEscrowVaultAction(kind)` (release/dispute). Reuses
   `decryptPrivateKey` + viem account signing; delegates to lockImpl.
4. `app/api/escrow/[id]/[action]/route.ts` — branch: if `rec.fundingWalletId` +
   owner authorizes + owns the wallet → server-sign path (with spend gate on
   lock). Else current client-signed path. Never mixes authorities.
5. `mcp-server` — `q402_escrow_create` gains optional `walletId`;
   lock/release/dispute detect a server-managed funding wallet and call the server
   (no local key needed); Mode B exported key still allowed.
6. Dashboard — composer "Fund from: [Owner EOA | Agent Wallet X]"; agent-wallet
   escrows fund/release/dispute via the server path (owner-authed, no browser
   7702) → create+fund+settle fully in-browser.

## Security invariants (must hold)
- buyer ∈ {creator, a wallet the creator owns} — verified server-side, every time.
- Server signs ONLY for a wallet the authenticated owner owns (ownership re-checked
  in the action route, not trusted from the record alone).
- Lock respects the wallet's per-tx + daily spend caps + intent consent (escrow is
  not a limit-bypass).
- On-chain EIP-712 signatures remain the sole fund authority; server signing only
  automates what the wallet's own key would sign. Relayer still just sponsors gas.
- Existing escrow guards (settled marker, action lock, sandbox block, decimals,
  reconcile) unchanged.

## Open questions for PLAN VALIDATION (Stage 2)
- Q1: A standing 7702 delegation to the payment impl (from a prior send) vs the
  lock tx re-delegating to lockImpl — nonce + persistence correctness. (Send
  re-delegates every tx; confirm lock does the same cleanly, and leaving the
  wallet delegated to lockImpl after a lock is safe / the next send re-delegates.)
- Q2: escrowId = keccak256(buyer, salt) with buyer=agent wallet — backend
  deriveEscrowId + vault msg.sender still agree (msg.sender under 7702 = the agent
  wallet EOA). Confirm no drift.
- Q3: Consent shape for the dashboard server-signed path — reuse the send intent
  challenge (owner-sig over the exact escrow action) so it's not a free-fire.
- Q4: Should locking count against the daily cap AND be refundable-to-cap on a
  timeout refund? (Send refunds cap on relay failure; an escrow refund is later +
  permissionless — likely do NOT credit back, document it.)
- Q5: Mode C (apiKey-only) auth for the action routes — how the MCP proves wallet
  ownership without a session sig (apiKey → owner → owns wallet). Mirror send's
  Mode C.
- Q6: Idempotency — a double-fire lock claim (send uses a SET NX claim); escrow
  already has an action lock + on-chain EscrowExists revert. Confirm sufficient.

## Stage 2 — VALIDATION RESULTS (3 adversarial validators; plan HARDENED)
On-chain model verified SOUND against deployed contracts: Q1 (7702 delegation is
last-writer-wins; re-delegation every tx is normal; ERC-7201 nonce slots don't
collide; leaving the wallet delegated to lockImpl is safe, next send re-delegates)
— SOUND. Q2 (deriveEscrowId(agentWallet,salt) == vault keccak256(msg.sender,salt),
msg.sender = agent EOA under 7702) — SOUND. Q3 (witness domain verifyingContract =
wallet.address is what lockImpl's `_domainSeparator()`=address(this) expects) —
SOUND. But these MANDATORY guards must be built (not optional):

**G1 — action-route auth is NET-NEW + load-bearing (highest priority).**
`/api/escrow/[id]/[action]` has ZERO API auth today — the on-chain buyer sig is the
sole authority, producible only by the buyer's key. Moving the key server-side
collapses authority onto this route. The server-sign branch MUST, before any
`decryptPrivateKey`: derive owner from the caller credential (session-sig OR
apiKey), assert `owner === rec.creatorOwner`, assert `getActiveAgenticWallet(owner,
rec.fundingWalletId) !== null`. Branch discriminator = `rec.fundingWalletId` ONLY,
never a client body field.

**G2 — terminal payouts need FRESH intent consent even in Mode C.** release /
dispute / resolve on the server-sign path require a fresh, single-use
intent-bound owner signature (`requireIntentAuth` + `verifyAndConsumeIntent`)
binding `{action, esc_id, onchainEscrowId, chain, seller, amount, fundingWalletId}`.
A bare apiKey MUST NOT release (that would let a leaked key drain escrows). No
copying send's bare Mode C for payouts.

**G3 — chain config from ESCROW config, never the payment config.** The new
signer sources verifyingContract/chainId/lockImpl/facilitator/decimals from
`escrow-contracts.ts` ESCROW_CHAINS (NOT `AGENTIC_CHAINS` — they diverge: different
impl addresses, escrow live only on sepolia+bnb+base). `amount =
ethers.parseUnits(rec.amount, escrowCfg.decimals)` (18 on BNB), sign the raw value.

**G4 — spend caps (lock only), atomic + refund-on-failure.** Use
`chargeAgainstDailyLimit` (atomic reserve, closes TOCTOU) NOT
`checkDailyLimit`+manual debit; check `perTxMaxUsd` first; USD = Number(rec.amount)
(1:1 for USDC/USDT). On ANY lock-failure path (revert/throw/502) call
`refundDailySpend`. A later permissionless REFUND does NOT credit the cap back
(FIRM rule — the daily key is date-scoped/48h-TTL; crediting a later day is unsafe
+ enables churn-griefing). release/dispute/refund do no spend recheck.

**G5 — idempotency: SET NX claim + serialize per WALLET.** Add a SET NX claim keyed
on escrowId (comfortably > receipt wait) so a retry can't double-debit the cap
(the 120s action-lock self-expires; on-chain EscrowExists protects FUNDS but not
the KV cap ledger). Fetch the 7702 auth nonce FRESH at sign time and serialize
against concurrent sends for the same wallet (a stale nonce makes the EVM silently
skip the authorization → lock no-ops at status 1). Confirm the lock landed via
`readEscrowOnchainState == Open`, not tx status.

**G6 — drift guard for the NEW lock witness.** No client ever signs a lock witness
today (browser can't 7702), so the server lock-witness domain/type is unverified.
Extend `__tests__/escrow-witness-drift.test.ts` to pin the server signer's
EscrowLock domain+types to the deployed lockImpl.

**G7 — wallet-delete vs open escrow (funds-stranding).** Block agent-wallet
soft/hard-delete + GC while it has a non-terminal (pending/open/disputed)
agent-funded escrow — else a refund lands at an address whose key was deleted.

**G8 — subscription/chain-scope gate.** The lock rides send's `hasMultichainScope`
gate (Base = non-BNB; trial = BNB-only). 

**Accepted (documented, not fixed):** Mode B (owner-exported key) client-signed
locks are uncapped by construction — the owner holds the raw key, so caps are
advisory once exported. Caps bind only the server-custodied (Mode C / dashboard)
lock path.

## Build order (Stage 3)
Backend first (escrow.ts record + create walletId + escrow-agentic-sign.ts +
action-route server branch with G1/G2/G4/G5 + delete-guard G7 + drift test G6),
verify (lint/build/tests), THEN MCP (walletId + server-path calls), THEN dashboard
(fund-from picker + server-path actions), each with its own verify.
