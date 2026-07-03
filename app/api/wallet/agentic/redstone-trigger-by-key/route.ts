/**
 * POST /api/wallet/agentic/redstone-trigger-by-key
 *
 * RedStone data-event trigger CRUD authenticated by apiKey alone (Mode C — no
 * signature). Mirrors recurring-by-key so the MCP can drive the same watcher the
 * dashboard uses without holding a signing key.
 *
 * Gated by REDSTONE_ENABLED — returns 503 while the feature is off (default), so
 * nothing is creatable until an operator flips the flag.
 *
 * Risk posture: a compromised apiKey can author triggers whose fires are bounded
 * by the wallet's perTxMaxUsd per fire. A `once` trigger fires once (bounded by
 * its single amount); a `repeat` trigger fires on every crossing, so it is
 * FAIL-CLOSED — create/resume reject and the watcher terminal-skips a repeat
 * trigger unless the wallet has a positive dailyLimitUsd (the aggregate bound).
 * New triggers are created DISARMED, so a leaked key cannot instant-fire on a
 * level the feed has already breached.
 *
 * Body
 *   { apiKey, walletId?, action: "create"|"list"|"cancel"|"pause"|"resume",
 *     // create: feedId, op(">="|"<="|">"|"<"), threshold(number), chain, token,
 *     //         recipient, amount, mode?("once"|"repeat"), cooldownSec?, label?
 *     // mutate: triggerId }
 *
 * Sandbox keys rejected (same posture as recurring-by-key).
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord, hasMultichainScope, getSubscription } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet, listAgenticWallets } from "@/app/lib/agentic-wallet";
import type { AgenticWalletRecord } from "@/app/lib/agentic-wallet";
import { AGENTIC_CHAINS, type AgenticChainKey, type AgenticToken } from "@/app/lib/agentic-wallet-sign";
import { redstoneEnabled, redstoneConfig } from "@/app/lib/redstone";
import {
  createTrigger,
  getTrigger,
  listTriggers,
  applyUserTriggerAction,
  projectTrigger,
  TriggerValidationError,
  type TriggerOp,
  type TriggerMode,
} from "@/app/lib/redstone-trigger";

/** A wallet has a usable daily spend cap. Repeat triggers require this (they fire
 *  on every crossing); per-tx alone bounds one fire, not the aggregate. */
function hasPositiveDailyCap(w: { dailyLimitUsd?: number }): boolean {
  return typeof w.dailyLimitUsd === "number" && Number.isFinite(w.dailyLimitUsd) && w.dailyLimitUsd > 0;
}

interface Body {
  apiKey?: string;
  walletId?: string;
  action?: string;
  feedId?: string;
  op?: string;
  threshold?: number;
  chain?: string;
  token?: string;
  recipient?: string;
  amount?: string;
  mode?: string;
  cooldownSec?: number;
  label?: string | null;
  triggerId?: string;
}

const VALID_OPS: TriggerOp[] = [">=", "<=", ">", "<"];

