/**
 * POST /api/wallet/agentic/send
 *
 * Server-mediated single-recipient send from a specific Agent Wallet.
 * Q402 holds the AES-GCM-encrypted private key; signing happens here.
 *
 * Idempotency:
 *   Each send is fingerprinted by
 *     keccak(owner | walletId | chain | token | recipient | amount) [16 hex]
 *   and claimed via SET NX in KV under `aw:send:{fp}` for ~10 minutes.
 *   A retry of the SAME body (even with a fresh action-challenge) within
 *   the window returns the cached `{txHash}` instead of firing again.
 *   This closes the network-timeout double-spend window — the
 *   challenge's single-use guard prevents *signature replay*, the
 *   fingerprint cache prevents *intent retry*.
 *
 * Multi-wallet (Phase 3): the request now requires `walletId` (the
 * lowercased Agent Wallet address). The intent message that the owner
 * signs embeds the walletId so a signature scoped to wallet A can't
 * drain wallet B.
 *
 * Auth modes:
 *   (A) Mode A/B — owner EIP-191 signature with action challenge
 *   (C) Mode C    — apiKey only (server-mediated MCP); no auto-substitution
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { randomBytes } from "node:crypto";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  decryptPrivateKey,
  isKeystoreReady,
  chargeAgainstDailyLimit,
  refundDailySpend,
  resolveWallet,
} from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope, getApiKeyRecord } from "@/app/lib/db";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import {
  isAgenticChainKey,
  signAgenticPayment,
  submitToRelay,
  internalBaseUrl,
} from "@/app/lib/agentic-wallet-sign";
import { runHooks, canonicalJson, type HookParams } from "@/app/lib/hooks";
import type { Address, Hex } from "viem";

export const runtime = "nodejs";
// Explicit budget — Vercel's default function timeout is 10s on Hobby,
// 60s on Pro. We need enough headroom that a slow relay leg doesn't
// kill us mid-flight (the claim TTL below caps how long an alive
// claim can shadow-lock).
export const maxDuration = 60;

// Bumped 10 → 30 min so a slow relay leg (congested mempool, multi-
// chain re-route, RPC retry) doesn't expire the claim while the relay
// is still in-flight — otherwise a client-side retry would slip past
// the SET NX and double-spend. 30 min comfortably exceeds the
// maxDuration of the relay route + Vercel function timeout.
const IDEMPOTENCY_TTL_SEC = 30 * 60;

interface SendBody {
  chain?: string;
  token?: string;
  to?: string;
  amount?: string;
  /**
   * Lowercased Agent Wallet address to send from. Optional in Mode C
   * (omitting defaults to the owner's default wallet), required in
   * owner-sig mode (so the intent message can pin a specific wallet).
   */
  walletId?: string;
  // Mode A/B — intent-bound challenge over the exact send shape.
  ownerAddress?: string;
  nonce?: string;
  signature?: string;
  // Mode C — server-mediated, MCP holds only the apiKey
  apiKey?: string;
  // Q402 Hooks — per-payment hook parameters. Optional; absent means
  // no per-intent hook config (stored per-wallet config still applies).
  hookParams?: HookParams;
  /**
   * Optional client idempotency key. When present, the durable replay marker
   * is scoped to it, so two intentional same-amount payments under DIFFERENT
   * keys both settle (repeats allowed) while a retry reusing the SAME key is
   * deduped. When absent, repeats are allowed (no permanent content block);
   * the 30-min claim still guards same-payment double-clicks.
   */
  idempotencyKey?: string;
}

