/**
 * POST /api/wallet/agentic/recurring-by-key
 *
 * Recurring-rule CRUD authenticated by apiKey alone (Mode C — no
 * private key or signature required from the caller). Mirrors the
 * owner-sig path at `[walletId]/recurring/route.ts` so the MCP can
 * call into the same scheduler the dashboard uses without holding
 * a signing key.
 *
 * Risk posture: a compromised apiKey can author rules whose individual
 * fires are bounded by `perTxMaxUsd` on the wallet (the recurring cron
 * fire path enforces per-tx only — see /api/cron/recurring-payouts).
 * The dashboard-configured `dailyLimitUsd` is currently enforced on
 * MANUAL sends through /api/wallet/agentic/send, NOT on recurring
 * fires; an attacker with an apiKey could schedule N rules at
 * `perTxMaxUsd` and burn `N × perTxMaxUsd` per day until the wallet
 * is empty. Treat apiKey leak as a perTxMax-bound (not dailyLimit-
 * bound) credential. Wallet drain remains capped by the Agent
 * Wallet's USDC balance — the relayer never tops up.
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
  getRecurringRule,
  listRuleFires,
  isFrequencyEnum,
  RecurringValidationError,
  type FrequencyEnum,
  type RecurringRule,
  type RuleFire,
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
  // fires
  limit?:             number;
}

// Project a rule to the public shape MCP / external callers should see.
// Drops internal-only fields (pendingFireAt timer state, fireLock keys)
// but keeps the surface useful for the AI to reason about ("when's the
// next fire", "how many have happened so far", "what's the cap").
function projectRule(rule: RecurringRule) {
  const amountPerFire = rule.recipients.reduce((acc, r) => acc + Number(r.amount), 0);
  return {
    ruleId:            rule.ruleId,
    walletId:          rule.walletId,
    label:             rule.label ?? null,
    status:            rule.status,
    frequency:         rule.frequency,
    chain:             rule.chain,
    token:             rule.token,
    recipients:        rule.recipients,
    recipientCount:    rule.recipients.length,
    amountPerFire:     amountPerFire.toString(),
    cancelWindowHours: rule.cancelWindowHours,
    createdAt:         rule.createdAt,
    nextRunAt:         rule.nextRunAt,
    pendingFireAt:     rule.pendingFireAt,
    lastRunAt:         rule.lastRunAt,
    totalFiredCount:   rule.totalFiredCount,
    totalSpentUsd:     rule.totalSpentUsd,
    cancelledAt:       rule.cancelledAt ?? null,
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
  // Reject both modern (`q402_test_`) and legacy (`q402_sandbox_`)
  // sandbox prefixes — the rest of the codebase carries the legacy
  // pattern too, and a leaked sandbox key shouldn't be able to author
  // recurring rules even if it can't actually relay.
  if (body.apiKey.startsWith("q402_test_") || body.apiKey.startsWith("q402_sandbox_")) {
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

  // ── action=fires ─────────────────────────────────────────────────────────
  // Per-rule fire history for the agent to answer "when did rule X last
  // fire / how much went out last week". Reads the LIST written by the
  // recurring cron's recordRuleFireLog hook. Cap is 50 server-side.
  if (action === "fires") {
    if (typeof body.ruleId !== "string" || body.ruleId.length === 0) {
      return NextResponse.json({ error: "RULE_ID_REQUIRED" }, { status: 400 });
    }
    const rule = await getRecurringRule(owner, walletId, body.ruleId);
    if (!rule) {
      return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
    }
    if (rule.ownerAddr !== owner || rule.walletId !== walletId) {
      // Cross-wallet probe — treat as not-found so we don't leak existence.
      return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
    }
    const limitRaw = typeof body.limit === "number" ? body.limit : 50;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(50, Math.floor(limitRaw))
      : 50;
    const fires: RuleFire[] = await listRuleFires(owner, walletId, body.ruleId, limit);
    return NextResponse.json({
      walletId,
      ruleId: body.ruleId,
      rule: projectRule(rule),
      fires,
      count: fires.length,
    });
  }

  // ── action=cancel | pause | resume ───────────────────────────────────────
  //
  // Mutations on Mode C are paid-only. A trial key sharing the same owner
  // sub could otherwise pause / cancel paid-scope rules — the rule object
  // doesn't carry a "scope at creation time" tag yet, so we lock the
  // mutating surface to the same scope that's allowed to author rules.
  // List + fires (read-only) remain open to any active live-tier key.
  if (action === "cancel" || action === "pause" || action === "resume") {
    if (typeof body.ruleId !== "string" || body.ruleId.length === 0) {
      return NextResponse.json({ error: "RULE_ID_REQUIRED" }, { status: 400 });
    }
    const sub = await getSubscription(owner);
    if (!hasMultichainScope(sub)) {
      return NextResponse.json(
        {
          error: "MULTICHAIN_REQUIRED",
          message: "Pausing, resuming, and cancelling recurring rules requires the paid Multichain subscription. The dashboard accepts the same actions via owner-sig auth.",
        },
        { status: 402 },
      );
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
    // Subscription gate — recurring is a paid feature on every chain.
    // BNB rules used to be allowed under a trial sub, but the cron fires
    // them with the paid apiKey (see /api/cron/recurring-payouts step 3)
    // so creating a BNB rule with no paid scope produced a rule that
    // would terminal-fail on the first fire. Reject at create time
    // instead — clearer failure mode for the user / agent.
    const sub = await getSubscription(owner);
    const chainStr = (body.chain ?? "bnb").toLowerCase();
    if (!(chainStr in AGENTIC_CHAINS)) {
      return NextResponse.json({ error: "INVALID_CHAIN", message: `Unknown chain "${chainStr}".` }, { status: 400 });
    }
    const chain = chainStr as AgenticChainKey;
    if (!hasMultichainScope(sub)) {
      return NextResponse.json(
        {
          error: "MULTICHAIN_REQUIRED",
          message: "Recurring rules (including BNB) require the paid Multichain subscription. Trial keys may still pay manually via q402_pay.",
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
      message: 'action must be one of: "create", "list", "fires", "cancel", "pause", "resume".',
    },
    { status: 400 },
  );
}
