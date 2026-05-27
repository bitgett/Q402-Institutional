/**
 * /api/wallet/agentic/[walletId]/recurring/[ruleId]
 *
 *   PATCH  — pause / resume / skip-next. Intent-bound
 *            `agentic.recurring.update` with the requested action in
 *            the canonical message.
 *   DELETE — permanently cancel the rule. Intent-bound
 *            `agentic.recurring.cancel`.
 *
 * Cancelled rules stay in KV with `status: "cancelled"` for audit; the
 * GC cron does not clean them up automatically. The list view filters
 * them out by default — set `?includeCancelled=1` to see them.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getAgenticWallet } from "@/app/lib/agentic-wallet";
import {
  applyUserStatusAction,
  getRecurringRule,
  RecurringValidationError,
  type UserStatusAction,
  type RecurringRule,
} from "@/app/lib/agentic-wallet-recurring";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ walletId: string; ruleId: string }>;
}

const VALID_PATCH_ACTIONS = new Set<UserStatusAction>(["pause", "resume", "skip-next"]);

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

// ── PATCH (status transitions) ────────────────────────────────────────────

interface PatchBody {
  address?: string;
  nonce?: string;
  signature?: string;
  action?: string;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-recurring-patch", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { walletId, ruleId } = await ctx.params;
  if (!isHexAddress(walletId) || typeof ruleId !== "string" || ruleId.length === 0) {
    return NextResponse.json({ error: "INVALID_PARAMS" }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action as UserStatusAction | undefined;
  if (!action || !VALID_PATCH_ACTIONS.has(action)) {
    return NextResponse.json(
      {
        error: "INVALID_ACTION",
        message: `action must be one of: ${[...VALID_PATCH_ACTIONS].join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.recurring.update",
    intent: {
      walletId: walletId.toLowerCase(),
      ruleId,
      action,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // Confirm the rule exists + owner matches BEFORE applying. The
  // rule's ownerAddr field is the source of truth; the URL param
  // walletId is checked too so a stale path doesn't apply against the
  // wrong wallet.
  const existing = await getRecurringRule(owner, walletId, ruleId);
  if (!existing) {
    return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
  }
  if (existing.ownerAddr !== owner.toLowerCase() || existing.walletId !== walletId.toLowerCase()) {
    // ownership mismatch — treat as not-found so we don't leak existence
    return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
  }

  // Wallet must still exist (could have been archived between PATCH calls).
  const wallet = await getAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  let updated: RecurringRule;
  try {
    updated = await applyUserStatusAction(owner, walletId, ruleId, action);
  } catch (e) {
    if (e instanceof RecurringValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    console.error("[agentic-wallet/recurring/:ruleId] PATCH failed:", e);
    return NextResponse.json({ error: "patch_failed" }, { status: 500 });
  }

  return NextResponse.json({ rule: projectRule(updated) });
}

// ── DELETE (cancel) ──────────────────────────────────────────────────────

interface DeleteBody {
  address?: string;
  nonce?: string;
  signature?: string;
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-recurring-delete", 12, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { walletId, ruleId } = await ctx.params;
  if (!isHexAddress(walletId) || typeof ruleId !== "string" || ruleId.length === 0) {
    return NextResponse.json({ error: "INVALID_PARAMS" }, { status: 400 });
  }

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.recurring.cancel",
    intent: {
      walletId: walletId.toLowerCase(),
      ruleId,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  const existing = await getRecurringRule(owner, walletId, ruleId);
  if (!existing) {
    return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
  }
  if (existing.ownerAddr !== owner.toLowerCase() || existing.walletId !== walletId.toLowerCase()) {
    return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
  }

  let cancelled: RecurringRule;
  try {
    cancelled = await applyUserStatusAction(owner, walletId, ruleId, "cancel");
  } catch (e) {
    if (e instanceof RecurringValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    console.error("[agentic-wallet/recurring/:ruleId] DELETE failed:", e);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ rule: projectRule(cancelled) });
}