interface SendRecord {
  /**
   * `processing` is the initial SET NX claim so concurrent identical
   * requests deduplicate before we touch the relay. The first request
   * flips it to `complete` or `failed` once the relay returns; later
   * arrivals see whichever final state is cached.
   *
   * `relay_unreachable_uncertain` is set when the relay HTTP fetch
   * throws after the request has been dispatched — we cannot tell
   * whether the relay broadcast on chain or not. Retries see this
   * status and refuse to re-fire (a fresh witness nonce would double-
   * submit if the original DID broadcast). Manual resolution path:
   * user/ops verifies on chain, then DELs the key to allow retry.
   */
  status: "processing" | "complete" | "failed" | "relay_unreachable_uncertain" | "partial";
  txHash?: string;
  startedAt: number;
  finishedAt?: number;
  relayBody?: unknown;
  relayStatus?: number;
  /** Short id so the dashboard can correlate retries to the original. */
  sendId: string;
  /**
   * MultiPayeeSplit (#3) fan-out result. Present iff the payment was
   * split into N legs. Each leg is its own on-chain settlement; `status`
   * is "complete" when all legs settled, "partial" when some did.
   */
  legs?: Array<{ recipient: string; amount: string; txHash?: string; error?: string }>;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isPositiveDecimalString(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}

/**
 * Canonicalize a decimal-string amount so equivalent formats ("1", "1.0",
 * "01.00") collapse to ONE fingerprint slot — otherwise a caller bypasses the
 * idempotency / durable double-settle guard by reformatting the amount. Pure
 * string ops (NO Number()) so 18-decimal precision is never lost.
 */
function canonicalAmount(a: string): string {
  const [intRaw, fracRaw = ""] = a.trim().split(".");
  const int = intRaw.replace(/^0+(?=\d)/, "");
  const frac = fracRaw.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/**
 * Send-level fingerprint. Mirrors `agenticBatchFingerprint` but binds
 * walletId AND key-scope so retries that differ on those axes don't
 * collide. Key-scope matters because:
 *   - Trial keys can only settle on BNB. A user retrying the same
 *     (recipient, amount) with their Multichain key after a Trial
 *     failure must NOT be deadlocked by the prior failed Trial
 *     attempt's cached `failed` record. Including the scope (or
 *     "owner-sig" sentinel) gives each path its own fingerprint slot.
 *   - apiKey rotation likewise produces a new fingerprint, so a stale-
 *     key failure doesn't trap the legit-key retry.
 *
 * `scope` is one of "trial" | "multichain" | "owner-sig" — the auth
 * mode used to authorise THIS specific call.
 */
function agenticSendFingerprint(
  owner: string,
  walletId: string,
  chain: string,
  token: string,
  to: string,
  amount: string,
  scope: string,
  hookParamsTag: string,
): string {
  const seed = [
    owner.toLowerCase(),
    walletId.toLowerCase(),
    chain,
    token,
    to.toLowerCase(),
    canonicalAmount(amount),
    scope,
    // Hook params (condition / splits / recipientAgentId) change what
    // actually settles — a different split or oracle condition to the
    // same (to, amount) is a DIFFERENT intent and must not collide on
    // one idempotency slot. Empty tag ("none") when no trusted hook
    // params apply, so non-hook sends keep their existing fingerprint.
    hookParamsTag,
  ].join("|");
  return ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(2, 18);
}

function sendKey(fp: string): string {
  return `aw:send:${fp}`;
}

// Durable "this fingerprint produced ≥1 confirmed on-chain settlement"
// marker — written with NO TTL (unlike the 30-min idempotency record).
// The idempotency claim dedups concurrent + recent (<30min) retries; this
// marker is the LONG-TERM replay guard. Without it, a retry of the exact
// same intent (same fp, incl. hookParams) after the 30-min record expires
// would re-sign with a fresh witness nonce and DOUBLE-SETTLE — the
// contract accepts the fresh nonce as a new authorization. Mirrors the
// CCIP bridge's markBridgeSettled. Send-path volume is low (real Agent
// Wallet users only — the viz fires through /api/relay, not here), so
// no-TTL growth is bounded.
function sendSettledKey(fp: string): string {
  return `aw:send:settled:${fp}`;
}

/** Trimmed record stored in the durable settled marker (no large relayBody). */
interface SettledMarker {
  sendId: string;
  status: SendRecord["status"];
  txHash?: string;
  legs?: SendRecord["legs"];
  settledAt: number;
  /** Content fingerprint this idempotency key first settled. A later request
   *  reusing the SAME key with a DIFFERENT payload (different fp) is rejected
   *  409 instead of being replayed the wrong settlement. */
  fp?: string;
}

/**
 * Write the durable settled marker with bounded retry. The settlement
 * already landed on-chain, so a transient KV blip here must not be the
 * reason a post-TTL retry double-fires. Returns false if all attempts
 * fail (caller pages ops for manual reconciliation — there's nothing
 * more we can do once KV is durably down at settlement time).
 */
async function writeSettledMarker(key: string | null, marker: SettledMarker): Promise<boolean> {
  // No client idempotency key → no durable marker (intentional repeats are
  // allowed). Vacuously "written" so callers don't page ops.
  if (!key) return true;
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

/**
 * Resolve owner from auth, given the (already-validated) intent fields.
 * The owner-sig path requires walletId in the body so it can bind to
 * the intent message; Mode C defaults walletId to the owner's default
 * wallet.
 */
async function resolveOwner(
  req: NextRequest,
  body: SendBody,
): Promise<string | NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-send", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Mode A/B — owner EIP-191 signature with intent challenge
  if (typeof body.signature === "string" && body.signature.length > 0) {
    if (
      !isAgenticChainKey(body.chain) ||
      (body.token !== "USDC" && body.token !== "USDT") ||
      !isHexAddress(body.to) ||
      !isPositiveDecimalString(body.amount) ||
      !body.walletId ||
      typeof body.walletId !== "string"
    ) {
      return NextResponse.json({ error: "INVALID_INTENT_FOR_AUTH" }, { status: 400 });
    }
    const result = await requireIntentAuth({
      address: body.ownerAddress ?? null,
      challenge: body.nonce ?? null,
      signature: body.signature ?? null,
      action: "agentic.send",
      intent: {
        walletId: body.walletId.toLowerCase(),
        chain: body.chain,
        token: body.token,
        recipient: body.to.toLowerCase(),
        amount: body.amount,
      },
    });
    if (typeof result !== "string") {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }
    return result;
  }

  // Mode C — apiKey only
  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    // Reject BOTH `q402_test_` AND legacy `q402_sandbox_` prefixes —
    // db.ts still treats both as sandbox in the transaction-iteration
    // path, so a paid-owner-attached legacy q402_sandbox_ key that's
    // still active would otherwise hit this live send route. Matches
    // recurring-by-key + the new bridge route's posture.
    if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
      return NextResponse.json(
        { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for Agent Wallet sends." },
        { status: 401 },
      );
    }
    const rec = await getApiKeyRecord(body.apiKey);
    if (!rec || !rec.active) {
      return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
    }
    if (typeof body.ownerAddress === "string" && body.ownerAddress.length > 0) {
      if (!isHexAddress(body.ownerAddress)) {
        return NextResponse.json({ error: "INVALID_OWNER" }, { status: 400 });
      }
      if (rec.address.toLowerCase() !== body.ownerAddress.toLowerCase()) {
        return NextResponse.json(
          { error: "OWNER_MISMATCH", message: "apiKey is not bound to the supplied ownerAddress." },
          { status: 403 },
        );
      }
    }
    return rec.address.toLowerCase();
  }

  return NextResponse.json(
    { error: "AUTH_REQUIRED", message: "Provide either an EIP-191 signature or an apiKey." },
    { status: 401 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  if (body.token !== "USDC" && body.token !== "USDT") {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 400 });
  }
  if (!isHexAddress(body.to)) {
    return NextResponse.json({ error: "INVALID_RECIPIENT" }, { status: 400 });
  }
  if (!isPositiveDecimalString(body.amount)) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }

