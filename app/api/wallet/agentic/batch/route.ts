/**
 * POST /api/wallet/agentic/batch
 *
 * Server-mediated multi-recipient send from the caller's Agent Wallet.
 * Same trust model as /send (server holds the AES-GCM-wrapped private
 * key), one row per recipient, up to 20 rows.
 *
 * Idempotency — central to this route. Each batch is fingerprinted by
 *   keccak(owner | chain | token | sorted(recipients × amounts))
 * and claimed via SET NX in KV for `IDEMPOTENCY_TTL_SEC`. A retry
 * within that window returns the existing batch record without re-
 * firing, so a client that misreads a timeout cannot double-spend.
 * Early failures (auth-nonce fetch, sign, etc.) delete the in-flight
 * claim so the next retry starts fresh instead of being shadow-locked
 * to an empty "processing" record.
 *
 * Scope:
 *   - Multichain only (gated by `hasMultichainScope`). BNB-only trial
 *     keys cannot batch — single-recipient /send is sufficient there.
 *   - Auth modes mirror /send:
 *       (A/B) Owner EIP-191 signature with intent-bound challenge.
 *       (C)   apiKey only — server-mediated MCP path. The intent fp is
 *             still computed and used for idempotency / cache; the
 *             signature gate is replaced by an apiKey ↔ owner lookup.
 *   - Limits enforced: every row honors perTxMaxUsd; the running
 *     dailyLimitUsd budget covers the whole batch sum atomically via
 *     chargeAgainstDailyLimit + refundDailySpend on failure.
 *   - EIP-7702 authorization nonce: signed once for the batch. After
 *     the first type-4 TX applies the delegation on-chain, subsequent
 *     rows piggy-back on the persistent delegation; their per-TX
 *     authorizations carry the same nonce and are silently ignored by
 *     the EVM (per EIP-7702 stale-auth semantics) without revert.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { randomBytes } from "node:crypto";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { agenticBatchFingerprint } from "@/app/lib/agentic-batch-fingerprint";
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
  fetchAuthNonce,
  isRelayConnectPhaseError,
  type AgenticChainKey,
  type AgenticToken,
} from "@/app/lib/agentic-wallet-sign";
import { runHooks } from "@/app/lib/hooks";
import type { Address, Hex } from "viem";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_RECIPIENTS = 20;
const IDEMPOTENCY_TTL_SEC = 10 * 60;

interface RecipientRow {
  to?: string;
  amount?: string;
}

interface BatchBody {
  chain?: string;
  token?: string;
  recipients?: RecipientRow[];
  /**
   * Lowercased Agent Wallet address to source the batch from. Required
   * in owner-sig mode (intent is bound to it); optional in Mode C
   * (apiKey) where omitting falls through to the owner's default wallet.
   */
  walletId?: string;
  // Mode A/B — intent-bound owner signature
  ownerAddress?: string;
  nonce?: string;
  signature?: string;
  // Mode C — server-mediated MCP path, apiKey only
  apiKey?: string;
}

interface BatchResultRow {
  to: string;
  amount: string;
  ok: boolean;
  txHash?: string;
  error?: string;
  /** Relay fetch threw AFTER it may have broadcast — outcome unknown (the
   *  transfer may have settled). NOT a clean failure: must not be retried. */
  uncertain?: boolean;
}

interface BatchRecord {
  batchId: string;
  ownerAddr: string;
  walletId: string;
  chain: AgenticChainKey;
  token: AgenticToken;
  results: BatchResultRow[];
  startedAt: number;
  finishedAt?: number;
  status: "processing" | "complete" | "partial" | "failed" | "uncertain";
  /**
   * True when row 0 failed and the rest of the batch was marked
   * ABORTED_AFTER_ROW_0_FAILURE without firing. Persisted on the
   * cached record so an idempotent replay returns the same `aborted`
   * field as the original response — otherwise a retry would see the
   * field disappear, the AI's downstream branching would diverge, and
   * "aborted=true" silently degrades to "settled=0" on the second
   * round trip.
   */
  aborted?: boolean;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}
