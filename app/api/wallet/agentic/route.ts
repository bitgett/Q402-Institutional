/**
 * /api/wallet/agentic — multi-wallet CRUD (up to 10 per owner).
 *
 *   POST   — create a new wallet. Enforces per-plan cap (trial=1,
 *            multichain-paid=MAX_WALLETS_PER_OWNER). 409 on cap hit.
 *   GET    — without walletId: list all wallets for the owner.
 *            with walletId: return that single wallet record.
 *   PATCH  — update per-wallet limits (dailyLimitUsd, perTxMaxUsd, label).
 *            Intent-bound: signed message embeds the new values so a
 *            leaked session sig can't silently raise the caps.
 *   DELETE — soft-delete a specific walletId. Intent-bound.
 *
 * Auth model:
 *   - GET                 → session sig (read-only)
 *   - POST (create)       → session sig (creating own wallet)
 *   - PATCH (limits)      → intent-bound `agentic.limits`
 *   - DELETE (archive)    → intent-bound `agentic.archive`
 *
 * The MCP server reads wallets via /info-by-key with apiKey auth
 * instead of this endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireIntentAuth } from "@/app/lib/auth";
import { hasActiveEscrowFundedBy } from "@/app/lib/escrow";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import {
  createAgenticWallet,
  getAgenticWallet,
  listAgenticWallets,
  softDeleteAgenticWallet,
  updateAgenticWalletLimits,
  isKeystoreReady,
  effectiveWalletCap,
  MAX_WALLETS_PER_OWNER,
  TRIAL_WALLET_CAP,
  type AgenticWalletRecord,
} from "@/app/lib/agentic-wallet";
import { readReputationSummary } from "@/app/lib/erc8004-reputation";
import { RELAYER_ADDRESS } from "@/app/lib/wallets";

export const runtime = "nodejs";

interface PublicProjection {
  ownerAddr: string;
  address: string;
  walletId: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
  label: string | null;
  /** Populated after projection when the wallet is ERC-8004 graduated.
   *  Null when the on-chain RPC fails — UI then just hides the row. */
  reputation?: import("@/app/lib/erc8004-reputation").ReputationSummaryView | null;
}

/** Project only fields safe to surface to the client. */
function projectPublic(record: AgenticWalletRecord): PublicProjection {
  return {
    ownerAddr: record.ownerAddr,
    address: record.address,
    /** Lowercased wallet address used as walletId throughout the API. */
    walletId: record.address.toLowerCase(),
    createdAt: record.createdAt,
    deletedAt: record.deletedAt ?? null,
    dailyLimitUsd: record.dailyLimitUsd ?? null,
    perTxMaxUsd: record.perTxMaxUsd ?? null,
    erc8004AgentId: record.erc8004AgentId ?? null,
    label: record.label ?? null,
  };
}

async function parseJson<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

interface AuthBody {
  address?: string;
  nonce?: string;
  signature?: string;
}

async function authFromBody(
  req: NextRequest,
  body: AuthBody | null,
): Promise<string | NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-crud", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const result = await requireAuth(
    body?.address ?? null,
    body?.nonce ?? null,
    body?.signature ?? null,
  );
  if (typeof result !== "string") {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.status },
    );
  }
  return result;
}

async function authFromQuery(req: NextRequest): Promise<string | NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-crud", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const result = await requireAuth(
    req.nextUrl.searchParams.get("address"),
    req.nextUrl.searchParams.get("nonce"),
    req.nextUrl.searchParams.get("sig"),
  );
  if (typeof result !== "string") {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.status },
    );
  }
  return result;
}

// ── GET ────────────────────────────────────────────────────────────────────