  const owner = await resolveOwner(req, body);
  if (owner instanceof NextResponse) return owner;

  const ready = isKeystoreReady();
  if (!ready.ok) {
    console.error("[agentic-wallet/send] keystore unavailable:", ready.reason);
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  // Resolve the specific wallet. Owner-sig path bound walletId in the
  // challenge; Mode C falls back to default if walletId not specified.
  const wallet = await resolveWallet(owner, body.walletId ?? null);
  if (!wallet) {
    return NextResponse.json(
      {
        error: "AGENTIC_WALLET_NOT_FOUND",
        message: body.walletId
          ? `No active wallet with id ${body.walletId} for this owner.`
          : "Create an Agent Wallet in your dashboard before calling /send.",
      },
      { status: 404 },
    );
  }
  // Re-check soft-delete defensively (resolveWallet may have returned a
  // stale-by-time record).
  if (wallet.deletedAt && Date.now() >= wallet.deletedAt) {
    return NextResponse.json({ error: "AGENTIC_WALLET_ARCHIVED" }, { status: 410 });
  }

  const walletId = wallet.address.toLowerCase();

  // ── Hook param trust boundary ──────────────────────────────────────────
  // Per-payment hookParams (params.splits especially) are NOT part of the
  // owner's EIP-191 signed intent (which covers walletId/chain/token/to/
  // amount). On the owner-sig path an attacker who can modify the request
  // body in flight could inject `splits` to redirect a signed payment's
  // funds to recipients of their choice — the signature protects the
  // recipient, but a MultiPayeeSplit injection routes around it.
  //
  // So we only TRUST body.hookParams on the Mode C (apiKey) path, where
  // the key holder IS the payment authority and controls the body
  // legitimately. On the owner-sig path, body hookParams are dropped and
  // only the wallet's STORED hook config (written via authenticated
  // config endpoints) applies.
  const isModeC = typeof body.apiKey === "string" && body.apiKey.length > 0;
  const trustedHookParams = isModeC ? body.hookParams : undefined;

  // ── Q402 Hooks — beforeAuthorize ───────────────────────────────────────
  // Runs at the EARLIEST point we have (owner, walletId, recipient,
  // amount) — before the idempotency claim or any daily-limit charge.
  // ComplianceGate (OFAC screening) lives here so a sanctioned recipient
  // is rejected outright, consuming no reservation. A deny short-circuits
  // before we touch KV claims. No-op when no beforeAuthorize hooks apply.
  const authHook = await runHooks("beforeAuthorize", {
    lifecycle: "beforeAuthorize",
    owner,
    walletId,
    chain: body.chain,
    token: body.token,
    recipient: body.to.toLowerCase(),
    amount: body.amount,
    amountUsd: Number(body.amount),
    source: "send",
    params: trustedHookParams,
  });
  if (authHook.outcome.action === "deny") {
    const { code, reason, status, meta } = authHook.outcome;
    return NextResponse.json(
      { error: code, message: reason, ...(meta ? { detail: meta } : {}) },
      { status: status ?? 403 },
    );
  }
  if (authHook.outcome.action === "require_approval") {
    // SpendCapPolicy (or any beforeAuthorize hook) holds the payment for
    // human approval. Nothing claimed/charged yet at this point, so we
    // just surface the hold. The approval flow (approve → re-submit) is
    // out of v1 scope; the agent/UI handles the hold.
    //
    // Cross-lifecycle precedence (deny > require_approval): a beforeSettle
    // gate (ReputationGate / ConditionalOracle) can HARD-deny a payment the
    // beforeAuthorize layer only soft-held. Surfacing the soft 202 without
    // consulting beforeSettle would tell the caller "needs approval" for a
    // payment a settle-time gate would forbid outright. So we evaluate the
    // beforeSettle gates now and let a DENY win over the require_approval.
    // This is EVALUATION ONLY — nothing is reserved/charged yet, so a deny
    // here needs no refund, and the canonical beforeSettle pass below (which
    // also handles require_approval/split) still runs for the non-deny path.
    const settleGate = await runHooks("beforeSettle", {
      lifecycle: "beforeSettle",
      owner,
      walletId,
      chain: body.chain,
      token: body.token,
      recipient: body.to.toLowerCase(),
      amount: body.amount,
      amountUsd: Number(body.amount),
      source: "send",
      params: trustedHookParams,
    });
    if (settleGate.outcome.action === "deny") {
      const { code, reason, status, meta } = settleGate.outcome;
      return NextResponse.json(
        { error: code, message: reason, ...(meta ? { detail: meta } : {}) },
        { status: status ?? 403 },
      );
    }
    const { code, reason, status, meta } = authHook.outcome;
    return NextResponse.json(
      { status: "approval_required", code, message: reason, ...(meta ? { detail: meta } : {}) },
      { status: status ?? 202 },
    );
  }

  // ── Idempotency: SET NX claim BEFORE any relay work ────────────────────
  // Two concurrent identical requests must NOT both fire on-chain. The
  // earlier read-then-write pattern had a TOCTOU window between the
  // get() and the final set(): both racers saw cached=null and both
  // settled. Mirror batch's atomic claim — the loser falls through to
  // the cached record returned by the winner.
  //
  // Scope: bundled into the fingerprint so a Trial-key failure on BNB
  // doesn't shadow-lock a Multichain-key retry of the same intent.
  // For owner-sig calls there's no apiKey distinction, so all owner-
  // sig requests for the same (wallet, chain, token, to, amount) hash
  // to one slot — that's correct: the canonical retry contract for
  // owner-sig is "fresh challenge same intent → cached settled
  // result". For apiKey calls we hash the WHOLE key (full keccak)
  // not a 12-char prefix — the v0.6.0 prefix slice only carried ~64
  // bits after the shared `q402_live_` prefix, giving a non-zero
  // (if tiny) collision risk between rotated keys of the same owner.
  // Full keccak makes the scope segment cryptographically distinct
  // for any distinct key without leaking the key itself into KV.
  const scope =
    typeof body.apiKey === "string" && body.apiKey.length > 0
      ? `apikey_${ethers.keccak256(ethers.toUtf8Bytes(body.apiKey)).slice(2, 18)}`
      : "owner-sig";
  // Fold the TRUSTED hook params into the fingerprint so a different
  // split / oracle condition to the same (to, amount) gets its own
  // idempotency slot instead of colliding with a prior intent. Uses
  // trustedHookParams (the Mode-C-only set) — owner-sig calls drop hook
  // params, so their tag stays "none" and their fingerprint is
  // unchanged from before this fix.
  const hookParamsTag = trustedHookParams
    ? ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(trustedHookParams))).slice(2, 18)
    : "none";
  const fp = agenticSendFingerprint(
    owner,
    walletId,
    body.chain,
    body.token,
    body.to,
    body.amount,
    scope,
    hookParamsTag,
  );
  const idempotencyKey = sendKey(fp);
  // Durable replay marker is scoped to the CLIENT idempotency key (when
  // supplied) rather than the payment content. This is what lets a user pay the
  // same recipient the same amount more than once: distinct keys = distinct
  // payments; a reused key = a deduped retry. With NO key we skip the durable
  // marker entirely — a content fingerprint blocked every repeat forever; the
  // 30-min idempotency claim above still catches same-payment double-clicks.
  const clientIdemKey =
    typeof body.idempotencyKey === "string" &&
    /^[A-Za-z0-9_.:-]{8,200}$/.test(body.idempotencyKey)
      ? body.idempotencyKey
      : null;
  // Namespace the durable key by owner+walletId so two different owners (or
  // two wallets) that pass the SAME idempotencyKey string can never collide
  // on one global slot (cross-account replay). Content binding via fp (stored
  // in the marker, checked below) catches same-key/different-payload reuse.
  const settledKey = clientIdemKey ? sendSettledKey(`${owner}:${walletId}:idem:${clientIdemKey}`) : null;

  // ── Durable settled-marker replay guard ────────────────────────────────
  // ONLY active when a client idempotency key scoped the marker (settledKey
  // non-null). It replays a prior settlement under the SAME key — even older
  // than the 30-min claim TTL — instead of re-firing (a fresh witness nonce
  // would otherwise double-settle). With no key there's no permanent marker,
  // so an intentional repeat is allowed. FAIL CLOSED: if the marker read
  // errors we can't prove the payment hasn't settled, so reject (503).
  if (settledKey) {
    let priorSettled: SettledMarker | null;
    try {
      priorSettled = await kv.get<SettledMarker>(settledKey);
    } catch {
      return NextResponse.json(
        { error: "idempotency_unavailable", message: "Could not verify payment idempotency (storage). Retry shortly." },
        { status: 503 },
      );
    }
    if (priorSettled) {
      // Same idempotency key, DIFFERENT payment payload → reject instead of
      // replaying the wrong settlement back to the caller.
      if (priorSettled.fp && priorSettled.fp !== fp) {
        return NextResponse.json(
          {
            error: "idempotency_key_reused",
            message:
              "This idempotency key already settled a different payment. " +
              "Use a fresh idempotency key for a new payment.",
          },
          { status: 409 },
        );
      }
      const isPartial = priorSettled.status === "partial";
      const isUncertain = priorSettled.status === "relay_unreachable_uncertain";
      return NextResponse.json(
        {
          sendId: priorSettled.sendId,
          status: priorSettled.status,
          ...(priorSettled.txHash ? { txHash: priorSettled.txHash } : {}),
          ...(priorSettled.legs ? { split: true, legs: priorSettled.legs } : {}),
          replayed: true,
          message:
            "This payment already settled on-chain under the same idempotency key; " +
            "returning the original result instead of re-firing.",
        },
        { status: isUncertain ? 502 : isPartial ? 207 : 200 },
      );
    }
  }

  const startedAt = Date.now();
  const sendId = randomBytes(8).toString("hex");
  const claim: SendRecord = { status: "processing", startedAt, sendId };
  const claimed = await kv.set(idempotencyKey, claim, { nx: true, ex: IDEMPOTENCY_TTL_SEC });
  if (!claimed) {
    // Lost the race — surface whichever record landed. Mirrors batch
    // route's pattern: when concurrent retries beat us we return the
    // winner's state instead of inventing a parallel settlement.
    //
    // Response shape contract for MCP / dashboard:
    //   - SUCCESS replay: HTTP 200 with the original relayBody + `txHash`
    //   - FAILED replay:  HTTP from the original relayStatus (e.g. 402)
    //   - PROCESSING replay: HTTP 202 + `pending: true` so clients can
    //     distinguish "still in flight" from "settled". MCP needs the
    //     `pending` flag because checking `resp.ok && body.txHash` would
    //     otherwise mis-classify 202 (no txHash yet) as a failure.
    const live = await kv.get<SendRecord>(idempotencyKey);
    if (live) {
      const isProcessing = live.status === "processing";
      const httpStatus = live.relayStatus ?? (isProcessing ? 202 : 500);
      return NextResponse.json(
        {
          ...((live.relayBody as Record<string, unknown>) ?? {}),
          idempotent: true,
          ...(isProcessing ? { pending: true, retryAfterSec: 5 } : {}),
          status: live.status,
          startedAt: live.startedAt,
          finishedAt: live.finishedAt,
          sendId: live.sendId,
        },
        {
          status: httpStatus,
          ...(isProcessing ? { headers: { "Retry-After": "5" } } : {}),
        },
      );
    }
    // Race window where the claim disappeared between SET NX and GET
    // (TTL expiry, manual delete). Fail closed.
    return NextResponse.json({ error: "send_claim_failed" }, { status: 500 });
  }
  // Best-effort release of the claim on early-fail paths so the user
  // isn't shadow-locked to an empty "processing" record for the full
  // TTL when the actual relay never happened. Successful settlement
  // overwrites the record below with `complete` / `failed`.
  const releaseClaim = async () => {
    await kv.del(idempotencyKey).catch(() => {});
  };

  const numAmount = Number(body.amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    await releaseClaim();
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  if (typeof wallet.perTxMaxUsd === "number" && numAmount > wallet.perTxMaxUsd) {
    await releaseClaim();
    return NextResponse.json(
      { error: "PER_TX_LIMIT_EXCEEDED", limit: wallet.perTxMaxUsd, requested: numAmount },
      { status: 403 },
    );
  }

  // Reserve budget atomically.
  const reservation = await chargeAgainstDailyLimit(owner, walletId, numAmount, wallet.dailyLimitUsd);
  if (!reservation.allowed) {
    await releaseClaim();
    return NextResponse.json(
      {
        error: "DAILY_LIMIT_EXCEEDED",
        limit: reservation.limit,
        spent: reservation.spent,
        requested: reservation.requested,
      },
      { status: 403 },
    );
  }
  // Compose refund + release so every relay-failure path releases BOTH
  // the daily-spend reservation AND the SET NX idempotency claim. A
  // surviving claim with no relay would shadow-lock the user from
  // retrying the same (recipient, amount) for the full TTL.
  const refundAndRelease = async () => {
    await refundDailySpend(owner, walletId, numAmount).catch(() => {});
    await releaseClaim();
  };

  // Subscription gate — BNB free, others require multichain.
  //
  // Exception: withdraw-to-owner-EOA is always free. A trial user funding
  // their Agent Wallet on a non-BNB chain (e.g. a prefund, a refund, an
  // incoming USDC payment) would otherwise be trapped — they couldn't
  // return their own funds to their own EOA without first upgrading. The
  // outbound destination is restricted to the verified owner address, so
  // this exception can't be used to send to arbitrary recipients.
  const sub = await getSubscription(owner);
  const isWithdrawToOwner = body.to.toLowerCase() === owner.toLowerCase();
  if (body.chain !== "bnb" && !hasMultichainScope(sub) && !isWithdrawToOwner) {
    await refundAndRelease();
    return NextResponse.json(
      { error: "SUBSCRIPTION_REQUIRED", message: "Multichain access requires a paid subscription." },
      { status: 402 },
    );
  }

  // ── apiKey resolution: Mode C uses presented; owner-sig uses auto-pick ─
  let apiKey: string | undefined;
  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    const presented = body.apiKey;
    const isTrial = presented === sub?.trialApiKey;
    const isPaid = presented === sub?.apiKey;
    if (!isTrial && !isPaid) {
      await refundAndRelease();
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
    if (isTrial && body.chain !== "bnb") {
      await refundAndRelease();
      return NextResponse.json(
        {
          error: "TRIAL_BNB_ONLY",
          message:
            "Trial apiKeys can only settle on BNB Chain. Present the " +
            "Multichain key (or omit apiKey + sign the owner challenge) " +
            "for non-BNB sends.",
        },
        { status: 402 },
      );
    }
    apiKey = presented;
  } else {
    apiKey = body.chain === "bnb" ? sub?.trialApiKey || sub?.apiKey : sub?.apiKey;
  }

  if (!apiKey) {
    await refundAndRelease();
    return NextResponse.json(
      { error: "NO_API_KEY", message: "Activate a Q402 trial or subscription before using your Agent Wallet." },
      { status: 402 },
    );
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    await refundAndRelease();
    return NextResponse.json({ error: "relay_unavailable" }, { status: 503 });
  }

  // ── Q402 Hooks — beforeSettle ──────────────────────────────────────────
  // Runs AFTER all native gating (per-tx max, daily cap, subscription,
  // api key) and BEFORE the signature + relay. A hook deny here aborts
  // the settlement; we refundAndRelease so the daily reservation +
  // idempotency claim don't shadow-lock the (recipient, amount) the way
  // any other gate-failure path does. The dispatcher is a no-op when no
  // hooks are enabled for this wallet (the common case), so this adds a
  // single cached KV read on the hot path.
  const hookResult = await runHooks("beforeSettle", {
    lifecycle: "beforeSettle",
    owner,
    walletId,
    chain: body.chain,
    token: body.token,
    recipient: body.to.toLowerCase(),
    amount: body.amount,
    amountUsd: numAmount,
    source: "send",
    params: trustedHookParams,
  });
  if (hookResult.outcome.action === "deny") {
    await refundAndRelease();
    const { code, reason, status, meta } = hookResult.outcome;
    return NextResponse.json(
      { error: code, message: reason, ...(meta ? { detail: meta } : {}) },
      { status: status ?? 403 },
    );
  }
  if (hookResult.outcome.action === "require_approval") {
    // A beforeSettle hook holds the payment for approval. The daily
    // reservation + idempotency claim are already held here, so
    // refundAndRelease before surfacing the hold (don't shadow-lock the
    // intent while it waits for a human).
    await refundAndRelease();
    const { code, reason, status, meta } = hookResult.outcome;
    return NextResponse.json(
      { status: "approval_required", code, message: reason, ...(meta ? { detail: meta } : {}) },
      { status: status ?? 202 },
    );
  }

  // ── MultiPayeeSplit (#3) fan-out ───────────────────────────────────────
  // A `split` outcome replaces the single settlement with N legs. This is
  // a SELF-CONTAINED branch that early-returns — it does NOT touch the
  // hardened single-recipient path below. Each leg is signed + relayed
  // sequentially; the legs sum to the full amount (the hook guarantees
  // exact-sum), so the already-charged daily reservation covers them with
  // no double-charge. Partial-failure model mirrors recurring-payouts:
  // settled legs are recorded, unsettled portion is refunded, we never
  // re-settle a leg that already landed.
  if (hookResult.outcome.action === "split") {
    const legs = hookResult.outcome.parts;

    // Screen EACH split leg recipient through beforeAuthorize hooks
    // (ComplianceGate) before any settlement. The original body.to was
    // screened above, but the split legs are DIFFERENT addresses (from
    // wallet config or per-payment params) and were never checked — a
    // split could otherwise fan out to a sanctioned leg. A single
    // sanctioned leg denies the whole split (no partial settle to a
    // blocked address); we refundAndRelease since nothing has fired.
    for (const leg of legs) {
      const legAuth = await runHooks("beforeAuthorize", {
        lifecycle: "beforeAuthorize",
        owner,
        walletId,
        chain: body.chain,
        token: body.token,
        recipient: leg.recipient.toLowerCase(),
        amount: leg.amount,
        amountUsd: Number(leg.amount),
        source: "send",
        params: undefined,
      });
      if (legAuth.outcome.action === "deny" || legAuth.outcome.action === "require_approval") {
        // A split leg is blocked OR needs approval — hold the WHOLE
        // split (we don't partial-settle a split with a blocked/held
        // leg). Nothing has fired yet; refundAndRelease.
        await refundAndRelease();
        const { code, reason, status, meta } = legAuth.outcome;
        const held = legAuth.outcome.action === "require_approval";
        return NextResponse.json(
          {
            ...(held ? { status: "approval_required" } : { error: code }),
            code,
            message: reason,
            heldRecipient: leg.recipient.toLowerCase(),
            split: true,
            ...(meta ? { detail: meta } : {}),
          },
          { status: status ?? (held ? 202 : 403) },
        );
      }

      // Re-screen EACH leg through the beforeSettle gates too. The top-level
      // beforeSettle pass ran against ctx.recipient = body.to — it never saw
      // the leg addresses that actually receive funds, so ReputationGate /
      // ConditionalOracle could pass on `to` while a leg recipient fails the
      // gate. Mirror the per-leg beforeAuthorize above: a leg that fails the
      // gate (deny OR hold) blocks the WHOLE split (all-or-nothing leg model),
      // and nothing has fired yet so refundAndRelease. params is undefined so
      // MultiPayeeSplit doesn't try to re-split a single leg — only the gate
      // hooks evaluate against the leg recipient.
      const legSettle = await runHooks("beforeSettle", {
        lifecycle: "beforeSettle",
        owner,
        walletId,
        chain: body.chain,
        token: body.token,
        recipient: leg.recipient.toLowerCase(),
        amount: leg.amount,
        amountUsd: Number(leg.amount),
        source: "send",
        params: undefined,
      });
      if (legSettle.outcome.action === "deny" || legSettle.outcome.action === "require_approval") {
        await refundAndRelease();
        const { code, reason, status, meta } = legSettle.outcome;
        const held = legSettle.outcome.action === "require_approval";
        return NextResponse.json(
          {
            ...(held ? { status: "approval_required" } : { error: code }),
            code,
            message: reason,
            heldRecipient: leg.recipient.toLowerCase(),
            split: true,
            ...(meta ? { detail: meta } : {}),
          },
          { status: status ?? (held ? 202 : 403) },
        );
      }
    }

    const pkSplit = decryptPrivateKey(wallet);
    const settledLegs: Array<{ recipient: string; amount: string; txHash: string }> = [];
    const failedLegs: Array<{ recipient: string; amount: string; error: string }> = [];
    let uncertain = false;

    for (const leg of legs) {
      let signedLeg;
      try {
        signedLeg = await signAgenticPayment({
          privateKey: pkSplit as Hex,
          chain: body.chain,
          token: body.token,
          to: leg.recipient as Address,
          amount: leg.amount,
          facilitator: relayerKey.address as Address,
        });
      } catch (e) {
        // Sign failure on a leg = nothing broadcast for it. Record as
        // failed and continue to the remaining legs (a bad single leg
        // shouldn't strand the rest).
        failedLegs.push({ recipient: leg.recipient, amount: leg.amount, error: e instanceof Error ? e.message.slice(0, 120) : "sign_failed" });
        continue;
      }
      let legResp: Response;
      try {
        legResp = await submitToRelay(internalBaseUrl(), apiKey, signedLeg, {
          source: "send",
          internalTrustToken: process.env.CRON_SECRET,
        });
      } catch (e) {
        // Relay THREW for this leg — same uncertain double-submit risk
        // as the single path. Stop the fan-out: legs already settled
        // stay settled, this leg is uncertain, remaining legs are not
        // attempted. Keep the claim alive (no DEL) + page ops.
        uncertain = true;
        void sendOpsAlert(
          `agentic-wallet/send SPLIT leg relay FETCH threw — outcome UNCERTAIN. ` +
            `owner=${owner} walletId=${walletId} sendId=${sendId} chain=${body.chain} ` +
            `token=${body.token} leg.to=${leg.recipient} leg.amount=${leg.amount}. ` +
            `${settledLegs.length} legs already settled. Verify on-chain before clearing ` +
            `the idempotency key. Error: ${e instanceof Error ? e.message : String(e)}`,
          "critical",
        );
        failedLegs.push({ recipient: leg.recipient, amount: leg.amount, error: "relay_outcome_uncertain" });
        break;
      }
      const legBody = await legResp.json().catch(() => null);
      const legOk = legResp.ok && legBody && typeof legBody === "object" && "txHash" in legBody;
      if (legOk) {
        settledLegs.push({ recipient: leg.recipient, amount: leg.amount, txHash: (legBody as { txHash: string }).txHash });
      } else {
        failedLegs.push({ recipient: leg.recipient, amount: leg.amount, error: typeof legBody === "object" && legBody && "error" in legBody ? String((legBody as { error: unknown }).error) : `relay_http_${legResp.status}` });
      }
    }

    // Refund the UNSETTLED portion of the daily reservation. The
    // reservation was charged for numAmount (the full total); we only
    // actually spent the sum of settled legs.
    const settledUsd = settledLegs.reduce((acc, l) => acc + Number(l.amount), 0);
    const unsettledUsd = Math.max(0, numAmount - settledUsd);
    if (unsettledUsd > 0) {
      await refundDailySpend(owner, walletId, unsettledUsd).catch(() => {});
    }

    const allSettled = failedLegs.length === 0;
    const splitStatus: SendRecord["status"] = uncertain
      ? "relay_unreachable_uncertain"
      : allSettled
        ? "complete"
        : settledLegs.length > 0
          ? "partial"
          : "failed";
    const splitRecord: SendRecord = {
      sendId,
      status: splitStatus,
      startedAt,
      finishedAt: Date.now(),
      txHash: settledLegs[0]?.txHash,
      legs: [
        ...settledLegs.map((l) => ({ recipient: l.recipient, amount: l.amount, txHash: l.txHash })),
        ...failedLegs.map((l) => ({ recipient: l.recipient, amount: l.amount, error: l.error })),
      ],
    };
    // Uncertain → keep the claim alive at full TTL (a retry must NOT
    // re-fire). complete/partial → full TTL so retries replay. failed →
    // short TTL so a remediated retry isn't shadow-locked.
    const splitTtl = uncertain || allSettled || settledLegs.length > 0 ? IDEMPOTENCY_TTL_SEC : 60;
    await kv.set(idempotencyKey, splitRecord, { ex: splitTtl }).catch(() => {});

    // Durable replay guard: any time ≥1 leg confirmed on-chain (complete,
    // partial, OR uncertain-after-some-settled), persist a no-TTL marker
    // so a retry beyond the 30-min idempotency window can never re-fire
    // the already-settled legs. All-failed / threw-on-first-leg (0
    // settled) writes nothing — that intent is safe to retry.
    if (settledLegs.length > 0) {
      const marker: SettledMarker = {
        sendId,
        status: splitStatus,
        txHash: settledLegs[0]?.txHash,
        legs: splitRecord.legs,
        settledAt: Date.now(),
        fp,
      };
      const ok = await writeSettledMarker(settledKey, marker);
      if (!ok) {
        // Same as the single path: ≥1 leg is on-chain, so losing this
        // marker risks re-firing settled legs after the TTL. Page ops.
        void sendOpsAlert(
          `agentic-wallet/send SPLIT durable marker write failed (after retries) for ${owner} ` +
            `(walletId=${walletId}, sendId=${sendId}, ${settledLegs.length} legs settled). ` +
            `A retry after the TTL could re-fire settled legs — verify before replay.`,
          "critical",
        );
      }
    }

    const httpStatus = uncertain ? 502 : allSettled ? 200 : settledLegs.length > 0 ? 207 : 502;
    return NextResponse.json(
      {
        sendId,
        status: splitStatus,
        // Top-level txHash mirrors the durable-replay shape (the first
        // settled leg's hash). Without it the fresh-split response and the
        // post-TTL replay response would disagree — a client that keys off
        // body.txHash would see a hash on replay but not on first settle.
        // Per-leg hashes remain authoritative in legs[].
        ...(settledLegs[0]?.txHash ? { txHash: settledLegs[0].txHash } : {}),
        split: true,
        legs: splitRecord.legs,
        settled: settledLegs.length,
        failed: failedLegs.length,
        ...(uncertain
          ? { message: "A split leg's relay outcome is uncertain. Ops has been paged; verify on-chain before retrying." }
          : {}),
      },
      { status: httpStatus },
    );
  }

  // Sign + submit. `startedAt` was set when we minted the SET NX claim
  // so the cached final record stitches back to the wallet popup time
  // rather than the post-budget-check time.
  const pk = decryptPrivateKey(wallet);
  let signed;
  try {
    signed = await signAgenticPayment({
      privateKey: pk as Hex,
      chain: body.chain,
      token: body.token,
      to: body.to as Address,
      amount: body.amount,
      facilitator: relayerKey.address as Address,
    });
  } catch (e) {
    await refundAndRelease();
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AMOUNT_PRECISION_TOO_HIGH") {
      return NextResponse.json(
        { error: "AMOUNT_PRECISION_TOO_HIGH", message: `Amount has more decimals than ${body.token} supports.` },
        { status: 400 },
      );
    }
    if (msg === "INVALID_AMOUNT") {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }
    console.error("[agentic-wallet/send] signing failed:", e);
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }

  let relayResponse: Response;
  try {
    relayResponse = await submitToRelay(internalBaseUrl(), apiKey, signed, {
      source: "send",
      internalTrustToken: process.env.CRON_SECRET,
    });
  } catch (e) {
    // Relay HTTP fetch threw. The relay MAY have already broadcast the
    // tx on chain — we cannot distinguish "request died before relay
    // saw it" (safe to retry) from "relay broadcasted, response in
    // flight died" (unsafe — retry would double-submit because
    // signAgenticPayment uses a fresh randomUint256Nonce on each
    // call). The witness contract enforces nonce uniqueness so a
    // truly-already-broadcast tx would revert on second submission,
    // BUT only if the contract sees the SAME nonce — fresh nonce
    // = fresh authorization that the contract accepts. Treat as
    // uncertain: KEEP the claim alive (no DEL), refund the budget
    // (safer to over-refund than over-charge under uncertainty),
    // page ops. Retries on the same intent fingerprint hit the
    // existing-claim handler above and get the uncertain status.
    await refundDailySpend(owner, walletId, numAmount).catch(() => {});
    // Note: relayStatus is intentionally OMITTED (undefined) here, not
    // set to 0. The retry handler at the top of this route reads
    // `httpStatus = live.relayStatus ?? (isProcessing ? 202 : 500)` —
    // `??` only short-circuits on null/undefined, so `0` would pass
    // through and `NextResponse.json(..., {status: 0})` throws
    // RangeError (HTTP status must be 200-599). Leaving relayStatus
    // undefined lets the fallback `500` kick in, which is the correct
    // semantics for "manual recovery required, do not retry".
    const uncertainRecord: SendRecord = {
      sendId,
      status: "relay_unreachable_uncertain",
      startedAt,
      finishedAt: Date.now(),
      relayBody: null,
    };
    await kv.set(idempotencyKey, uncertainRecord, { ex: IDEMPOTENCY_TTL_SEC }).catch(() => {
      /* if we can't overwrite, the original `processing` claim stays — also safe */
    });
    void sendOpsAlert(
      `agentic-wallet/send relay FETCH threw — outcome UNCERTAIN. ` +
        `owner=${owner} walletId=${walletId} sendId=${sendId} chain=${body.chain} ` +
        `token=${body.token} amount=${body.amount} to=${body.to}. ` +
        `Verify on-chain BEFORE clearing the idempotency key — a retry would re-sign ` +
        `with a fresh witness nonce and double-submit if the relay actually broadcast. ` +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      "critical",
    );
    console.error("[agentic-wallet/send] relay forward failed:", e);
    return NextResponse.json(
      {
        error: "relay_outcome_uncertain",
        sendId,
        message:
          "We couldn't confirm whether the relay broadcast your transfer. " +
          "Check your wallet history on-chain before retrying — ops has been paged.",
      },
      { status: 502 },
    );
  }

  const relayBody = await relayResponse.json().catch(() => null);
  const success =
    relayResponse.ok && relayBody && typeof relayBody === "object" && "txHash" in relayBody;

  // ── Post-relay finalisation ───────────────────────────────────────────
  // Critical: keep the claim alive between refund + overwrite so a racing
  // retry can't slip into the window where the key is deleted but the
  // failed record isn't yet written. (Earlier code released the claim
  // first and then re-wrote — that gave concurrent retries a short race
  // to claim a fresh `processing` slot and re-fire.) Refund the budget,
  // then overwrite the same key with the terminal `complete` / `failed`
  // state — no NX, so we replace the claim atomically from the racer's
  // perspective.
  if (!success) {
    await refundDailySpend(owner, walletId, numAmount).catch(() => {});
  }
  const finalRecord: SendRecord = {
    sendId,
    txHash:
      success && relayBody && typeof relayBody === "object"
        ? (relayBody as { txHash?: string }).txHash
        : undefined,
    status: success ? "complete" : "failed",
    startedAt,
    finishedAt: Date.now(),
    relayBody: relayBody ?? null,
    relayStatus: relayResponse.status,
  };
  // Success → keep the cached settlement for the full TTL so retries
  // (network blip, slow client) see the original txHash.
  // Failure → short TTL (60s) so a genuine remediated retry isn't
  // shadow-locked to a stale failed record. Long enough to absorb an
  // immediate double-click; short enough that the user can change a
  // gas tank, rotate a key, or just retry within a minute.
  const finalTtl = success ? IDEMPOTENCY_TTL_SEC : 60;
  try {
    await kv.set(idempotencyKey, finalRecord, { ex: finalTtl });
  } catch (e) {
    // Cache write failed AFTER the relay either settled or rejected.
    // The claim is still alive as `processing` and will stay that way
    // until the TTL expires — at which point a future identical
    // request would re-fire against a chain that already settled,
    // double-spending. Mirror the batch route: page ops with the
    // settled txHash (if any) so a human can either patch the cache
    // or warn the user.
    const txHashStr =
      success && relayBody && typeof relayBody === "object"
        ? String((relayBody as { txHash?: string }).txHash ?? "(none)")
        : "(none)";
    console.error("[agentic-wallet/send] idempotency cache write failed:", e);
    void sendOpsAlert(
      `agentic-wallet/send final write failed for owner ${owner} ` +
        `(walletId=${walletId}, sendId=${sendId}, chain=${body.chain}, ` +
        `token=${body.token}, amount=${body.amount}, recipient=${body.to}). ` +
        `${success ? `SETTLED on-chain — txHash=${txHashStr}.` : "Relay returned non-success."} ` +
        `Claim is stuck as 'processing' until TTL; a retry within ` +
        `${IDEMPOTENCY_TTL_SEC / 60}min could re-fire and double-spend. ` +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      "critical",
    );
  }

  // Durable replay guard (no TTL): on a confirmed on-chain settlement,
  // persist a marker so a retry of this exact intent beyond the 30-min
  // idempotency window can never re-fire (a fresh witness nonce would
  // otherwise double-settle). Written after the idempotency set so even
  // if that write failed above, the long-term guard still lands.
  if (success) {
    const marker: SettledMarker = {
      sendId,
      status: "complete",
      txHash: finalRecord.txHash,
      settledAt: Date.now(),
      fp,
    };
    const ok = await writeSettledMarker(settledKey, marker);
    if (!ok) {
      // 3 retries failed — KV durably down at settlement time. The
      // payment is on-chain but unrecorded; a post-TTL retry could
      // re-fire. Nothing more we can do automatically — page ops.
      void sendOpsAlert(
        `agentic-wallet/send DURABLE marker write failed (after retries) for ${owner} ` +
          `(walletId=${walletId}, sendId=${sendId}, txHash=${finalRecord.txHash ?? "(none)"}). ` +
          `Settled on-chain; a retry after the 30-min TTL could re-fire — verify before replay.`,
        "critical",
      );
    }
  }

  return NextResponse.json(
    relayBody ?? { error: "relay_response_unreadable" },
    { status: relayResponse.status },
  );
}
