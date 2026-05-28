/**
 * POST /api/wallet/agentic/recurring-by-key
 *
 * Recurring-rule CRUD authenticated by apiKey alone (Mode C — no
 * private key or signature required from the caller). Mirrors the
 * owner-sig path at `[walletId]/recurring/route.ts` so the MCP can
 * call into the same scheduler the dashboard uses without holding
 * a signing key.
 *
 * Risk posture mirrors POST /api/wallet/agentic/send: a compromised
 * apiKey can drain at most {perTxMaxUsd, dailyLimitUsd} worth per
 * cycle, with the additional throttle that each rule is bounded by
 * the per-wallet cap configured on the dashboard. There's no path
 * here to authorize a one-shot send larger than those caps — the
 * recurring scheduler itself runs the same cap checks every cycle.
 *
 * Body
 *   {
 *     apiKey:      string,
 *     walletId?:   string,           // omit to use owner's default wallet
 *     action:      "create"|"list"|"cancel"|"pause"|"resume",
 *     // action=create:
 *     frequency?:  string,           // FrequencyEnum: "hourly:N"|"daily"|"weekly:{day}"|"monthly:N"|"monthly:last"
 *     chain?:      AgenticChainKey,
 *     token?:      "USDC"|"USDT",
 *     recipient?:  string,           // single recipient address
 *     amount?:     string,           // decimal string, > 0
 *     label?:      string,
 *     cancelWindowHours?: number,    // optional, default 0
 *     // action=cancel|pause|resume:
 *     ruleId?:     string,
 *   }
 *
 * Sandbox keys rejected (same posture as send/info-by-key).
 */

import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord, hasMultichainScope, getSubscription } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet, listAgenticWallets } from "@/app/lib/agentic-wallet";
import type { AgenticWalletRecord } from "@/app/lib/agentic-wallet";
import {
  createRecurringRule,
  listRecurringRules,
  applyUserStatusAction,
  isFrequencyEnum,
  RecurringValidationError,
  type FrequencyEnum,
  type RecurringRule,
} from "@/app/lib/agentic-wallet-recurring";
import { AGENTIC_CHAINS, type AgenticChainKey } from "@/app/lib/agentic-wallet-sign";

interface RecurringByKeyBody {
  apiKey?:            string;
  walletId?:          string;
  action?:            string;
  // create
  frequency?:         string;
  chain?:             string;
  token?:             string;
  recipient?:         string;
  amount?:            string;
  label?:             string | null;
  cancelWindowHours?: number;
  // mutate
  ruleId?:            string;
}

// Project a rule to the public shape MCP / external callers should see.
// Drops internal-only fields (pendingFireAt timer state, fireLock keys)
// but keeps the surface useful for the AI to reason about ("when's the
// next fire", "how many have happened so far", "what's the cap").
function projectRule(rule: RecurringRule) {
  return {
    ruleId:            rule.ruleId,
    walletId:          rule.walletId,
    label:             rule.label ?? null,
    status:            rule.status,
    frequency:         rule.frequency,
    chain:             rule.chain,
    token:             rule.token,
    recipients:        rule.recipients,
    cancelWindowHours: rule.cancelWindowHours,
    createdAt:         rule.createdAt,
    nextRunAt:         rule.nextRunAt,
    firedCount:        rule.firedCount,
    lastFiredAt:       rule.lastFiredAt,
    lastError:         rule.lastError ?? null,
  };
}