function isPositiveDecimalString(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}

function batchKey(fp: string): string {
  return `aw:batch:${fp}`;
}

// Durable "this batch fingerprint produced ≥1 confirmed on-chain row"
// marker — NO TTL, unlike the 10-min idempotency record. The TTL'd
// record dedups recent retries; this is the long-term guard. Without it,
// a retry of the same batch after 10 min re-signs every row with fresh
// witness nonces and re-fires (double-settle). Mirrors the send path's
// aw:send:settled. Batch is multichain-only (paid, low volume), so
// no-TTL growth is bounded.
function batchSettledKey(fp: string): string {
  return `aw:batch:settled:${fp}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: BatchBody;
  try {
    body = (await req.json()) as BatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate shape ──────────────────────────────────────────────────────
  if (!isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  if (body.token !== "USDC" && body.token !== "USDT") {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 400 });
  }
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return NextResponse.json({ error: "EMPTY_RECIPIENTS" }, { status: 400 });
  }
  if (body.recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      { error: "TOO_MANY_RECIPIENTS", limit: MAX_RECIPIENTS, supplied: body.recipients.length },
      { status: 400 },
    );
  }
  for (const r of body.recipients) {
    if (!isHexAddress(r.to)) {
      return NextResponse.json({ error: "INVALID_RECIPIENT", row: r }, { status: 400 });
    }
    if (!isPositiveDecimalString(r.amount)) {
      return NextResponse.json({ error: "INVALID_AMOUNT", row: r }, { status: 400 });
    }
  }
  const rows = body.recipients.map((r) => ({ to: r.to as string, amount: r.amount as string }));

  // ── Auth ───────────────────────────────────────────────────────────────
  // Mode A/B (owner sig) requires walletId — the intent message binds to
  // it so a signature scoped to wallet A can't drain wallet B. Mode C
  // (apiKey) makes walletId optional; the route falls through to the
  // owner's default wallet, mirroring /send.
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-batch", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const isModeC = typeof body.apiKey === "string" && body.apiKey.length > 0;
  const requestedWalletId =
    typeof body.walletId === "string" && body.walletId.length > 0
      ? body.walletId.toLowerCase()
      : null;

  let owner: string;
  if (isModeC) {
    const presented = body.apiKey!;
    // Reject BOTH sandbox prefixes (modern q402_test_ AND legacy
    // q402_sandbox_) — matches send/bridge. A still-active legacy
    // q402_sandbox_ key on a paid owner would otherwise reach this live
    // batch route.
    if (presented.startsWith("q402_test_") || presented.startsWith("q402_sandbox_")) {
      return NextResponse.json(
        { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for Agent Wallet batches." },
        { status: 401 },
      );
    }
    const rec = await getApiKeyRecord(presented);
    // Also reject isSandbox-flagged records (defense in depth beyond the
    // prefix check) — a sandbox key must never settle real funds.
    if (!rec || !rec.active || rec.isSandbox) {
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
    owner = rec.address.toLowerCase();
  } else {
    if (!requestedWalletId) {
      return NextResponse.json({ error: "walletId_required" }, { status: 400 });
    }
    const intentFp = agenticBatchFingerprint(
      `${(body.ownerAddress ?? "").toLowerCase()}:${requestedWalletId}`,
      body.chain,
      body.token,
      rows,
    );
    const authResult = await requireIntentAuth({
      address: body.ownerAddress ?? null,
      challenge: body.nonce ?? null,
      signature: body.signature ?? null,
      action: "agentic.batch",
      intent: {
        walletId: requestedWalletId,
        chain: body.chain,
        token: body.token,
        rows: String(rows.length),
        fp: intentFp,
      },
    });
    if (typeof authResult !== "string") {
      return NextResponse.json(
        { error: authResult.error, code: authResult.code },
        { status: authResult.status },
      );
    }
    owner = authResult;
  }

  // ── Pre-flight: keystore + wallet ───────────────────────────────────────
  const ready = isKeystoreReady();
  if (!ready.ok) {
    console.error("[agentic-wallet/batch] keystore unavailable:", ready.reason);
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  const wallet = await resolveWallet(owner, requestedWalletId);
  if (!wallet) {
    return NextResponse.json(
      {
        error: "AGENTIC_WALLET_NOT_FOUND",
        message: requestedWalletId
          ? `No active wallet with id ${requestedWalletId} for this owner.`
          : "Create an Agent Wallet in your dashboard before calling /batch.",
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

  // ── Q402 Hooks — beforeAuthorize, screened per recipient ───────────────
  // ComplianceGate (OFAC) is GLOBAL — it must cover EVERY payment surface,
  // not just /send, or a sanctioned recipient is one endpoint-swap away
  // from being paid. Screen each batch row; a single sanctioned recipient
  // denies the WHOLE batch (we don't partial-settle a batch that contains
  // a blocked address). Runs before the idempotency claim / daily charge.
  // No-op when no beforeAuthorize hooks apply.
  for (const r of rows) {
    const auth = await runHooks("beforeAuthorize", {
      lifecycle: "beforeAuthorize",
      owner,
      walletId,
      chain: body.chain,
      token: body.token,
      recipient: r.to.toLowerCase(),
      amount: r.amount,
      amountUsd: Number(r.amount),
      source: "batch",
      // Batch has no per-payment hook params surface in v1; stored
      // per-wallet config (e.g. ComplianceGate's global list) applies.
      params: undefined,
    });
    if (auth.outcome.action === "deny" || auth.outcome.action === "require_approval") {
      // A batch recipient is blocked OR needs approval — the whole batch
      // is held (no partial-settle of a batch containing a blocked/held
      // row). Nothing claimed yet at this point.
      const { code, reason, status, meta } = auth.outcome;
      const held = auth.outcome.action === "require_approval";
      return NextResponse.json(
        {
          ...(held ? { status: "approval_required" } : { error: code }),
          code,
          message: reason,
          heldRecipient: r.to.toLowerCase(),
          ...(meta ? { detail: meta } : {}),
        },
        { status: status ?? (held ? 202 : 403) },
      );
    }
  }

  // ── Idempotency check. Fingerprint mixes scope (apiKey hash vs
  // "owner-sig") so a Trial-key failure doesn't shadow-lock a Multichain
  // retry of the same intent, and apiKey rotation produces a fresh slot.
  // For owner-sig calls the scope is constant — all owner-sig requests
  // for the same (wallet, chain, token, recipients) hash to one slot.
  const scope = isModeC
    ? `apikey_${ethers.keccak256(ethers.toUtf8Bytes(body.apiKey!)).slice(2, 18)}`
    : "owner-sig";
  const fp = agenticBatchFingerprint(
    `${owner}:${walletId}:${scope}`,
    body.chain,
    body.token,
    rows,
  );
  const key = batchKey(fp);
  // Durable marker uses a SCOPE-LESS fingerprint (scope pinned to
  // "settled") — written only on success, so the shadow-lock reason for
  // scope-in-fp doesn't apply, and an API-key rotation between the
  // original batch and a retry can't slip a fresh fingerprint past the
  // replay guard.
  const settledMarkerKey = batchSettledKey(
    agenticBatchFingerprint(`${owner}:${walletId}:settled`, body.chain, body.token, rows),
  );

  // Durable replay guard FIRST: a batch that already settled ≥1 row in a
  // prior request — even older than the 10-min TTL record — replays its
  // stored result instead of re-firing every row with fresh nonces.
  // FAIL CLOSED: if the marker read errors we can't prove the batch
  // hasn't already settled, so reject (503) rather than risk re-firing.
  let durable: BatchRecord | null;
  try {
    durable = await kv.get<BatchRecord>(settledMarkerKey);
  } catch {
    return NextResponse.json(
      { error: "idempotency_unavailable", message: "Could not verify batch idempotency (storage). Retry shortly." },
      { status: 503 },
    );
  }
  const replay = durable ?? (await kv.get<BatchRecord>(key));
  if (replay) {
    return NextResponse.json(
      {
        batchId: replay.batchId,
        status: replay.status,
        results: replay.results,
        aborted: replay.aborted ?? false,
        idempotent: true,
        replayed: !!durable,
        startedAt: replay.startedAt,
        finishedAt: replay.finishedAt,
      },
      {
        status:
          replay.status === "partial"
            ? 207
            : replay.status === "failed" || replay.status === "uncertain"
              ? 502
              : 200,
      },
    );
  }

  // Per-tx max enforced per row; the running daily total is enforced
  // against the SUM of the batch atomically below.
  const perTxMax = wallet.perTxMaxUsd;
  let totalAmount = 0;
  for (const r of rows) {
    const v = Number(r.amount);
    if (typeof perTxMax === "number" && v > perTxMax) {
      return NextResponse.json(
        { error: "PER_TX_LIMIT_EXCEEDED", limit: perTxMax, row: r },
        { status: 403 },
      );
    }
    totalAmount += v;
  }

  const sub = await getSubscription(owner);
  // Batch is multichain-tier: even BNB-only trial users hit the gate
  // here. The single-recipient /send covers their flow.
  if (!hasMultichainScope(sub)) {
    return NextResponse.json(
      { error: "SUBSCRIPTION_REQUIRED", message: "Batch sends require a paid subscription." },
      { status: 402 },
    );
  }
  // Resolve apiKey:
  //   Mode C presented key — must equal the owner's current live
  //   multichain key (batch is multichain-only, so trial doesn't apply
  //   here even on BNB).
  //   Mode A/B (owner-sig) auto-picks sub.apiKey.
  let apiKey: string;
  if (isModeC) {
    const presented = body.apiKey!;
    if (presented !== sub?.apiKey) {
      return NextResponse.json(
        {
          error: "STALE_API_KEY",
          message:
            "This apiKey is no longer the live multichain key (or it's a trial key; " +
            "batch requires the paid multichain key). Rotate to the current key in your " +
            "dashboard and retry.",
        },
        { status: 401 },
      );
    }
    apiKey = presented;
  } else {
    const apiKeyMaybe = sub?.apiKey;
    if (!apiKeyMaybe) {
      return NextResponse.json({ error: "NO_API_KEY" }, { status: 402 });
    }
    apiKey = apiKeyMaybe;
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    return NextResponse.json({ error: "relay_unavailable" }, { status: 503 });
  }

  // ── Claim the batch slot atomically (SET NX). Concurrent retries
  // with the same body race here; the loser sees the winner's record
  // on its next GET (handled by the idempotency check above).
  const batchId = randomBytes(16).toString("hex");
  const initialRecord: BatchRecord = {
    batchId,
    ownerAddr: owner,
    walletId,
    chain: body.chain,
    token: body.token,
    results: [],
    startedAt: Date.now(),
    status: "processing",
  };
  const claimed = await kv.set(key, initialRecord, { nx: true, ex: IDEMPOTENCY_TTL_SEC });
  if (!claimed) {
    // Lost the SET NX race — a concurrent request beat us to it. Read
    // the record they wrote and return its current state.
    const live = await kv.get<BatchRecord>(key);
    if (live) {
      return NextResponse.json(
        {
          batchId: live.batchId,
          status: live.status,
          results: live.results,
          aborted: live.aborted ?? false,
          idempotent: true,
          startedAt: live.startedAt,
          finishedAt: live.finishedAt,
        },
        { status: 200 },
      );
    }
    return NextResponse.json({ error: "batch_claim_failed" }, { status: 500 });
  }

  // Released on every early-fail path AND if the batch settles 0 rows.
  // Without it, an `auth_nonce_failed` leaves the claim cached for the
  // full TTL even though no work happened — retries would see an empty
  // "processing" record forever.
  const releaseClaim = async () => {
    await kv.del(key).catch(() => {});
  };

  // ── Daily-cap reservation (atomic, per-wallet). Refund on any downstream fail. ──
  const reservation = await chargeAgainstDailyLimit(owner, walletId, totalAmount, wallet.dailyLimitUsd);
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

  // ── Sign + submit ──────────────────────────────────────────────────────
  const pk = decryptPrivateKey(wallet);
  const baseUrl = internalBaseUrl();
  const facilitator = relayerKey.address as Address;

  // Pre-fetch the EIP-7702 authorization nonce once. The first type-4
  // TX consumes it; subsequent rows still attach the same value to
  // their authorizationList — the EVM silently skips the stale entries
  // and the inner transferWithAuthorization runs against the EOA's
  // newly-applied delegation.
  //
  // CRITICAL: row 0 MUST commit before rows 1..N fire. Otherwise:
  //   - On chains that strictly enforce EIP-7702 stale-auth semantics
  //     (BNB / Ethereum / Avalanche — battle-tested) parallel rows
  //     with the same nonce are silently dropped at the auth-list
  //     stage but the inner call still executes against the freshly-
  //     applied delegation. Safe.
  //   - On chains with custom EVM forks (Reth-based Stable, op-stack
  //     Mantle, Sequencer-based Injective, Monad's parallel exec,
  //     Scroll's zkEVM) the stale-auth handling is UNVERIFIED. A
  //     stricter implementation might revert the WHOLE tx — meaning
  //     a paid user pays the daily-cap reservation for 20 rows of
  //     deterministic revert.
  //
  // Serialising row 0 lands the delegation on-chain first; rows 1..N
  // then fire in parallel against an EOA that's ALREADY delegated.
  // Their stale auth entries become a no-op even on strict chains
  // because the EOA's code field already matches the impl.
  let authNonce: number;
  try {
    authNonce = await fetchAuthNonce(body.chain, wallet.address as Address);
  } catch (e) {
    await refundDailySpend(owner, walletId, totalAmount).catch(() => {});
    await releaseClaim();
    console.error("[agentic-wallet/batch] fetchAuthNonce failed:", e);
    return NextResponse.json({ error: "auth_nonce_failed" }, { status: 502 });
  }

  async function processRow(row: { to: string; amount: string }): Promise<BatchResultRow> {
    // Whether the relay fetch was dispatched for this row. A throw past that
    // point may have broadcast on-chain (ambiguous) — see the catch below.
    let broadcastAttempted = false;
    try {
      // ── Q402 Hooks — beforeSettle, per row, BEFORE this row settles ───────
      // Mirrors send/route.ts: beforeAuthorize gates (OFAC/SpendCap) ran up
      // front for the whole batch, but beforeSettle hooks — ReputationGate in
      // particular — read STORED per-wallet config and only run for the
      // matching lifecycle. Without this dispatch a /batch row settles
      // WITHOUT the beforeSettle gate, so an owner who enabled "only pay
      // reputable counterparties" (incl. onUnknown:"deny") loses that
      // guarantee the moment payments route through /batch instead of /send.
      // A deny / require_approval here DROPS this row (it never settles) and
      // is recorded as a failed result, consistent with the existing per-row
      // failure handling — the batch's partial/failed (207/502) accounting,
      // daily-cap refund of unsettled rows, and idempotency/durable markers
      // all flow from `ok:false` rows unchanged. Batch carries no per-payment
      // hook params (params:undefined), so stored per-wallet config applies.
      const settleHook = await runHooks("beforeSettle", {
        lifecycle: "beforeSettle",
        owner,
        walletId,
        chain: body.chain as AgenticChainKey,
        token: body.token as AgenticToken,
        recipient: row.to.toLowerCase(),
        amount: row.amount,
        amountUsd: Number(row.amount),
        source: "batch",
        params: undefined,
      });
      if (settleHook.outcome.action !== "allow") {
        // Anything other than a clean allow means this row must NOT settle as
        // a plain single transfer:
        //   - deny / require_approval → drop the row (recorded as a failed
        //     result with the hook's stable code, e.g. REPUTATION_TOO_LOW).
        //   - split → batch has no per-row fan-out surface; settling the full
        //     amount to `row.to` would misdirect the split's funds, so we drop
        //     the row instead of silently single-paying. (MultiPayeeSplit only
        //     splits on explicit per-payment params, which batch never sends —
        //     this is a defensive guard, not a reachable path today.)
        const code =
          settleHook.outcome.action === "split"
            ? "SPLIT_NOT_SUPPORTED_IN_BATCH"
            : settleHook.outcome.code;
        return { to: row.to, amount: row.amount, ok: false, error: code };
      }
      const signed = await signAgenticPayment({
        privateKey: pk as Hex,
        chain: body.chain as AgenticChainKey,
        token: body.token as AgenticToken,
        to: row.to as Address,
        amount: row.amount,
        facilitator,
        authorizationNonce: authNonce,
      });
      // Past this line the relay may broadcast on-chain; a throw is ambiguous.
      broadcastAttempted = true;
      const resp = await submitToRelay(baseUrl, apiKey, signed, {
        source: "batch",
        internalTrustToken: process.env.CRON_SECRET,
      });
      const data = await resp.json().catch(() => null);
      if (resp.ok && data && typeof data === "object" && "txHash" in data) {
        return { to: row.to, amount: row.amount, ok: true, txHash: (data as { txHash: string }).txHash };
      }
      const errMsg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `relay_http_${resp.status}`;
      return { to: row.to, amount: row.amount, ok: false, error: errMsg };
    } catch (e) {
      // A throw AFTER the relay fetch was dispatched is AMBIGUOUS — the
      // transfer may have settled on-chain even though we lost the response.
      // Flag it uncertain so the batch keeps a durable replay guard and never
      // auto-retries this row (a retry re-signs with a fresh witness nonce and
      // would double-send). A throw BEFORE the fetch (hook / sign) is a clean
      // pre-broadcast failure (broadcastAttempted false).
      return {
        to: row.to,
        amount: row.amount,
        ok: false,
        // Connect/DNS-phase throws never reached the relay (no broadcast) →
        // clean failure, NOT uncertain. Only post-connect throws are ambiguous.
        uncertain: broadcastAttempted && !isRelayConnectPhaseError(e),
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Row 0 commits the delegation. Rows 1..N parallelise against the
  // now-delegated EOA. If row 0 fails entirely we abort: the EIP-7702
  // delegation never landed, so any subsequent row would attempt a
  // type-4 TX against a still-vanilla EOA, producing N more
  // deterministic failures while burning N more signing rounds + relay
  // calls + daily-cap reservation. The pending rows are marked
  // ABORTED_AFTER_ROW_0_FAILURE so the AI surfaces "20 didn't fire"
  // instead of "1 failed, 19 succeeded" (which would be a lie — none
  // succeeded). The daily-cap reservation reconciliation below refunds
  // the unspent portion automatically.
  const firstResult = await processRow(rows[0]);
  let restResults: BatchResultRow[] = [];
  const row0Aborted = !firstResult.ok;
  if (row0Aborted) {
    for (let i = 1; i < rows.length; i++) {
      restResults.push({
        to: rows[i].to,
        amount: rows[i].amount,
        ok: false,
        error: "ABORTED_AFTER_ROW_0_FAILURE",
      });
    }
  } else if (rows.length > 1) {
    restResults = await Promise.all(rows.slice(1).map(processRow));
  }
  const results: BatchResultRow[] = [firstResult, ...restResults];

  const successful = results.filter((r) => r.ok);
  // Honest terminal status: a batch with failed rows is NOT "complete".
  // Direct API users key on HTTP status + this field, so report partial
  // (207) when some rows failed and failed (502) when none settled.
  // An ambiguous (broadcast-then-threw) row makes the WHOLE batch's outcome
  // unknown — surface "uncertain" so the durable guard is armed and the client
  // is told to verify on-chain rather than retry.
  const anyUncertain = results.some((r) => r.uncertain);
  const batchStatus: BatchRecord["status"] = anyUncertain
    ? "uncertain"
    : successful.length === results.length
      ? "complete"
      : successful.length > 0
        ? "partial"
        : "failed";
  const finalRecord: BatchRecord = {
    ...initialRecord,
    results,
    finishedAt: Date.now(),
    status: batchStatus,
    aborted: row0Aborted,
  };
  // If we cannot write the final record, future retries will re-fire
  // (the cached "processing" record gets overwritten on retry by SET NX
  // expiration, and worse — settled txHashes are lost from the cache).
  // Wake an operator: settlement actually happened, we just can't prove
  // it to a retrying client.
  try {
    await kv.set(key, finalRecord, { ex: IDEMPOTENCY_TTL_SEC });
  } catch (e) {
    const settledHashes = successful
      .map((r) => r.txHash)
      .filter((h): h is string => !!h)
      .join(", ");
    void sendOpsAlert(
      `agentic-wallet/batch final write failed for ${owner} (batchId=${batchId}, ` +
        `chain=${body.chain}, settled=${successful.length}/${results.length}). ` +
        `Hashes: ${settledHashes || "(none)"}. Retries may re-fire. ` +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      "critical",
    );
  }

  // Durable replay guard: once ≥1 row confirmed on-chain, persist a
  // no-TTL marker so a retry beyond the 10-min window can't re-fire the
  // settled rows. A write failure here is NOT swallowed — it pages ops,
  // because losing this marker is exactly the post-TTL double-settle the
  // marker exists to prevent.
  if (successful.length > 0 || anyUncertain) {
    let markerOk = false;
    for (let attempt = 0; attempt < 3 && !markerOk; attempt++) {
      try {
        await kv.set(settledMarkerKey, finalRecord);
        markerOk = true;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!markerOk) {
      void sendOpsAlert(
        `agentic-wallet/batch DURABLE marker write failed (after retries) for ${owner} ` +
          `(batchId=${batchId}, chain=${body.chain}, settled=${successful.length}/${results.length}). ` +
          `A retry after the 10-min TTL could re-fire settled rows — verify before any replay.`,
        "critical",
      );
    }
  }

  // Page ops on any ambiguous row so a human verifies on-chain — the durable
  // marker (written above) already prevents the idempotency guard from
  // re-firing this batch.
  if (anyUncertain) {
    const u = results.filter((r) => r.uncertain);
    void sendOpsAlert(
      `agentic-wallet/batch relay FETCH threw — outcome UNCERTAIN for ${u.length} row(s). ` +
        `owner=${owner} walletId=${walletId} batchId=${batchId} chain=${body.chain} token=${body.token}. ` +
        `Recipients: ${u.map((r) => `${r.to}:${r.amount}`).join(", ")}. Verify on-chain BEFORE any ` +
        `retry — a re-fire re-signs with a fresh witness nonce and double-sends if the relay actually ` +
        `broadcast. The batch is marked uncertain (502) so the idempotency guard refuses to re-fire it.`,
      "critical",
    );
  }

  // Reconcile the daily-cap reservation against the actual settled total. We
  // reserved `totalAmount` up front; refund the CLEAN-failed rows so retries
  // (different recipient set) keep their budget. Uncertain rows may have
  // settled on-chain — keep their reservation so a same-day re-attempt can't
  // over-spend the daily cap.
  const successfulSum = successful.reduce((s, r) => s + Number(r.amount), 0);
  const uncertainSum = results
    .filter((r) => r.uncertain)
    .reduce((s, r) => s + Number(r.amount), 0);
  const refundAmount = totalAmount - successfulSum - uncertainSum;
  if (refundAmount > 0) {
    await refundDailySpend(owner, walletId, refundAmount).catch(() => {});
  }

  return NextResponse.json(
    {
      batchId,
      status: batchStatus,
      results,
      settled: successful.length,
      failed: results.length - successful.length,
      aborted: row0Aborted,
      idempotent: false,
      startedAt: finalRecord.startedAt,
      finishedAt: finalRecord.finishedAt,
    },
    {
      status:
        batchStatus === "partial"
          ? 207
          : batchStatus === "failed" || batchStatus === "uncertain"
            ? 502
            : 200,
    },
  );
}