async function resolveWallet(
  owner: string,
  walletId: string | undefined,
): Promise<AgenticWalletRecord | null> {
  if (walletId && walletId.length > 0) {
    return getActiveAgenticWallet(owner, walletId);
  }
  const all = await listAgenticWallets(owner);
  const active = all.find((w) => !w.deletedAt || Date.now() < w.deletedAt);
  return active ?? null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature gate FIRST — nothing is creatable/mutable while the feature is off.
  if (!redstoneEnabled()) {
    return NextResponse.json(
      { error: "REDSTONE_DISABLED", message: "RedStone triggers are not enabled on this deployment." },
      { status: 503 },
    );
  }

  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-redstone-trigger-by-key", 12, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── apiKey auth ────────────────────────────────────────────────────────────
  if (typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 400 });
  }
  if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
    return NextResponse.json(
      { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for RedStone triggers." },
      { status: 401 },
    );
  }
  const rec = await getApiKeyRecord(body.apiKey);
  if (!rec || !rec.active || rec.isSandbox) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  const wallet = await resolveWallet(owner, body.walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  if (wallet.deletedAt && Date.now() >= wallet.deletedAt) {
    return NextResponse.json({ error: "AGENTIC_WALLET_ARCHIVED" }, { status: 410 });
  }
  const walletId = wallet.address.toLowerCase();
  const action = (body.action ?? "").toLowerCase();

  // ── action=list ────────────────────────────────────────────────────────────
  if (action === "list") {
    const triggers = await listTriggers(owner, walletId);
    return NextResponse.json({ walletId, triggers: triggers.map(projectTrigger), count: triggers.length });
  }

  // ── action=cancel | pause | resume ──────────────────────────────────────────
  if (action === "cancel" || action === "pause" || action === "resume") {
    if (typeof body.triggerId !== "string" || body.triggerId.length === 0) {
      return NextResponse.json({ error: "TRIGGER_ID_REQUIRED" }, { status: 400 });
    }
    const sub = await getSubscription(owner);
    if (!hasMultichainScope(sub)) {
      return NextResponse.json(
        { error: "MULTICHAIN_REQUIRED", message: "Managing RedStone triggers requires the paid Multichain subscription." },
        { status: 402 },
      );
    }
    // FAIL-CLOSED on resume: don't re-activate a repeat trigger on a wallet with
    // no daily cap (the watcher would terminal-fail it on the next fire anyway).
    if (action === "resume") {
      const existing = await getTrigger(owner, walletId, body.triggerId);
      if (existing && existing.mode === "repeat" && !hasPositiveDailyCap(wallet)) {
        return NextResponse.json(
          {
            error: "DAILY_CAP_REQUIRED",
            message: "This repeat trigger cannot resume without a daily spend cap (dailyLimitUsd) on the wallet. Set one first.",
          },
          { status: 400 },
        );
      }
    }
    try {
      const next = await applyUserTriggerAction(owner, walletId, body.triggerId, action);
      return NextResponse.json({ walletId, trigger: projectTrigger(next) });
    } catch (e) {
      if (e instanceof TriggerValidationError) {
        const status = e.code === "TRIGGER_NOT_FOUND" ? 404 : e.code === "ALREADY_CANCELLED" ? 409 : 400;
        return NextResponse.json({ error: e.code, message: e.message }, { status });
      }
      throw e;
    }
  }

  // ── action=create ───────────────────────────────────────────────────────────
  if (action === "create") {
    const sub = await getSubscription(owner);
    if (!hasMultichainScope(sub)) {
      return NextResponse.json(
        { error: "MULTICHAIN_REQUIRED", message: "RedStone triggers require the paid Multichain subscription." },
        { status: 402 },
      );
    }

    const chainStr = (body.chain ?? "bnb").toLowerCase();
    if (!(chainStr in AGENTIC_CHAINS)) {
      return NextResponse.json({ error: "INVALID_CHAIN", message: `Unknown chain "${chainStr}".` }, { status: 400 });
    }
    const chain = chainStr as AgenticChainKey;

    const tokenStr = (body.token ?? "USDT").toUpperCase();
    if (tokenStr !== "USDC" && tokenStr !== "USDT" && tokenStr !== "USDG") {
      return NextResponse.json({ error: "INVALID_TOKEN", message: "token must be USDC, USDT, or USDG." }, { status: 400 });
    }
    if (tokenStr === "USDG" && chain !== "robinhood") {
      return NextResponse.json({ error: "INVALID_TOKEN", message: "USDG is only available on Robinhood Chain." }, { status: 400 });
    }
    if (chain === "robinhood" && tokenStr !== "USDG") {
      return NextResponse.json({ error: "INVALID_TOKEN", message: "Robinhood Chain supports USDG only." }, { status: 400 });
    }
    const token = tokenStr as AgenticToken;

    const op = (body.op ?? "") as TriggerOp;
    if (!VALID_OPS.includes(op)) {
      return NextResponse.json({ error: "INVALID_OP", message: `op must be one of ${VALID_OPS.join(", ")}.` }, { status: 400 });
    }
    if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) {
      return NextResponse.json({ error: "INVALID_THRESHOLD", message: "threshold must be a finite number." }, { status: 400 });
    }
    if (typeof body.feedId !== "string" || body.feedId.length === 0) {
      return NextResponse.json({ error: "INVALID_FEED", message: "feedId is required." }, { status: 400 });
    }
    // Feed must be allowlisted for reading, else the trigger would be dead on
    // arrival (the watcher's fail-closed reader would throw every tick).
    const allowed = redstoneConfig().allowedFeeds;
    if (!allowed.includes(body.feedId.toUpperCase())) {
      return NextResponse.json(
        {
          error: "FEED_NOT_ALLOWLISTED",
          message: `feedId "${body.feedId}" is not in this deployment's readable feed set (${allowed.join(", ") || "none"}).`,
          allowedFeeds: allowed,
        },
        { status: 400 },
      );
    }
    if (typeof body.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.recipient)) {
      return NextResponse.json({ error: "INVALID_RECIPIENT", message: "recipient must be a 0x-prefixed 20-byte address." }, { status: 400 });
    }
    if (typeof body.amount !== "string" || !/^\d+(\.\d{1,18})?$/.test(body.amount) || Number(body.amount) <= 0) {
      return NextResponse.json({ error: "INVALID_AMOUNT", message: "amount must be a positive decimal string." }, { status: 400 });
    }
    // Per-tx cap at create time (mirrors recurring — surface the misconfig now,
    // not at fire time).
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

    const mode: TriggerMode = body.mode === "repeat" ? "repeat" : "once";
    const cooldownSec = typeof body.cooldownSec === "number" ? body.cooldownSec : 0;

    // FAIL-CLOSED: a repeat trigger fires on every crossing, so it MUST be
    // bounded by a wallet daily cap (per-tx alone bounds one fire, not the
    // aggregate). A `once` trigger is bounded by its single amount, so exempt.
    if (
      mode === "repeat" &&
      !(typeof wallet.dailyLimitUsd === "number" && Number.isFinite(wallet.dailyLimitUsd) && wallet.dailyLimitUsd > 0)
    ) {
      return NextResponse.json(
        {
          error: "DAILY_CAP_REQUIRED",
          message: "A repeat RedStone trigger requires a daily spend cap (dailyLimitUsd) on the wallet. Set one, or use mode \"once\".",
        },
        { status: 400 },
      );
    }

    try {
      const t = await createTrigger({
        ownerAddr: owner,
        walletId,
        label: body.label ?? null,
        feedId: body.feedId,
        op,
        threshold: body.threshold,
        chain,
        token,
        recipient: body.recipient.toLowerCase(),
        amount: body.amount,
        mode,
        cooldownSec,
      });
      return NextResponse.json({ walletId, trigger: projectTrigger(t) }, { status: 201 });
    } catch (e) {
      if (e instanceof TriggerValidationError) {
        return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
      }
      throw e;
    }
  }

  return NextResponse.json(
    { error: "INVALID_ACTION", message: 'action must be one of: "create", "list", "cancel", "pause", "resume".' },
    { status: 400 },
  );
}
