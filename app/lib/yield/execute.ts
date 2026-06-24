/**
 * Q402 Yield — shared deposit/withdraw handler.
 *
 * Orchestrates: auth (intent-bound OR Mode-C apiKey) → resolveWallet +
 * decrypt key → YieldPolicy gate (Hooks) → idempotency claim → sign
 * (yield/sign) → settle via relayer (yield/relay) → KV position update +
 * Trust Receipt. Mirrors the Agent Wallet /send route's trust model.
 *
 * Fails closed: if the v2 impl isn't deployed (no YIELD_IMPL_<CHAIN>),
 * signYieldAction throws and the route returns 503 — no funds move.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { isChainDisabled, CHAIN_DISABLED_MESSAGE } from "@/app/lib/chain-status";
import {
  decryptPrivateKey,
  resolveWallet,
  isKeystoreReady,
  acquireWalletChainLock,
  releaseWalletChainLock,
} from "@/app/lib/agentic-wallet";
import {
  getApiKeyRecord,
  getSubscription,
  hasMultichainScope,
  isCashPaidSubscription,
  getScopedCredits,
  recordRelayedTx,
  type CreditScope,
} from "@/app/lib/db";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { isAgenticChainKey, type AgenticChainKey, type AgenticToken } from "@/app/lib/agentic-wallet-sign";
import { signYieldAction, type YieldAction } from "./sign";
import { listAllPositions, listAllPositionsStrict } from "./index";
import {
  settleYieldAction,
  yieldFacilitator,
  chargeYieldOpBudget,
  refundYieldOpBudget,
} from "./relay";
import { enforceYieldPolicy, readTokenBalanceStrict } from "./policy";
import type { Hex, Address } from "viem";

interface YieldBody {
  walletId?: string;
  chain?: string;
  token?: AgenticToken;
  amount?: string;       // human decimal; "max" allowed for withdraw
  ownerAddress?: string;
  nonce?: string;        // challenge (intent auth)
  signature?: string;
  apiKey?: string;
  /** Optional client-supplied key for durable (no-TTL) replay protection
   *  across distinct same-amount requests. Without it, only the 30-min
   *  rapid-retry claim applies. */
  idempotencyKey?: string;
}

const IDEMPOTENCY_TTL_SEC = 30 * 60;

/**
 * Durable (no-TTL) settled marker. `fingerprint` (action:chain:token:amount)
 * is CONTENT-BINDING (FIX 4): a reused idempotencyKey is only treated as a
 * replay when its request fingerprint matches the stored one — otherwise the
 * key was reused for a different op and we must NOT replay this tx. Optional
 * for back-compat with pre-FIX-4 markers (a missing value reads as a match).
 */
interface YieldSettledMarker {
  txHash?: string;
  action?: string;
  amount?: string;
  fingerprint?: string;
  at?: string;
}

/**
 * Write the durable (no-TTL) settled marker with bounded retry. The
 * settlement already landed on-chain, so a transient KV blip here must not
 * be the reason a post-TTL retry double-fires. Returns false if all attempts
 * fail — the caller then pages ops AND keeps the short-lived claim alive so a
 * near-term replay is still blocked. Mirrors send route's writeSettledMarker.
 */
async function writeYieldSettledMarker(key: string, marker: YieldSettledMarker): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await kv.set(key, marker);
      return true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return false;
}

function isPositiveDecimal(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}

