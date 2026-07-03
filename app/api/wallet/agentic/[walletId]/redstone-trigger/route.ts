/**
 * /api/wallet/agentic/[walletId]/redstone-trigger
 *
 *   GET   — list every RedStone trigger attached to this walletId (owner-sig).
 *   POST  — create a trigger under this wallet. Intent-bound
 *           `agentic.redstone-trigger.create` with the trigger's full shape in
 *           the canonical message so a leaked session sig can't author one with
 *           a different feed / threshold / recipient / amount.
 *
 * Gated by REDSTONE_ENABLED (503 while off). New triggers are created DISARMED
 * (see redstone-trigger.ts) — no instant-fire on a level already breached.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuth, requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { isAgenticChainKey, type AgenticChainKey, type AgenticToken } from "@/app/lib/agentic-wallet-sign";
import { redstoneEnabled, redstoneConfig } from "@/app/lib/redstone";
import {
  createTrigger,
  listTriggers,
  projectTrigger,
  dailyCapSatisfied,
  TriggerValidationError,
  type TriggerOp,
  type TriggerMode,
} from "@/app/lib/redstone-trigger";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ walletId: string }>;
}

const VALID_OPS: TriggerOp[] = [">=", "<=", ">", "<"];

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

// ── GET ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  if (!redstoneEnabled()) {
    return NextResponse.json({ error: "REDSTONE_DISABLED" }, { status: 503 });
  }
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-redstone-trigger", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { walletId } = await ctx.params;
  if (!isHexAddress(walletId)) {
    return NextResponse.json({ error: "INVALID_WALLET_ID" }, { status: 400 });
  }

  const authResult = await requireAuth(
    req.nextUrl.searchParams.get("address"),
    req.nextUrl.searchParams.get("nonce"),
    req.nextUrl.searchParams.get("sig"),
  );
  if (typeof authResult !== "string") {
    return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
  }
  const owner = authResult;

  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  const triggers = await listTriggers(owner, walletId);
  return NextResponse.json({ triggers: triggers.map(projectTrigger) });
}

// ── POST ─────────────────────────────────────────────────────────────────

interface CreateBody {
  address?: string;
  nonce?: string;
  signature?: string;
  label?: string | null;
  feedId?: string;
  op?: string;
  threshold?: number;
  chain?: string;
  token?: string;
  recipient?: string;
  amount?: string;
  mode?: string;
  cooldownSec?: number;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  if (!redstoneEnabled()) {
    return NextResponse.json({ error: "REDSTONE_DISABLED" }, { status: 503 });
  }
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-redstone-trigger", 12, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { walletId } = await ctx.params;
  if (!isHexAddress(walletId)) {
    return NextResponse.json({ error: "INVALID_WALLET_ID" }, { status: 400 });
  }

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Shape validation up front (so the intent message binds known-good values)
  if (!isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  if (body.token !== "USDC" && body.token !== "USDT" && body.token !== "USDG") {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 400 });
  }
  if (body.token === "USDG" && body.chain !== "robinhood") {
    return NextResponse.json({ error: "INVALID_TOKEN", message: "USDG is only available on Robinhood Chain." }, { status: 400 });
  }
  if (body.chain === "robinhood" && body.token !== "USDG") {
    return NextResponse.json({ error: "INVALID_TOKEN", message: "Robinhood Chain supports USDG only." }, { status: 400 });
  }
  const op = (body.op ?? "") as TriggerOp;
  if (!VALID_OPS.includes(op)) {
    return NextResponse.json({ error: "INVALID_OP" }, { status: 400 });
  }
  if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) {
    return NextResponse.json({ error: "INVALID_THRESHOLD" }, { status: 400 });
  }
  if (typeof body.feedId !== "string" || body.feedId.length === 0) {
    return NextResponse.json({ error: "INVALID_FEED" }, { status: 400 });
  }
  const allowed = redstoneConfig().allowedFeeds;
  if (!allowed.includes(body.feedId.toUpperCase())) {
    return NextResponse.json(
      { error: "FEED_NOT_ALLOWLISTED", message: `feedId "${body.feedId}" is not readable on this deployment.`, allowedFeeds: allowed },
      { status: 400 },
    );
  }
  if (!isHexAddress(body.recipient)) {
    return NextResponse.json({ error: "INVALID_RECIPIENT" }, { status: 400 });
  }
  if (typeof body.amount !== "string" || !/^\d+(\.\d{1,18})?$/.test(body.amount) || Number(body.amount) <= 0) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  const mode: TriggerMode = body.mode === "repeat" ? "repeat" : "once";
  const cooldownSec = typeof body.cooldownSec === "number" ? body.cooldownSec : 0;
  const feedId = body.feedId.toUpperCase();
  const recipient = body.recipient.toLowerCase();

  // ── Intent-bound auth — the canonical message embeds the trigger's full
  //    shape so a leaked session sig can't author a different one.
  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.redstone-trigger.create",
    intent: {
      walletId: walletId.toLowerCase(),
      feedId,
      op,
      threshold: body.threshold,
      chain: body.chain,
      token: body.token,
      recipient,
      amount: body.amount,
      mode,
      cooldownSec,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
  }
  const owner = authResult;

  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  // Subscription gate — automated fires are paid-only on every chain.
  if (!hasMultichainScope(await getSubscription(owner))) {
    return NextResponse.json(
      { error: "SUBSCRIPTION_REQUIRED", message: "RedStone triggers require the paid Multichain subscription." },
      { status: 402 },
    );
  }

  // Per-tx cap at create time.
  if (wallet.perTxMaxUsd !== undefined && wallet.perTxMaxUsd !== null && Number(body.amount) > wallet.perTxMaxUsd) {
    return NextResponse.json(
      {
        error: "PER_TX_CAP_EXCEEDED",
        message: `amount ($${Number(body.amount)}) exceeds this wallet's per-tx cap ($${wallet.perTxMaxUsd}).`,
        perTxMaxUsd: wallet.perTxMaxUsd,
      },
      { status: 400 },
    );
  }

  // FAIL-CLOSED: a repeat trigger fires on every crossing, so it MUST be bounded
  // by a wallet daily cap (per-tx bounds one fire, not the aggregate). A `once`
  // trigger is bounded by its single amount, so exempt.
  if (!dailyCapSatisfied(mode, wallet.dailyLimitUsd)) {
    return NextResponse.json(
      {
        error: "DAILY_CAP_REQUIRED",
        message: 'A repeat RedStone trigger requires a daily spend cap (dailyLimitUsd) on the wallet. Set one, or use mode "once".',
      },
      { status: 400 },
    );
  }

  try {
    const t = await createTrigger({
      ownerAddr: owner,
      walletId: walletId.toLowerCase(),
      label: body.label ?? null,
      feedId,
      op,
      threshold: body.threshold,
      chain: body.chain as AgenticChainKey,
      token: body.token as AgenticToken,
      recipient,
      amount: body.amount,
      mode,
      cooldownSec,
    });
    return NextResponse.json({ trigger: projectTrigger(t) }, { status: 201 });
  } catch (e) {
    if (e instanceof TriggerValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    console.error("[agentic-wallet/redstone-trigger] createTrigger failed:", e);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}
