/**
 * /api/wallet/agentic — CRUD for a user's Agentic Wallet (1-per-user MVP).
 *
 *   POST   — create the wallet. 409 if one already exists for the owner.
 *   GET    — return the wallet record (address, limits, deletedAt, agentId).
 *            Excludes the encrypted private key — that's only ever surfaced
 *            via POST /api/wallet/agentic/export.
 *   PATCH  — update per-wallet limits (dailyLimitUsd, perTxMaxUsd).
 *   DELETE — soft-delete. Hard delete fires after the grace window via cron.
 *
 * Auth: every method requires owner EOA signature (address + nonce + sig)
 * verified by `requireAuth`. The MCP server reads the wallet via the
 * dedicated /send + /info endpoints with apiKey auth instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import {
  createAgenticWallet,
  getAgenticWallet,
  softDeleteAgenticWallet,
  updateAgenticWalletLimits,
  isKeystoreReady,
  type AgenticWalletRecord,
} from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

/**
 * Surface to the client only the fields that are safe to render. The
 * encrypted PK + nonce + tag never leave the server outside the explicit
 * `/export` flow.
 */
function projectPublic(record: AgenticWalletRecord) {
  return {
    ownerAddr: record.ownerAddr,
    address: record.address,
    createdAt: record.createdAt,
    deletedAt: record.deletedAt ?? null,
    dailyLimitUsd: record.dailyLimitUsd ?? null,
    perTxMaxUsd: record.perTxMaxUsd ?? null,
    erc8004AgentId: record.erc8004AgentId ?? null,
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authFromQuery(req);
  if (auth instanceof NextResponse) return auth;

  const record = await getAgenticWallet(auth);
  if (!record) {
    return NextResponse.json({ wallet: null }, { status: 200 });
  }
  // Surface the multichain scope alongside the wallet so the dashboard
  // can gate features client-side (BatchModal trigger, non-BNB chain
  // hints) without a second round-trip to /api/keys/verify.
  const sub = await getSubscription(auth);
  return NextResponse.json({
    wallet: projectPublic(record),
    hasMultichainScope: hasMultichainScope(sub),
  });
}

// ── POST ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseJson<AuthBody>(req);
  const auth = await authFromBody(req, body);
  if (auth instanceof NextResponse) return auth;

  // Pre-flight: surface a 503 if the keystore env isn't configured rather
  // than letting createAgenticWallet → encrypt throw.
  const ready = isKeystoreReady();
  if (!ready.ok) {
    console.error("[agentic-wallet POST] keystore unavailable:", ready.reason);
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  try {
    const record = await createAgenticWallet(auth);
    return NextResponse.json({ wallet: projectPublic(record) }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENTIC_WALLET_EXISTS") {
      return NextResponse.json(
        { error: "AGENTIC_WALLET_EXISTS", message: "An Agentic Wallet already exists for this owner." },
        { status: 409 },
      );
    }
    console.error("[api/wallet/agentic POST] failed:", e);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}

// ── PATCH ──────────────────────────────────────────────────────────────────

interface PatchBody extends AuthBody {
  dailyLimitUsd?: number | null;
  perTxMaxUsd?: number | null;
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const body = await parseJson<PatchBody>(req);
  const auth = await authFromBody(req, body);
  if (auth instanceof NextResponse) return auth;

  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Hard ceiling: enough headroom for any realistic wallet use case while
  // still ruling out paste-error / overflow values (e.g. 1e18 from a copy
  // of a raw token amount). One-shot upgrade by editing this constant if
  // institutional users ever push past it.
  const LIMIT_MAX_USD = 1_000_000;

  const validLimit = (v: unknown, field: string): { ok: true; value: number | null } | { ok: false; res: NextResponse } => {
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

  // Each limit is independently optional. null = clear, number = set, undefined = leave.
  const patch: { dailyLimitUsd?: number | null; perTxMaxUsd?: number | null } = {};
  if ("dailyLimitUsd" in body) {
    const v = validLimit(body.dailyLimitUsd, "dailyLimitUsd");
    if (!v.ok) return v.res;
    patch.dailyLimitUsd = v.value;
  }
  if ("perTxMaxUsd" in body) {
    const v = validLimit(body.perTxMaxUsd, "perTxMaxUsd");
    if (!v.ok) return v.res;
    patch.perTxMaxUsd = v.value;
  }

  try {
    const next = await updateAgenticWalletLimits(auth, patch);
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

interface DeleteBody {
  address?: string;
  nonce?: string;
  signature?: string;
}

/**
 * Archive (soft-delete) is destructive — once the 7-day grace expires
 * the encrypted private key is hard-deleted from KV. A reusable
 * session signature has no business firing this; we require an
 * `agentic.archive` action challenge so the same signed bytes can't
 * be relayed to delete anyone else's wallet, and so a leaked session
 * sig has no path to a destructive action.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-crud", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await parseJson<DeleteBody>(req);
  const auth = await requireIntentAuth({
    address: body?.address ?? null,
    challenge: body?.nonce ?? null,
    signature: body?.signature ?? null,
    action: "agentic.archive",
    intent: { target: (body?.address ?? "").toLowerCase() },
  });
  if (typeof auth !== "string") {
    return NextResponse.json(
      { error: auth.error, code: auth.code },
      { status: auth.status },
    );
  }

  await softDeleteAgenticWallet(auth);
  return NextResponse.json({ ok: true });
}