async function resolveOwner(body: YieldBody, action: YieldAction): Promise<string | NextResponse> {
  // Owner-sig (intent-bound)
  if (typeof body.signature === "string" && body.signature.length > 0) {
    if (!body.walletId || typeof body.walletId !== "string") {
      return NextResponse.json({ error: "INVALID_INTENT_FOR_AUTH" }, { status: 400 });
    }
    const result = await requireIntentAuth({
      address: body.ownerAddress ?? null,
      challenge: body.nonce ?? null,
      signature: body.signature ?? null,
      action: action === "supply" ? "agentic.yield_deposit" : "agentic.yield_withdraw",
      intent: {
        walletId: body.walletId.toLowerCase(),
        chain: body.chain ?? "",
        token: body.token ?? "",
        amount: body.amount ?? "",
      },
    });
    if (typeof result !== "string") {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return result;
  }

  // Mode C — live apiKey only
  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
      return NextResponse.json({ error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey." }, { status: 401 });
    }
    const rec = await getApiKeyRecord(body.apiKey);
    if (!rec || !rec.active || rec.isSandbox) {
      return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
    }
    if (typeof body.ownerAddress === "string" && body.ownerAddress.length > 0
      && rec.address.toLowerCase() !== body.ownerAddress.toLowerCase()) {
      return NextResponse.json({ error: "OWNER_MISMATCH" }, { status: 403 });
    }
    return rec.address.toLowerCase();
  }

  return NextResponse.json({ error: "AUTH_REQUIRED", message: "Provide a signature or apiKey." }, { status: 401 });
}

export async function handleYieldAction(req: NextRequest, action: YieldAction): Promise<NextResponse> {
  if (!(await rateLimit(getClientIP(req), `yield-${action}`, 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: YieldBody;
  try {
    body = (await req.json()) as YieldBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  // Held chains (chain-status.ts): yield settles via its own EIP-7702 path
  // (yield/relay.ts), separate from settlePayment, so it needs its own gate.
  // SUPPLY ONLY — WITHDRAW must ALWAYS be allowed (fund recovery, see P0 note
  // below). Holding a chain (e.g. during an impl refresh) must never block a
  // user from recovering funds already supplied there; the contract's own
  // guards still protect the on-chain withdraw.
  if (action === "supply" && isChainDisabled(body.chain)) {
    return NextResponse.json({ error: CHAIN_DISABLED_MESSAGE }, { status: 400 });
  }
  if (body.token !== "USDC" && body.token !== "USDT") {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 400 });
  }
  const isMaxWithdraw = action === "withdraw" && typeof body.amount === "string" && body.amount.trim().toLowerCase() === "max";
  if (!isMaxWithdraw && !isPositiveDecimal(body.amount)) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  const chain = body.chain as AgenticChainKey;
  const token = body.token as AgenticToken;
  const amount = body.amount as string;

  const owner = await resolveOwner(body, action);
  if (owner instanceof NextResponse) return owner;

  // Subscription / entitlement gate — mirror EXACTLY what /api/wallet/
  // agentic/send requires to authorize a BNB payment. Yield previously
  // only checked the apiKey was active+live (Mode C) or that the owner
  // signature verified (owner-sig) — neither confirmed the owner holds a
  // live trial/subscription, so an active Trial key (or any owner sig)
  // could move funds via Yield even when an equivalent BNB /send would be
  // gated. We bind to the SAME tier rule /send applies for the chain.
  // FUND-SAFETY (P0): WITHDRAW must ALWAYS be allowed. Recovering your own
  // funds from Aave can never be blocked by a subscription/key entitlement,
  // trial/paid EXPIRY, or drained CREDITS — otherwise an expired account's
  // funds would be locked in Aave forever. The policy already permits
  // withdraw unconditionally; mirror that here. The whole entitlement +
  // expiry + credit gate below therefore applies to SUPPLY (deposit) only.
  // Withdraw is still owner-authenticated (intent-bound) above and still
  // passes the per-owner daily op-budget rail (a generous gas cap, NOT a
  // subscription block).
  if (action === "supply") {
  const sub = await getSubscription(owner);
  // PRODUCT DECISION: Q402 Yield is a PAID feature — Trial accounts cannot
  // deposit. This also settles the "who pays Trial-yield gas" question
  // (nobody — Trial can't deposit). Require a paid Multichain subscription
  // to SUPPLY. WITHDRAW is exempt from this whole gate (above), so a user
  // who deposited while paid can ALWAYS recover funds even after downgrade
  // or expiry.
  if (!hasMultichainScope(sub)) {
    return NextResponse.json(
      {
        error: "YIELD_REQUIRES_PAID",
        message:
          "Q402 Yield deposits require a paid Multichain plan. Upgrade at /payment. " +
          "(Withdrawals are always allowed.)",
      },
      { status: 402 },
    );
  }
  // (2) Live-key entitlement — the BNB tier rule /send enforces. The owner
  // must hold a live trial OR paid apiKey; a presented Mode-C apiKey must be
  // the CURRENT trial or paid key (not a stale/rotated one), and a Trial key
  // may only settle on BNB.
  const presentedApiKey =
    typeof body.apiKey === "string" && body.apiKey.length > 0 ? body.apiKey : undefined;
  if (presentedApiKey) {
    const isTrial = presentedApiKey === sub?.trialApiKey;
    const isPaid = presentedApiKey === sub?.apiKey;
    if (!isTrial && !isPaid) {
      return NextResponse.json(
        {
          error: "STALE_API_KEY",
          message:
            "This apiKey is no longer the live trial or multichain key. " +
            "Rotate to the current key in your dashboard and retry.",
        },
        { status: 401 },
      );
    }
    // Q402 Yield deposits are PAID-only (multichain scope is required above), so
    // a Trial key must never settle a deposit — not even on BNB. Presenting it
    // would otherwise scope the deposit to the trial credit pool + trial expiry
    // and could wrongly TRIAL_EXPIRED a paid user. Require the Multichain key
    // (or owner-sig). This is the SUPPLY branch, so it applies to deposits only.
    if (isTrial) {
      return NextResponse.json(
        {
          error: "YIELD_REQUIRES_PAID_KEY",
          message:
            "Q402 Yield deposits must use your Multichain API key, not the Trial key. " +
            "Present the Multichain key, or omit apiKey and sign the owner challenge.",
        },
        { status: 402 },
      );
    }
  } else {
    // Owner-sig path: same effective gate /send applies — the owner must
    // have a live trial (BNB) or paid apiKey provisioned, else there is no
    // entitlement to settle.
    const effectiveKey = chain === "bnb" ? sub?.trialApiKey || sub?.apiKey : sub?.apiKey;
    if (!effectiveKey) {
      return NextResponse.json(
        { error: "NO_API_KEY", message: "Activate a Q402 trial or subscription before using Q402 Yield." },
        { status: 402 },
      );
    }
  }

  // (3) Trial EXPIRY + paid EXPIRY + credit headroom — the SAME entitlement
  // gate /api/relay enforces for a BNB payment (which /send delegates to via
  // submitToRelay). Yield never goes through /api/relay — it settles directly
  // via settleYieldAction — so without re-applying these here an EXPIRED or
  // credit-drained trial whose key still matches would pass the key-match
  // check above and drain relayer gas. We mirror relay/route.ts sections 4
  // (expiry) + 4a (credit pre-check) verbatim, scoped to the effective key.
  //
  // Which key/scope this call settles against (relay route's
  // `isTrialScopedKey`): a presented Trial key, OR the owner-sig BNB path
  // resolving to the trial key, is trial-scope; everything else is paid.
  // For owner-sig BNB the trial key is used ONLY when the owner has no paid
  // multichain scope. A paid user who still holds a (now-expired) trial key
  // must NOT resolve to trial scope here — /api/relay scopes a paid BNB pay on
  // the paid key, so an expired trial would otherwise wrongly TRIAL_EXPIRED a
  // paid user's Yield deposit. When the trial is the owner's ONLY entitlement
  // it wins (trial expiry + trial credit pool gate the action), matching /send.
  const usingTrialKey =
    !!(presentedApiKey && presentedApiKey === sub?.trialApiKey) ||
    (!presentedApiKey && chain === "bnb" && !!sub?.trialApiKey && !hasMultichainScope(sub));
  const yieldScope: CreditScope = usingTrialKey ? "trial" : "paid";

  if (sub) {
    if (usingTrialKey) {
      // Trial-scope expiry — keyed on trialExpiresAt (relay route §4).
      if (!sub.trialExpiresAt || new Date() >= new Date(sub.trialExpiresAt)) {
        return NextResponse.json(
          { error: "TRIAL_EXPIRED", message: "Trial expired. Upgrade at /payment to continue." },
          { status: 403 },
        );
      }
    } else if (isCashPaidSubscription(sub)) {
      // Paid-scope expiry — paidAt + 30d window (relay route §4). Operational
      // grants (amountUSD === 0) are non-expiring; isCashPaidSubscription is
      // false for those so this window is skipped, exactly as in /api/relay.
      const expiresAt = new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() >= expiresAt) {
        return NextResponse.json(
          { error: "SUBSCRIPTION_EXPIRED", message: "Subscription expired. Please renew to continue." },
          { status: 403 },
        );
      }
    }
  }
  // Credit headroom — relay route §4a quick pre-check (stale OK; the cap is a
  // gas-budget rail, not a per-tx charge — yield is fee-free). A trial key
  // reads the trial pool, a paid key the paid pool. Zero credits → 429, the
  // same status + scope-specific message /api/relay returns.
  {
    const credits = await getScopedCredits(owner, yieldScope);
    if (credits <= 0) {
      return NextResponse.json(
        {
          error: yieldScope === "trial"
            ? "No trial credits remaining. Upgrade at /payment to continue."
            : "No TX credits remaining. Purchase additional credits to continue.",
        },
        { status: 429 },
      );
    }
  }
  } // end SUPPLY-only entitlement/expiry/credit gate — withdraw is exempt

  const ready = isKeystoreReady();
  if (!ready.ok) {
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  const wallet = await resolveWallet(owner, body.walletId ?? null);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  // Archived (soft-deleted) wallets must not DEPOSIT, but WITHDRAW must always
  // be allowed so an owner can recover Aave funds from an archived wallet even
  // after the 7-day restore grace lapses. The GC keeps the key while the Aave
  // balance > 0 (funds are never destroyed), but blocking withdraw here left
  // recovery ops-only — exempting withdraw makes it self-serve. Mirrors the
  // supply-only entitlement gate above (withdraw is exempt from those too).
  if (action === "supply" && wallet.deletedAt && Date.now() >= wallet.deletedAt) {
    return NextResponse.json({ error: "AGENTIC_WALLET_ARCHIVED" }, { status: 410 });
  }
  const walletAddr = wallet.address.toLowerCase();

  // ── Per-wallet+chain settle lock ───────────────────────────────────────
  // Wrap the WHOLE read-check-sign-settle window (maxAllocationPct read,
  // 7702 nonce derivation, sign, settle) in the same SET NX lock idiom the
  // wallet-create path uses, scoped to (wallet, chain). Without it:
  //   - two concurrent deposits each read the SAME pre-deposit balance and
  //     both pass enforceYieldPolicy's maxAllocationPct cap (the read in
  //     policy.ts has no lock), bypassing the cap; and
  //   - sign.ts derives the EIP-7702 auth nonce from the wallet's current
  //     tx count, so two in-flight delegations on one chain reuse the same
  //     nonce → one reverts / collides.
  // Serialising here also serialises a concurrent /send (once /send adopts
  // the same lock) + yield on one wallet. Lock contention surfaces as 409
  // so the caller retries after the in-flight action finishes.
  // SAFE-LEASE: acquire returns a unique token (or null on contention). The
  // token is required at release so a stale holder whose TTL expired can't
  // ABA-delete a fresh holder's lock.
  const lockToken = await acquireWalletChainLock(walletAddr, chain);
  if (!lockToken) {
    return NextResponse.json(
      {
        error: "WALLET_BUSY",
        message: "Another action on this wallet+chain is in flight. Retry in a moment.",
      },
      { status: 409 },
    );
  }
  // Single release point for every path below the lock. Idempotent + best-
  // effort (the TTL is the backstop if KV is down). Compare-and-del with our
  // token so we only ever release the lease we actually hold.
  let lockReleased = false;
  const releaseLock = async () => {
    if (lockReleased) return;
    lockReleased = true;
    await releaseWalletChainLock(walletAddr, chain, lockToken);
  };

  // Request fingerprint for content-bound idempotency (FIX 4). Hoisted (with
  // idemKey + settledKey) above the try so the catch can release the claim.
  const reqFingerprint = `${action}:${chain}:${token}:${amount}`;
  const settledKey = body.idempotencyKey ? `aw:yield:settled:${walletAddr}:${body.idempotencyKey}` : null;
  const idemKey = `aw:yield:idem:${walletAddr}:${action}:${chain}:${token}:${amount}`;
  // Whether THIS request successfully claimed the short-lived idem key — the
  // catch only deletes the claim if we own it (a lock-contention / pre-claim
  // bailout must not clear another in-flight action's claim).
  let idemClaimed = false;
  // Whether THIS request holds a reserved daily yield-op slot. Hoisted so the
  // catch only refunds when a slot was actually reserved (a throw before the
  // charge — e.g. in enforceYieldPolicy — must not decrement someone else's).
  let opReserved = false;

  try {
    // YieldPolicy gate (Hooks) — max allocation, asset/protocol allowlist,
    // etc. Fails closed on policy denial. Now read-checked UNDER the lock so
    // the cap can't be raced.
    const policy = await enforceYieldPolicy({ owner, walletId: walletAddr, chain, asset: token, action, amount });
    if (!policy.allow) {
      await releaseLock();
      return NextResponse.json({ error: "YIELD_POLICY_DENIED", code: policy.code, message: policy.reason }, { status: 403 });
    }

    // Facilitator must be the relayer (the v2 contract enforces
    // msg.sender == facilitator). Resolve before signing.
    const facilitator = yieldFacilitator();
    if (!facilitator) {
      await releaseLock();
      return NextResponse.json({ error: "relayer_unavailable" }, { status: 503 });
    }

    // Durable (no-TTL) replay guard — only when the client supplies an
    // idempotencyKey (so two legitimately-distinct same-amount deposits are
    // not false-blocked). Read fail-closed: a storage error here must not let
    // a possibly-already-settled action through.
    //
    // CONTENT-BOUND (FIX 4): the marker now stores the request fingerprint
    // (action+chain+token+amount). A durable hit is treated as a REPLAY only
    // when the stored fingerprint equals THIS request's fingerprint —
    // otherwise the client reused the key for a different op and we must NOT
    // replay the old tx; we proceed as a new operation. (The MCP is moving to
    // fresh per-call keys separately; this is the server-side guard.)
    if (settledKey) {
      let prior: YieldSettledMarker | null;
      try {
        prior = await kv.get<YieldSettledMarker>(settledKey);
      } catch {
        await releaseLock();
        return NextResponse.json({ error: "idempotency_unavailable" }, { status: 503 });
      }
      if (prior) {
        // Legacy markers (pre-FIX-4) have no `fingerprint` field. Treat a
        // missing fingerprint as a match (the pre-fix behaviour) so a marker
        // written before this deploy still blocks an exact-same-key replay.
        const priorFp = prior.fingerprint;
        if (priorFp === undefined || priorFp === reqFingerprint) {
          await releaseLock();
          return NextResponse.json({ status: "ok", idempotent: true, txHash: prior.txHash });
        }
        // Mismatched fingerprint — the client reused an idempotency key for a
        // DIFFERENT operation (action/chain/token/amount). Reject rather than
        // silently executing a NEW on-chain action under a key the client
        // believes is already settled: that's a client bug and could
        // double-move funds. Standard idempotency-key semantics (409).
        await releaseLock();
        return NextResponse.json(
          {
            error: "idempotency_key_reused",
            message:
              "This idempotency key was already used for a different operation. " +
              "Use a fresh key for a new action, or repeat the EXACT original request to replay it.",
          },
          { status: 409 },
        );
      }
    }

    // Idempotency — dedupe rapid identical retries (each sign generates a
    // fresh on-chain nonce, so without this a double-submit = double action).
    const claimed = await kv.set(idemKey, { at: Date.now(), status: "pending" }, { nx: true, ex: IDEMPOTENCY_TTL_SEC });
    if (!claimed) {
      await releaseLock();
      const prior = await kv.get<{ status: string; txHash?: string }>(idemKey);
      return NextResponse.json(
        { error: "duplicate_request", message: "An identical yield action was just submitted.", prior },
        { status: 409 },
      );
    }
    idemClaimed = true;

    // ── Per-owner daily yield-op cap (FIX 2 — relayer gas-abuse rail) ──────
    // Yield is fee-free: the relayer pays Aave gas with no per-op credit
    // decrement. Reserve one op against the owner's daily cap BEFORE settle
    // so a valid-but-abusive caller can't loop deposits/withdraws and drain
    // the relayer's gas wallet. Both supply AND withdraw cost relayer gas, so
    // both consume a slot. Refunded below on any non-settlement.
    const opBudget = await chargeYieldOpBudget(owner);
    opReserved = opBudget.allowed;
    if (!opBudget.allowed) {
      await kv.del(idemKey).catch(() => {});
      await releaseLock();
      return NextResponse.json(
        {
          error: "YIELD_DAILY_OP_CAP",
          message: `Daily Q402 Yield operation cap reached (${opBudget.cap}/day). Retry tomorrow.`,
          cap: opBudget.cap,
        },
        { status: 429 },
      );
    }
    // Release the op-budget slot on any path that does NOT confirm a
    // settlement (mirrors refundDailySpend on the /send route).
    const refundOp = async () => {
      if (!opReserved) return;
      opReserved = false;
      await refundYieldOpBudget(owner);
    };

    let privateKey: Hex;
    try {
      privateKey = decryptPrivateKey(wallet) as Hex;
    } catch {
      await refundOp();
      await kv.del(idemKey).catch(() => {});
      await releaseLock();
      return NextResponse.json({ error: "key_decrypt_failed" }, { status: 503 });
    }

    // Exact-token balance preflight (supply only). The policy's allocation guard
    // sums USDC+USDT, so a USDC deposit by a wallet holding only USDT could pass
    // it and then revert on-chain, burning relayer gas. Confirm the wallet holds
    // `amount` of the EXACT token before we sign + settle.
    if (action === "supply") {
      let tokenBal: number;
      try {
        tokenBal = await readTokenBalanceStrict(chain, walletAddr as Address, token);
      } catch {
        await refundOp();
        await kv.del(idemKey).catch(() => {});
        await releaseLock();
        return NextResponse.json({ error: "BALANCE_READ_FAILED", message: "Could not read your token balance for the deposit." }, { status: 503 });
      }
      if (Number(amount) - tokenBal > 1e-6) {
        await refundOp();
        await kv.del(idemKey).catch(() => {});
        await releaseLock();
        return NextResponse.json(
          { error: "INSUFFICIENT_TOKEN_BALANCE", message: `Wallet holds ${tokenBal} ${token} on ${chain}; need ${amount} to deposit.` },
          { status: 400 },
        );
      }
    }

    // Withdraw preflight — confirm the wallet holds a position for this
    // (chain, token) before signing. Without it a withdraw on a chain where the
    // wallet has nothing (e.g. the UI defaulting to BNB-Aave while the position
    // is Base-Morpho) sails through to an on-chain revert that burns relayer gas
    // and surfaces only as "Transaction reverted". STRICT read so a transient
    // RPC error fails OPEN — withdrawal availability is sacred, we never block
    // fund recovery on a flaky read; only a clean read with no position rejects.
    let withdrawPositions: Awaited<ReturnType<typeof listAllPositionsStrict>> | null = null;
    if (action === "withdraw") {
      try {
        withdrawPositions = await listAllPositionsStrict(chain, walletAddr);
      } catch {
        withdrawPositions = null; // read failed — fall through, let the chain decide
      }
      if (withdrawPositions) {
        const pos = withdrawPositions.find((p) => p.asset === token);
        const bal = pos ? Number(pos.balance) : 0;
        if (!pos || !(bal > 0)) {
          await refundOp();
          await kv.del(idemKey).catch(() => {});
          await releaseLock();
          return NextResponse.json(
            { error: "NO_POSITION", message: `No ${token} position to withdraw on ${chain}. Switch to the chain holding your funds.` },
            { status: 400 },
          );
        }
        if (amount !== "max" && Number(amount) - bal > 1e-6) {
          await refundOp();
          await kv.del(idemKey).catch(() => {});
          await releaseLock();
          return NextResponse.json(
            { error: "INSUFFICIENT_POSITION", message: `Position is ${bal} ${token} on ${chain}; cannot withdraw ${amount}.` },
            { status: 400 },
          );
        }
      }
    }

    const signed = await signYieldAction({ privateKey, expectedOwner: wallet.address as Address, chain, token, action, amount, facilitator });

    // For a withdraw-all ("max"), the exact drawn amount isn't known at sign
    // time, so signed.amount is the "max" sentinel. Capture the redeemable
    // aToken balance NOW (pre-settlement; post-withdraw it would read ~0) so
    // the activity row shows the real number instead of "max". Best-effort:
    // on read failure we keep the sentinel, which ActivityView renders as "All".
    let displayAmount = signed.amount;
    if (action === "withdraw" && signed.amount === "max") {
      try {
        const positions = withdrawPositions ?? await listAllPositions(chain, walletAddr);
        const pos = positions.find((p) => p.asset === token);
        if (pos && Number.isFinite(Number(pos.balance)) && Number(pos.balance) > 0) {
          displayAmount = pos.balance;
        }
      } catch {
        /* keep the "max" sentinel — display falls back to "All" */
      }
    }

    const result = await settleYieldAction(signed);

    // Broadcast-but-unconfirmed: the action MAY have settled. Do NOT release
    // the claim (a retry could double it) — mark uncertain + alert ops. The
    // wallet-chain lock IS released (TTL-bounded anyway) so the wallet isn't
    // stuck; the alive claim + ops alert are the replay guard here. The
    // op-budget slot is NOT refunded — the tx was broadcast, so relayer gas
    // was (probably) spent; the cap exists to bound exactly that gas spend.
    if (result.uncertain) {
      await kv.set(idemKey, { at: Date.now(), status: "uncertain", txHash: result.txHash }, { ex: IDEMPOTENCY_TTL_SEC }).catch(() => {});
      await sendOpsAlert(
        `Q402 Yield ${action} UNCERTAIN — wallet ${walletAddr} ${amount} ${token} on ${chain}, tx ${result.txHash} broadcast but receipt unconfirmed. Verify on-chain before any retry.`,
      ).catch(() => {});
      await releaseLock();
      return NextResponse.json(
        { error: "settlement_uncertain", txHash: result.txHash, message: "Broadcast but unconfirmed — do not retry; verify on-chain." },
        { status: 502 },
      );
    }

    if (!result.success) {
      // On-chain revert — the relayer STILL paid gas for the broadcast, so
      // the op-budget slot stays consumed (the cap bounds relayer gas spend,
      // including reverts an abusive caller could spam). Only the short-lived
      // idem claim is released so an honest user can retry the corrected op.
      await kv.del(idemKey).catch(() => {});
      await releaseLock();
      return NextResponse.json({ error: "settlement_failed", message: result.error }, { status: 502 });
    }

    // Position tracking (best-effort): principal in human units.
    await updateYieldPosition(walletAddr, chain, token, action, signed.amount).catch(() => {});

    const receipt = {
      action: action === "supply" ? "yield_deposit" : "yield_withdraw",
      protocol: signed.protocol,
      chain,
      asset: token,
      amount: signed.amount,
      pool: signed.pool,
      txHash: result.txHash,
      blockNumber: result.blockNumber ? String(result.blockNumber) : undefined,
      at: new Date().toISOString(),
    };
    // Keep the short-lived claim at full TTL so the same fingerprint is
    // blocked from re-firing for the next 30 min (the near-term replay
    // window). This is also our fallback guard if the durable marker write
    // below fails.
    await kv.set(idemKey, { at: Date.now(), status: "settled", txHash: result.txHash }, { ex: IDEMPOTENCY_TTL_SEC }).catch(() => {});

    // Durable marker (no TTL) for cross-window replay protection. This must
    // NOT fail silently: if the write fails after an on-chain settlement, a
    // request lost after the 30-min claim TTL could re-execute the same
    // deposit (the MCP doesn't always send an idempotencyKey). Bounded-retry,
    // then — on durable failure — page ops (same mechanism as the uncertain
    // path) and RE-EXTEND the short-lived claim so a near-term replay is
    // still blocked while ops reconciles. Fail loud, not silent.
    //
    // CONTENT-BOUND (FIX 4): persist `fingerprint` so a future reuse of this
    // idempotencyKey with a DIFFERENT op is detected (mismatch → not a
    // replay) instead of returning this tx for an unrelated request.
    if (settledKey) {
      const ok = await writeYieldSettledMarker(settledKey, {
        txHash: result.txHash,
        action: receipt.action,
        amount: signed.amount,
        fingerprint: reqFingerprint,
        at: receipt.at,
      });
      if (!ok) {
        // Re-extend the short-lived claim (the durable guard didn't land, so
        // this 30-min window is the only thing standing between a lost
        // response and a double-deposit). Best-effort — if KV is fully down
        // even this may fail, but the ops alert below ensures a human reacts.
        await kv
          .set(idemKey, { at: Date.now(), status: "settled", txHash: result.txHash }, { ex: IDEMPOTENCY_TTL_SEC })
          .catch(() => {});
        await sendOpsAlert(
          `Q402 Yield DURABLE marker write failed (after retries) — wallet ${walletAddr} ` +
            `${signed.amount} ${token} ${action} on ${chain}, tx ${result.txHash}. ` +
            `Settled on-chain but idempotency NOT durably recorded; a retry after the ` +
            `30-min claim TTL could re-execute the same action — verify before replay.`,
          "critical",
        ).catch(() => {});
      }
    }

    await releaseLock();
    // Record to the owner's activity feed so a yield supply/withdraw shows in the
    // dashboard like any other gasless settlement (it IS one — relayer-sponsored
    // EIP-7702). Best-effort: a logging failure must never fail a settled action.
    if (owner && result.txHash) {
      // Tag with the owner's multichain key so the dashboard's scope filter
      // (scopeKeys.has(tx.apiKey)) keeps the row in the multichain scope — an
      // empty apiKey gets filtered out and the settlement never renders.
      const ownerSub = await getSubscription(owner).catch(() => null);
      await recordRelayedTx(owner, {
        apiKey: ownerSub?.apiKey ?? "",
        address: walletAddr,
        chain,
        fromUser: walletAddr,
        toUser: signed.pool,
        tokenAmount: displayAmount,
        tokenSymbol: token,
        gasCostNative: 0,
        relayTxHash: result.txHash,
        relayedAt: receipt.at,
        source: action === "supply" ? "yield_deposit" : "yield_withdraw",
      }).catch(() => {});
    }
    return NextResponse.json({ status: "ok", ...receipt });
  } catch (e) {
    // A throw here is BEFORE any confirmed broadcast (signYieldAction throws
    // pre-broadcast; settleYieldAction returns — never throws — on a broadcast
    // failure, surfacing `uncertain` for the ambiguous case above). So no
    // relayer gas was spent: safe to refund the op slot (if we reserved one),
    // release the claim we own, and let the caller retry.
    if (opReserved) await refundYieldOpBudget(owner).catch(() => {});
    if (idemClaimed) await kv.del(idemKey).catch(() => {});
    await releaseLock();
    const msg = e instanceof Error ? e.message : String(e);
    // Deploy-gated: signYieldAction throws YIELD_IMPL_NOT_DEPLOYED until the
    // audited v2 impl is live → surface as 503 (feature not yet enabled).
    if (msg.includes("YIELD_NO_VAULT")) {
      return NextResponse.json({ error: "yield_token_not_supported", message: "This token is not supported for yield on this chain (Base yield is USDC only)." }, { status: 400 });
    }
    if (msg.includes("YIELD_IMPL_NOT_DEPLOYED") || msg.includes("YIELD_NO_POOL") || msg.includes("YIELD_NO_PROTOCOL")) {
      return NextResponse.json({ error: "yield_not_enabled", message: "Q402 Yield is not enabled on this chain yet." }, { status: 503 });
    }
    return NextResponse.json({ error: "yield_action_failed", message: msg }, { status: 500 });
  }
}

/** Track supplied principal (human units) per wallet/chain/asset in KV. */
async function updateYieldPosition(
  walletId: string, chain: string, asset: string, action: YieldAction, amount: string,
): Promise<void> {
  if (amount === "max" && action === "withdraw") {
    // Full withdraw — clear the tracked principal for this market.
    const key = `aw:yield:${walletId}`;
    const cur = (await kv.get<Record<string, number>>(key)) ?? {};
    delete cur[`${chain}:${asset}`];
    await kv.set(key, cur);
    return;
  }
  const delta = Number(amount) * (action === "supply" ? 1 : -1);
  const key = `aw:yield:${walletId}`;
  const cur = (await kv.get<Record<string, number>>(key)) ?? {};
  const field = `${chain}:${asset}`;
  cur[field] = Math.max(0, (cur[field] ?? 0) + delta);
  await kv.set(key, cur);
}
