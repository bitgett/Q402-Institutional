/**
 * /api/wallet/agentic/[walletId]/recurring
 *
 *   GET   — list every rule attached to this walletId (the caller's
 *           own wallet only — owner sig required, scoped by walletId
 *           in the path).
 *   POST  — create a new rule under this wallet. Intent-bound
 *           `agentic.recurring.create` with the rule's spend-shape
 *           fields in the canonical message so a leaked session sig
 *           can't author a rule.
 *
 * Per-tx max is validated at create time, NOT fire time — if the user
 * later lowers the cap, a stale rule firing 30 days from now would
 * silently flip to "fired-cap-exceeded", which is invisible until the
 * recipient asks "where's my payment". Failing at the modal makes the
 * misconfiguration obvious before the rule ever leaves the dashboard.
 *
 * Daily cap is intentionally NOT validated at create time. The rule
 * IS the spend ceiling — the user just signed an intent that says "I
 * authorise this wallet to fire $X every $period". Daily cap is the
 * separate guard for manual sends.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuth, requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { isAgenticChainKey } from "@/app/lib/agentic-wallet-sign";
import {
  createRecurringRule,
  isFrequencyEnum,
  listRecurringRules,
  RecurringValidationError,
  MIN_CANCEL_WINDOW_HOURS,
  type FrequencyEnum,
  type RecurringRule,
} from "@/app/lib/agentic-wallet-recurring";
import type { AgenticChainKey, AgenticToken } from "@/app/lib/agentic-wallet-sign";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ walletId: string }>;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function projectRule(rule: RecurringRule) {
  return {
    ruleId:             rule.ruleId,
    walletId:           rule.walletId,
    label:              rule.label,
    frequency:          rule.frequency,
    chain:              rule.chain,
    token:              rule.token,
    recipient:          rule.recipient,
    amount:             rule.amount,
    cancelWindowHours:  rule.cancelWindowHours,
    nextRunAt:          rule.nextRunAt,
    pendingFireAt:      rule.pendingFireAt,
    lastRunAt:          rule.lastRunAt,
    lastError:          rule.lastError,
    totalFiredCount:    rule.totalFiredCount,
    totalSpentUsd:      rule.totalSpentUsd,
    status:             rule.status,
    createdAt:          rule.createdAt,
    cancelledAt:        rule.cancelledAt ?? null,
  };
}

// ── GET ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-recurring", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { walletId } = await ctx.params;
  if (!isHexAddress(walletId)) {
    return NextResponse.json({ error: "INVALID_WALLET_ID" }, { status: 400 });
  }

  // Session sig auth (matches the rest of the agentic GETs). The owner
  // address derived from the signature must match the wallet's owner;
  // we look up the wallet record and compare.
  const authResult = await requireAuth(
    req.nextUrl.searchParams.get("address"),
    req.nextUrl.searchParams.get("nonce"),
    req.nextUrl.searchParams.get("sig"),
  );
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  const rules = await listRecurringRules(owner, walletId);
  return NextResponse.json({ rules: rules.map(projectRule) });
}

// ── POST ─────────────────────────────────────────────────────────────────

interface CreateBody {
  address?: string;
  nonce?: string;
  signature?: string;
  label?: string | null;
  frequency?: string;
  chain?: string;
  token?: string;
  recipient?: string;
  amount?: string;
  cancelWindowHours?: number;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-recurring", 12, 60))) {
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

  // ── Shape validation up front (so intent message has known-good values)
  if (!isFrequencyEnum(body.frequency)) {
    return NextResponse.json({ error: "INVALID_FREQUENCY" }, { status: 400 });
  }
  if (!isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  if (body.token !== "USDC" && body.token !== "USDT") {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 400 });
  }
  if (!isHexAddress(body.recipient)) {
    return NextResponse.json({ error: "INVALID_RECIPIENT" }, { status: 400 });
  }
  if (typeof body.amount !== "string" || body.amount.length === 0) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  const cancelWindowHours = body.cancelWindowHours ?? MIN_CANCEL_WINDOW_HOURS;
  if (!Number.isInteger(cancelWindowHours) || cancelWindowHours < MIN_CANCEL_WINDOW_HOURS) {
    return NextResponse.json({ error: "INVALID_CANCEL_WINDOW" }, { status: 400 });
  }

  const frequency = body.frequency as FrequencyEnum;

  // ── Intent-bound auth — the canonical message embeds spend shape +
  //    cancel window so a leaked session sig can't author a different rule.
  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.recurring.create",
    intent: {
      walletId: walletId.toLowerCase(),
      frequency,
      chain: body.chain,
      token: body.token,
      recipient: body.recipient.toLowerCase(),
      amount: body.amount,
      cancelWindowHours,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // ── Wallet must exist + be active + match owner
  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  // ── Subscription gate. Non-BNB recurring needs a paid Multichain
  //    subscription — otherwise the cron would catch this at fire time
  //    and freeze the rule. Block at create so the user gets the
  //    friendly error in the modal instead of "your rule mysteriously
  //    stopped firing two weeks later".
  if (body.chain !== "bnb") {
    const sub = await getSubscription(owner);
    if (!hasMultichainScope(sub)) {
      return NextResponse.json(
        {
          error: "SUBSCRIPTION_REQUIRED",
          message:
            "Recurring on " +
            String(body.chain).toUpperCase() +
            " requires the paid Multichain subscription. " +
            "Stay on BNB Chain (free) or upgrade your plan.",
        },
        { status: 402 },
      );
    }
  }

  // ── Per-tx cap check at create time (NOT at fire time — see docblock)
  const amountUsd = Number(body.amount);
  if (
    wallet.perTxMaxUsd !== undefined &&
    wallet.perTxMaxUsd !== null &&
    amountUsd > wallet.perTxMaxUsd
  ) {
    return NextResponse.json(
      {
        error: "PER_TX_CAP_EXCEEDED",
        message: `Rule amount ($${amountUsd}) exceeds this wallet's per-tx cap ($${wallet.perTxMaxUsd}). Raise the cap or lower the amount.`,
        perTxMaxUsd: wallet.perTxMaxUsd,
      },
      { status: 400 },
    );
  }

  // ── Create
  let rule: RecurringRule;
  try {
    rule = await createRecurringRule({
      ownerAddr: owner,
      walletId: walletId.toLowerCase(),
      label: body.label ?? null,
      frequency,
      chain: body.chain as AgenticChainKey,
      token: body.token as AgenticToken,
      recipient: body.recipient,
      amount: body.amount,
      cancelWindowHours,
    });
  } catch (e) {
    if (e instanceof RecurringValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    console.error("[agentic-wallet/recurring] createRecurringRule failed:", e);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }

  return NextResponse.json({ rule: projectRule(rule) });
}