async function resolveWallet(
  owner: string,
  walletId: string | undefined,
): Promise<AgenticWalletRecord | null> {
  if (walletId && walletId.length > 0) {
    return getActiveAgenticWallet(owner, walletId);
  }
  // Default: owner's first non-archived wallet. Matches resolveWallet
  // in info-by-key / send.
  const all = await listAgenticWallets(owner);
  const active = all.find((w) => !w.deletedAt || Date.now() < w.deletedAt);
  return active ?? null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-recurring-by-key", 12, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: RecurringByKeyBody;
  try {
    body = (await req.json()) as RecurringByKeyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── apiKey auth ──────────────────────────────────────────────────────────
  if (typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 400 });
  }
  if (body.apiKey.startsWith("q402_test_")) {
    return NextResponse.json(
      { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for recurring rules." },
      { status: 401 },
    );
  }
  const rec = await getApiKeyRecord(body.apiKey);
  if (!rec || !rec.active) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  // ── Wallet resolution ────────────────────────────────────────────────────
  const wallet = await resolveWallet(owner, body.walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  if (wallet.deletedAt && Date.now() >= wallet.deletedAt) {
    return NextResponse.json({ error: "AGENTIC_WALLET_ARCHIVED" }, { status: 410 });
  }
  const walletId = wallet.address.toLowerCase();

  const action = (body.action ?? "").toLowerCase();

  // ── action=list ──────────────────────────────────────────────────────────
  if (action === "list") {
    const rules = await listRecurringRules(owner, walletId);
    return NextResponse.json({
      walletId,
      rules: rules.map(projectRule),
      count: rules.length,
    });
  }

  // ── action=cancel | pause | resume ───────────────────────────────────────
  if (action === "cancel" || action === "pause" || action === "resume") {
    if (typeof body.ruleId !== "string" || body.ruleId.length === 0) {
      return NextResponse.json({ error: "RULE_ID_REQUIRED" }, { status: 400 });
    }
    try {
      const next = await applyUserStatusAction(owner, walletId, body.ruleId, action);
      return NextResponse.json({ walletId, rule: projectRule(next) });
    } catch (e) {
      if (e instanceof RecurringValidationError) {
        const status =
            e.code === "RULE_NOT_FOUND" ? 404
          : e.code === "ALREADY_CANCELLED" ? 409
          : 400;
        return NextResponse.json({ error: e.code, message: e.message }, { status });
      }
      throw e;
    }
  }

  // ── action=create ────────────────────────────────────────────────────────
  if (action === "create") {
    // Subscription gate — multichain rules need the paid scope. BNB-only
    // trial keys may still create rules on bnb (the most common MCP use).
    const sub = await getSubscription(owner);
    const chainStr = (body.chain ?? "bnb").toLowerCase();
    if (!(chainStr in AGENTIC_CHAINS)) {
      return NextResponse.json({ error: "INVALID_CHAIN", message: `Unknown chain "${chainStr}".` }, { status: 400 });
    }
    const chain = chainStr as AgenticChainKey;
    if (chain !== "bnb" && !hasMultichainScope(sub)) {
      return NextResponse.json(
        {
          error: "MULTICHAIN_REQUIRED",
          message: "Recurring rules on non-BNB chains require the paid Multichain subscription.",
        },
        { status: 402 },
      );
    }

    const tokenStr = (body.token ?? "USDT").toUpperCase();
    if (tokenStr !== "USDC" && tokenStr !== "USDT") {
      return NextResponse.json({ error: "INVALID_TOKEN", message: "token must be USDC or USDT." }, { status: 400 });
    }
    const token = tokenStr;

    if (typeof body.frequency !== "string" || !isFrequencyEnum(body.frequency)) {
      return NextResponse.json(
        {
          error: "INVALID_FREQUENCY",
          message:
            'frequency must be one of: "hourly:N" (N=1..23), "daily", ' +
            '"weekly:{mon|tue|wed|thu|fri|sat|sun}", "monthly:N" (N=1..31), "monthly:last".',
        },
        { status: 400 },
      );
    }
    const frequency = body.frequency as FrequencyEnum;

    if (typeof body.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.recipient)) {
      return NextResponse.json({ error: "INVALID_RECIPIENT", message: "recipient must be a 0x-prefixed 20-byte address." }, { status: 400 });
    }
    if (typeof body.amount !== "string" || !/^\d+(\.\d{1,18})?$/.test(body.amount) || Number(body.amount) <= 0) {
      return NextResponse.json({ error: "INVALID_AMOUNT", message: "amount must be a positive decimal string." }, { status: 400 });
    }

    const cancelWindowHours = typeof body.cancelWindowHours === "number" ? body.cancelWindowHours : 0;

    try {
      const rule = await createRecurringRule({
        ownerAddr: owner,
        walletId,
        label: body.label ?? null,
        frequency,
        chain,
        token,
        recipients: [{ to: body.recipient.toLowerCase(), amount: body.amount }],
        cancelWindowHours,
      });
      return NextResponse.json({ walletId, rule: projectRule(rule) }, { status: 201 });
    } catch (e) {
      if (e instanceof RecurringValidationError) {
        return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
      }
      throw e;
    }
  }

  return NextResponse.json(
    {
      error: "INVALID_ACTION",
      message: 'action must be one of: "create", "list", "cancel", "pause", "resume".',
    },
    { status: 400 },
  );
}
