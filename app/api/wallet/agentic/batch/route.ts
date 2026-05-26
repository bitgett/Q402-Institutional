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
 * Phase 2 scope:
 *   - Multichain only (gated by `hasMultichainScope`). BNB-only trial
 *     keys cannot batch — single-recipient /send is sufficient there.
 *   - Owner EIP-191 signature auth. API-key (MCP) is Phase 3.
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
import { randomBytes } from "node:crypto";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { agenticBatchFingerprint } from "@/app/lib/agentic-batch-fingerprint";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
  isKeystoreReady,
  chargeAgainstDailyLimit,
  refundDailySpend,
} from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import {
  isAgenticChainKey,
  signAgenticPayment,
  submitToRelay,
  internalBaseUrl,
  fetchAuthNonce,
  type AgenticChainKey,
  type AgenticToken,
} from "@/app/lib/agentic-wallet-sign";
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
  /** Lowercased Agent Wallet address to source the batch from. Required. */
  walletId?: string;
  ownerAddress?: string;
  nonce?: string;
  signature?: string;
}

interface BatchResultRow {
  to: string;
  amount: string;
  ok: boolean;
  txHash?: string;
  error?: string;
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
  status: "processing" | "complete";
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

  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }
  const walletId = body.walletId.toLowerCase();

  // ── Auth — intent-bound challenge over the full recipient set + wallet ─
  // walletId is now part of the intent so a signature bound to wallet A
  // cannot drain wallet B's balance.
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-batch", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  // Fingerprint mixes walletId so two wallets settling identical recipient
  // sets share no cache slot.
  const rowsHash = agenticBatchFingerprint(
    `${(body.ownerAddress ?? "").toLowerCase()}:${walletId}`,
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
      walletId,
      chain: body.chain,
      token: body.token,
      rows: String(rows.length),
      fp: rowsHash,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // ── Idempotency check FIRST. A retry of a previously-completed batch
  // returns the cached record before we touch limits / subscription /
  // the keystore — the original call already paid those costs. This
  // also closes the "Safe to retry" double-send hole on timeout: even
  // if the agent retries with the exact same body (after re-minting
  // a fresh action-challenge), no second batch fires while the cache
  // window is alive.
  //
  // Reuses `rowsHash` computed above so the auth's bound `fp` matches
  // the cache lookup — single source of truth, no drift.
  const fp = rowsHash;
  const key = batchKey(fp);
  const cached = await kv.get<BatchRecord>(key);
  if (cached) {
    return NextResponse.json(
      {
        batchId: cached.batchId,
        status: cached.status,
        results: cached.results,
        idempotent: true,
        startedAt: cached.startedAt,
        finishedAt: cached.finishedAt,
      },
      { status: 200 },
    );
  }

  // ── Pre-flight: keystore + wallet + sub + limits ────────────────────────
  const ready = isKeystoreReady();
  if (!ready.ok) {
    console.error("[agentic-wallet/batch] keystore unavailable:", ready.reason);
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
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
  const apiKey = sub?.apiKey;
  if (!apiKey) {
    return NextResponse.json({ error: "NO_API_KEY" }, { status: 402 });
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
  // newly-applied delegation. Sequential nonces would break parallel
  // submission ordering, which is the wrong trade-off here.
  let authNonce: number;
  try {
    authNonce = await fetchAuthNonce(body.chain, wallet.address as Address);
  } catch (e) {
    await refundDailySpend(owner, walletId, totalAmount).catch(() => {});
    await releaseClaim();
    console.error("[agentic-wallet/batch] fetchAuthNonce failed:", e);
    return NextResponse.json({ error: "auth_nonce_failed" }, { status: 502 });
  }

  // Process rows in parallel. The shared apiKey is billed per
  // successful settlement; the canonical relay route handles its own
  // sequencing/locking on the apiKey side.
  const results: BatchResultRow[] = await Promise.all(
    rows.map(async (row): Promise<BatchResultRow> => {
      try {
        const signed = await signAgenticPayment({
          privateKey: pk as Hex,
          chain: body.chain as AgenticChainKey,
          token: body.token as AgenticToken,
          to: row.to as Address,
          amount: row.amount,
          facilitator,
          authorizationNonce: authNonce,
        });
        const resp = await submitToRelay(baseUrl, apiKey, signed);
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
        return {
          to: row.to,
          amount: row.amount,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  const successful = results.filter((r) => r.ok);
  const finalRecord: BatchRecord = {
    ...initialRecord,
    results,
    finishedAt: Date.now(),
    status: "complete",
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

  // Reconcile the daily-cap reservation against the actual settled
  // total. We reserved `totalAmount` up front; refund the failed rows
  // so retries (different recipient set) keep their budget.
  const successfulSum = successful.reduce((s, r) => s + Number(r.amount), 0);
  const refundAmount = totalAmount - successfulSum;
  if (refundAmount > 0) {
    await refundDailySpend(owner, walletId, refundAmount).catch(() => {});
  }

  return NextResponse.json(
    {
      batchId,
      status: "complete",
      results,
      settled: successful.length,
      failed: results.length - successful.length,
      idempotent: false,
      startedAt: finalRecord.startedAt,
      finishedAt: finalRecord.finishedAt,
    },
    { status: 200 },
  );
}
