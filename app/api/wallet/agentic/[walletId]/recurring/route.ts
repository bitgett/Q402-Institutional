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
  recipientsCanonicalHash,
  RecurringValidationError,
  MIN_CANCEL_WINDOW_HOURS,
  MAX_RECIPIENTS_PAID,
  type FrequencyEnum,
  type RecurringRule,
  type RecurringRecipient,
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
  // Aggregate amount per fire — convenient client-side summary for
  // the rules list ("3 recipients · $75/run"). Avoids re-summing in
  // every UI consumer.
  const amountPerFire = rule.recipients.reduce((acc, r) => acc + Number(r.amount), 0);
  return {
    ruleId:             rule.ruleId,
    walletId:           rule.walletId,
    label:              rule.label,
    frequency:          rule.frequency,
    chain:              rule.chain,
    token:              rule.token,
    recipients:         rule.recipients,
    recipientCount:     rule.recipients.length,
    amountPerFire:      amountPerFire.toString(),
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
  /** Multi-recipient payout list (1 — 20 rows). Per-row amount so a
   *  payroll rule can carry different amounts under one schedule. */
  recipients?: Array<{ to?: string; amount?: string }>;
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
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return NextResponse.json({ error: "RECIPIENTS_REQUIRED" }, { status: 400 });
  }
  if (body.recipients.length > MAX_RECIPIENTS_PAID) {
    return NextResponse.json(
      { error: "TOO_MANY_RECIPIENTS", message: `Max ${MAX_RECIPIENTS_PAID} recipients per rule.` },
      { status: 400 },
    );
  }
  const recipients: RecurringRecipient[] = [];
  for (let i = 0; i < body.recipients.length; i++) {
    const row = body.recipients[i];
    if (!row || !isHexAddress(row.to) || typeof row.amount !== "string" || row.amount.length === 0) {
      return NextResponse.json(
        { error: "INVALID_RECIPIENT_ROW", message: `recipients[${i}] must be { to: 0x..., amount: "decimal" }.` },
        { status: 400 },
      );
    }
    recipients.push({ to: row.to.toLowerCase(), amount: row.amount });
  }
  const cancelWindowHours = body.cancelWindowHours ?? MIN_CANCEL_WINDOW_HOURS;
  // Fractional values are valid (e.g. 0.5h for hourly:1 cadence — the
  // modal lets the user pick a 30-minute cancel runway via the
  // step={0.5} number input). The library-side `createRecurringRule`
  // also accepts fractional, so this route guard previously rejected
  // a payload the model + the lib were happy with.
  if (!Number.isFinite(cancelWindowHours) || cancelWindowHours < MIN_CANCEL_WINDOW_HOURS) {
    return NextResponse.json({ error: "INVALID_CANCEL_WINDOW" }, { status: 400 });
  }

  const frequency = body.frequency as FrequencyEnum;

  // ── Intent-bound auth — the canonical message embeds the rule's
  //    spend shape (recipients fingerprinted as a single hash so the
  //    intent dictionary stays scalar-typed) so a leaked session sig
  //    can't author a rule with a different recipient set.
  const recipientsHash = recipientsCanonicalHash(recipients);
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
      recipientsHash,
      recipientCount: recipients.length,
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

  // ── Subscription gate. Recurring is a paid feature on EVERY chain,
  //    including BNB — the cron fires with the paid apiKey (see
  //    /api/cron/recurring-payouts step 3) so a BNB rule on a trial-only
  //    sub would terminal-fail at the first fire. Reject at create time
  //    to surface the friendly modal error instead of the cron freezing
  //    the rule weeks later.
  const sub = await getSubscription(owner);
  const isPaid = hasMultichainScope(sub);
  if (!isPaid) {
    return NextResponse.json(
      {
        error: "SUBSCRIPTION_REQUIRED",
        message:
          "Recurring (including BNB) requires the paid Multichain subscription. " +
          "Trial keys can still pay manually from the dashboard. Upgrade your plan to schedule rules.",
      },
      { status: 402 },
    );
  }

  // ── Per-tx cap check at create time (NOT at fire time — see docblock)
  //    Per-row: every recipient's amount must fit under the cap, since
  //    each fire is its own settlement and counted against per-tx max
  //    individually.
  if (wallet.perTxMaxUsd !== undefined && wallet.perTxMaxUsd !== null) {
    for (let i = 0; i < recipients.length; i++) {
      const n = Number(recipients[i].amount);
      if (n > wallet.perTxMaxUsd) {
        return NextResponse.json(
          {
            error: "PER_TX_CAP_EXCEEDED",
            message: `recipients[${i}] amount ($${n}) exceeds this wallet's per-tx cap ($${wallet.perTxMaxUsd}). Raise the cap or lower the amount.`,
            perTxMaxUsd: wallet.perTxMaxUsd,
            index: i,
          },
          { status: 400 },
        );
      }
    }
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
      recipients,
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