/**
 * Behaviour:
 *   No `walletId` query → returns `{ wallets: [...] }` (zero or more).
 *   With `walletId` query → returns `{ wallet: {...} | null }`.
 *
 * Both shapes also include `hasMultichainScope` and `cap` so the
 * dashboard can render the "+ New wallet" button correctly without a
 * second round-trip.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authFromQuery(req);
  if (auth instanceof NextResponse) return auth;

  const sub = await getSubscription(auth);
  const multichain = hasMultichainScope(sub);
  const cap = effectiveWalletCap(multichain);

  const walletId = req.nextUrl.searchParams.get("walletId");
  if (walletId) {
    const record = await getAgenticWallet(auth, walletId);
    // Inject ERC-8004 reputation for graduated wallets so the dashboard
    // card can render it inline with the agent badge. The 5-min cache
    // inside `readReputationSummary` keeps the RPC bill bounded.
    const projected = record ? projectPublic(record) : null;
    if (projected && record?.erc8004AgentId) {
      projected.reputation = await readReputationSummary(
        record.erc8004AgentId,
        RELAYER_ADDRESS as `0x${string}`,
      );
    }
    return NextResponse.json({
      wallet: projected,
      hasMultichainScope: multichain,
      cap,
    });
  }

  const records = await listAgenticWallets(auth);
  const projected = records.map(projectPublic);
  // Parallel reputation fetches for any graduated wallets in the list.
  // Non-graduated wallets cost zero RPC; graduated wallets share the
  // same 5-min KV cache as the single-wallet path.
  await Promise.all(
    projected.map(async (w, i) => {
      const rec = records[i];
      if (rec?.erc8004AgentId) {
        w.reputation = await readReputationSummary(
          rec.erc8004AgentId,
          RELAYER_ADDRESS as `0x${string}`,
        );
      }
    }),
  );
  return NextResponse.json({
    wallets: projected,
    hasMultichainScope: multichain,
    cap,
    max: MAX_WALLETS_PER_OWNER,
    trialCap: TRIAL_WALLET_CAP,
  });
}

// ── POST ───────────────────────────────────────────────────────────────────

interface PostBody extends AuthBody {
  /** Optional human label, e.g. "Trading bot", "Subscriptions". ≤40 chars. */
  label?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseJson<PostBody>(req);
  const auth = await authFromBody(req, body);
  if (auth instanceof NextResponse) return auth;

  const ready = isKeystoreReady();
  if (!ready.ok) {
    console.error("[agentic-wallet POST] keystore unavailable:", ready.reason);
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  const sub = await getSubscription(auth);
  const cap = effectiveWalletCap(hasMultichainScope(sub));

  // Validate label
  let label: string | undefined;
  if (typeof body?.label === "string") {
    const trimmed = body.label.trim();
    if (trimmed.length > 40) {
      return NextResponse.json(
        { error: "label_too_long", message: "label must be ≤40 characters" },
        { status: 400 },
      );
    }
    if (trimmed.length > 0) label = trimmed;
  }

  try {
    const record = await createAgenticWallet(auth, { cap, label });

    return NextResponse.json({ wallet: projectPublic(record) }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENTIC_WALLET_CREATE_LOCKED") {
      // Another concurrent create for this owner is mid-flight (10s TTL).
      // Surface a 409 + Retry-After so the dashboard can re-attempt
      // after the in-flight one settles rather than racing into a
      // double-create.
      return NextResponse.json(
        {
          error: "AGENTIC_WALLET_CREATE_LOCKED",
          message: "Another wallet is being created for this owner. Try again in a few seconds.",
        },
        { status: 409, headers: { "Retry-After": "3" } },
      );
    }
    if (msg === "AGENTIC_WALLET_CAP_REACHED") {
      const have = (e as Error & { have?: number }).have ?? cap;
      return NextResponse.json(
        {
          error: "AGENTIC_WALLET_CAP_REACHED",
          message: `Plan cap reached: ${have}/${cap} wallets. ${
            cap === TRIAL_WALLET_CAP
              ? "Upgrade to Multichain to create more."
              : `Archive an existing wallet first.`
          }`,
          have,
          cap,
        },
        { status: 409 },
      );
    }
    if (msg === "AGENTIC_WALLET_EXISTS") {
      // Cosmically unlikely ECDSA collision. Retry once on the client.
      return NextResponse.json(
        { error: "AGENTIC_WALLET_EXISTS", message: "Address collision — retry." },
        { status: 409 },
      );
    }
    console.error("[api/wallet/agentic POST] failed:", e);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}

// ── PATCH ──────────────────────────────────────────────────────────────────

interface PatchBody extends AuthBody {
  walletId?: string;
  dailyLimitUsd?: number | null;
  perTxMaxUsd?: number | null;
  label?: string | null;
}

/**
 * PATCH limits is now intent-bound (`agentic.limits`) — closes the
 * leak where a leaked session signature could silently raise caps.
 * The signed message embeds the NEW values, the walletId, and the owner
 * so a captured signature is provably tied to *this* exact mutation.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-crud", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await parseJson<PatchBody>(req);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }

  const LIMIT_MAX_USD = 1_000_000;
  const validLimit = (
    v: unknown,
    field: string,
  ): { ok: true; value: number | null | undefined } | { ok: false; res: NextResponse } => {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      return { ok: true, value: undefined };
    }
    if (v === null) return { ok: true, value: null };
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, res: NextResponse.json({ error: `${field} must be a finite number or null` }, { status: 400 }) };
    }
    if (v < 0) {
      return { ok: false, res: NextResponse.json({ error: `${field} cannot be negative` }, { status: 400 }) };
    }
    if (v > LIMIT_MAX_USD) {
      return { ok: false, res: NextResponse.json({ error: `${field} cannot exceed ${LIMIT_MAX_USD}` }, { status: 400 }) };
    }
    return { ok: true, value: v };
  };

  const daily = validLimit(body.dailyLimitUsd, "dailyLimitUsd");
  if (!daily.ok) return daily.res;
  const perTx = validLimit(body.perTxMaxUsd, "perTxMaxUsd");
  if (!perTx.ok) return perTx.res;

  // Label validation
  let labelPatch: string | null | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(body, "label")) {
    if (body.label === null) {
      labelPatch = null;
    } else if (typeof body.label === "string") {
      const t = body.label.trim();
      if (t.length > 40) {
        return NextResponse.json({ error: "label must be ≤40 characters" }, { status: 400 });
      }
      labelPatch = t.length > 0 ? t : null;
    } else {
      return NextResponse.json({ error: "label must be a string or null" }, { status: 400 });
    }
  }

  // Build intent fields. Normalise null/undefined to a stable string so
  // client + server compute identical canonical messages.
  const intent: Record<string, string | number> = {
    walletId: body.walletId.toLowerCase(),
    dailyLimitUsd: daily.value === undefined ? "unchanged" : daily.value === null ? "null" : String(daily.value),
    perTxMaxUsd: perTx.value === undefined ? "unchanged" : perTx.value === null ? "null" : String(perTx.value),
    label: labelPatch === undefined ? "unchanged" : labelPatch === null ? "null" : labelPatch,
  };

  const auth = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.limits",
    intent,
  });
  if (typeof auth !== "string") {
    return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
  }

  // Build the patch we'll actually apply.
  const patch: { dailyLimitUsd?: number | null; perTxMaxUsd?: number | null; label?: string | null } = {};
  if (daily.value !== undefined) patch.dailyLimitUsd = daily.value;
  if (perTx.value !== undefined) patch.perTxMaxUsd = perTx.value;
  if (labelPatch !== undefined) patch.label = labelPatch;

  try {
    const next = await updateAgenticWalletLimits(auth, body.walletId, patch);
    return NextResponse.json({ wallet: projectPublic(next) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENTIC_WALLET_NOT_FOUND") {
      return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
    }
    console.error("[api/wallet/agentic PATCH] failed:", e);
    return NextResponse.json({ error: "patch_failed" }, { status: 500 });
  }
}

// ── DELETE ─────────────────────────────────────────────────────────────────

interface DeleteBody extends AuthBody {
  walletId?: string;
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-crud", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await parseJson<DeleteBody>(req);
  if (!body?.walletId) {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }

  const auth = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.archive",
    intent: {
      walletId: body.walletId.toLowerCase(),
    },
  });
  if (typeof auth !== "string") {
    return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
  }

  // G7: never orphan an open escrow. A wallet with a non-terminal escrow it
  // funds still needs its key to release/refund; deleting it (and, after grace,
  // GC hard-erasing the key) would strand the locked funds. Block until the
  // escrow settles.
  if (await hasActiveEscrowFundedBy(auth, body.walletId)) {
    return NextResponse.json(
      { error: "This wallet has an active escrow. Release, refund, or resolve it before deleting the wallet.", code: "ESCROW_ACTIVE" },
      { status: 409 },
    );
  }

  await softDeleteAgenticWallet(auth, body.walletId);
  return NextResponse.json({ ok: true });
}
