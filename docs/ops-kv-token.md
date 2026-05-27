# Operational note — `KV_REST_API_TOKEN` blast radius

The `KV_REST_API_TOKEN` granted to Vercel-managed Upstash KV is
namespace-wide SET / GET / DEL. There is no token-shape change we can
make in application code to shrink this — it's an Upstash dashboard
configuration. This note exists so the operator knows the residual
risk and the (out-of-code) mitigations.

## What an attacker with the token can do

1. **Overwrite any KV record.** Including `aw:{owner}:{walletId}`
   keystore blobs. They CANNOT read existing private keys without
   `KEY_ENCRYPTION_KEY` (the keystore is AES-256-GCM-wrapped), but
   they can destructively overwrite, locking the legitimate owner
   out of their Agent Wallet. Funds on-chain become unreachable.
2. **Poison content-addressed metadata.** `aw:agent-md:{hash}` is
   keyed by the hash of its contents (keccak256 of canonical JSON),
   so they cannot replace a legit user's metadata with different
   content under the same hash (collision resistance). But they CAN
   write a brand-new hostile metadata blob under any hash they
   compute, and then mint an ERC-8004 NFT pointing at that URI
   from any wallet they control. Their NFT, their owner — the
   public resolver stays honest, but the registry gets polluted.
3. **Burn idempotency slots.** Overwrite `aw:send:{fp}` to fake a
   "complete" record so legitimate sends are blocked, or wipe
   `aw:list:{owner}` to orphan an owner's wallets.

## What they CANNOT do

- Read encrypted private keys without `KEY_ENCRYPTION_KEY` (which
  lives in a different Vercel env scope).
- Sign on-chain transactions (KV holds ciphertext, not keys).
- Bypass the relay's own `Q402-SEC-001` ordering or the apiKey
  freshness gate — those validate against in-process state, not KV.

## Why the codebase can't fix this

Upstash REST tokens have no built-in key-prefix scoping. The
`@vercel/kv` integration provisions a single full-namespace token.
A "scoped-by-prefix" feature would have to be:
  - an Upstash dashboard configuration on the operator side, OR
  - a multi-namespace split (e.g. `aw:agent-md:*` in a separate KV
    instance with its own token), OR
  - a thin proxy in front of KV that applies prefix ACLs.

None of those are code changes in this repo.

## Mitigations (operator-side)

1. **Rotate the token periodically.** Vercel → Storage → your KV
   instance → REST API → "Rotate Token". Code reads the env, so a
   rotation + Vercel redeploy picks it up on next cold start.
2. **Restrict where the token lives.** It's in `.env.local` for
   local dev + the Vercel env for prod. Do not paste it into
   chat, screenshots, or CI logs.
3. **Two-instance split (defensive).** Move public-facing
   content (`aw:agent-md:*`) to a separate KV instance with its
   own token. A leak of the keystore-instance token then can't
   poison the metadata namespace, and vice versa. Adds operational
   complexity — defer until incident pressure.
4. **Monitor.** Upstash exposes per-token request counts. A spike
   on a token outside expected windows is the signal.

## What we DID fix in code

- `aw:{owner}` lazy-migration writes use `SET NX` so a token holder
  can't force a partial migration into a clobbering state.
- `aw:create-lock:{owner}` is a real serialisation lock, not a
  cosmetic flag.
- Idempotency claims (`aw:send:*`, `aw:batch:*`, `aw:register-tx:*`)
  use `SET NX` everywhere, so a token holder writing a fake
  "processing" record blocks NEW sends but doesn't poison settled
  state.

The remaining gap is the destructive overwrite-of-keystore-blobs
scenario. That requires Upstash-side scoping, documented above.
