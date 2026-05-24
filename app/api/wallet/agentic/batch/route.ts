/**
 * POST /api/wallet/agentic/batch
 *
 * Server-mediated multi-recipient send from the caller's Agent Wallet.
 * Same trust model as /send (server holds the AES-GCM-wrapped private
 * key), one row per recipient, up to 20 rows.
 *
 * Idempotency — central to this route after the May 2026 Codex retry
 * incident. Each batch is fingerprinted by
 *   keccak(owner + chain + token + sorted(recipients × amounts))
 * and the result is cached in KV for `IDEMPOTENCY_TTL_SEC`. A retry
 * within that window returns the existing batch record (cached
 * results, no re-firing) so an agent that misreads a timeout cannot
 * double-spend.
 *
 * Phase 2 scope:
 *   - Multichain only (gated by `hasMultichainScope`). BNB-only trial
 *     keys cannot batch — single-recipient /send is sufficient there.
 *   - Owner EIP-191 signature auth. API-key (MCP) is Phase 3.
 *   - Limits enforced: every row honors perTxMaxUsd; the running
 *     dailyLimitUsd budget covers the whole batch sum.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { randomBytes } from "node:crypto";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
  isKeystoreReady,
  checkDailyLimit,
  recordDailySpend,
} from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { loadRelayerKey } from "@/app/lib/relayer-key";
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

function fingerprint(
  owner: string,
  chain: string,
  token: string,
  rows: { to: string; amount: string }[],
): string {
  const sorted = rows
    .map((r) => `${r.to.toLowerCase()}:${r.amount}`)
    .sort()
    .join(",");
  const seed = `${owner.toLowerCase()}|${chain}|${token}|${sorted}`;
  return ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(2, 18);
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

  // ── Auth ────────────────────────────────────────────────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-batch", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const authResult = await requireAuth(
    body.ownerAddress ?? null,
    body.nonce ?? null,
    body.signature ?? null,
  );
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // ── Pre-flight: keystore + wallet + sub + relayer ───────────────────────
  const ready = isKeystoreReady();
  if (!ready.ok) {
    return NextResponse.json({ error: "keystore_unavailable", detail: ready.reason }, { status: 503 });
  }

  const wallet = await getActiveAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  // Per-tx max enforced per row; the running daily total is enforced
  // against the SUM of the batch.
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
  const dailyCheck = await checkDailyLimit(owner, totalAmount, wallet.dailyLimitUsd);
  if (!dailyCheck.allowed) {
    return NextResponse.json(
      {
        error: "DAILY_LIMIT_EXCEEDED",
        limit: dailyCheck.limit,
        spent: dailyCheck.spent,
        requested: dailyCheck.requested,
      },
      { status: 403 },
    );
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

  // ── Idempotency check ──────────────────────────────────────────────────
  const fp = fingerprint(owner, body.chain, body.token, rows);
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

  // Reserve the slot before signing so a concurrent retry sees
  // "processing" and waits rather than firing in parallel.
  const batchId = randomBytes(16).toString("hex");
  const initialRecord: BatchRecord = {
    batchId,
    ownerAddr: owner,
    chain: body.chain,
    token: body.token,
    results: [],
    startedAt: Date.now(),
    status: "processing",
  };
  await kv.set(key, initialRecord, { ex: IDEMPOTENCY_TTL_SEC });

  // ── Sign + submit ──────────────────────────────────────────────────────
  const pk = decryptPrivateKey(wallet);
  const baseUrl = internalBaseUrl();
  const facilitator = relayerKey.address as Address;

  // Pre-fetch the EIP-7702 authorization nonce once; all 20 rows reuse
  // it. (Each TX is independent on the witness side, but they share
  // the EIP-7702 delegation, so a single auth nonce is correct.)
  let authNonce: number;
  try {
    authNonce = await fetchAuthNonce(body.chain, wallet.address as Address);
  } catch (e) {
    console.error("[agentic-wallet/batch] fetchAuthNonce failed:", e);
    return NextResponse.json({ error: "auth_nonce_failed" }, { status: 502 });
  }

  // Process rows in parallel. The shared apiKey is billed per
  // successful settlement, but the relay route already handles its own
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
  await kv.set(key, finalRecord, { ex: IDEMPOTENCY_TTL_SEC });

  // Daily spend records only the successful settlements.
  const successfulSum = successful.reduce((s, r) => s + Number(r.amount), 0);
  if (successfulSum > 0) {
    await recordDailySpend(owner, successfulSum).catch(() => {});
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
