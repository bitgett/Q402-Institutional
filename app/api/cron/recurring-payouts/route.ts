/**
 * GET /api/cron/recurring-payouts
 *
 * Vercel Cron sweep. Drives the alert → fire → reschedule lifecycle
 * for every recurring rule attached to an Agent Wallet.
 *
 * Cron cadence: every 15 minutes (see vercel.json). The cron only
 * touches rules whose `nextActionAt` ZSET score is ≤ now — so even at
 * scale (10k+ rules) the work is bounded by what's actually due.
 *
 * Per-rule lifecycle inside one tick:
 *
 *   pendingFireAt is null   → alert phase. Mark pending; the rule row
 *                             in the dashboard now reads "Pending —
 *                             fires <when>". User has cancelWindow
 *                             hours to skip/cancel. ZSET re-queues at
 *                             the actual fire time.
 *   pendingFireAt is set    → fire phase. Sign + relay through Q402
 *                             facilitator (Mode-C-style, server holds
 *                             the AES-GCM-encrypted PK). Advance
 *                             nextRunAt. Counters++.
 *
 * Daily cap is bypassed by design: the user authorised the recurring
 * amount via intent-bound sig at rule creation time. The rule itself
 * is the spend ceiling. Per-tx max is re-checked at fire time only as
 * a defence against the user lowering it after the rule was created.
 *
 * Failure handling:
 *   - per-tx cap exceeded            → terminal "fired-cap-exceeded"
 *   - wallet archived between ticks  → cascade pause (not transient)
 *   - subscription lapsed (non-BNB)  → terminal "fired-cap-exceeded"
 *                                       (sub the user can fix → restore +
 *                                        re-resume; but the rule should
 *                                        stop hammering the chain
 *                                        meanwhile)
 *   - relay 5xx / RPC down           → transient. Same nextActionAt,
 *                                       cron re-tries next tick.
 *   - sign / encode errors           → transient. (a hot-fix to viem
 *                                       config recovers without surgery.)
 *
 * Auth: shared CRON_SECRET via Authorization header.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Address, Hex } from "viem";

import { requireCronAuth } from "@/app/lib/cron-auth";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
} from "@/app/lib/agentic-wallet";
import {
  signAgenticPayment,
  submitToRelay,
  internalBaseUrl,
} from "@/app/lib/agentic-wallet-sign";
import {
  pullDueRules,
  markRulePending,
  recordRuleFired,
  recordRuleCapExceeded,
  recordRuleTransientError,
  type RecurringRule,
} from "@/app/lib/agentic-wallet-recurring";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Per-tick cap. Each rule = one sign + one relay round-trip ≈ 1–3s. */
const MAX_RULES_PER_TICK = 50;

interface PerRuleOutcome {
  ruleKey: string;
  walletId: string;
  outcome:
    | "alert-sent"
    | "fired"
    | "skipped-wallet-missing"
    | "skipped-wallet-archived"
    | "skipped-subscription-lapsed"
    | "skipped-no-api-key"
    | "skipped-per-tx-exceeded"
    | "transient-error";
  txHash?: string;
  error?: string;
}

async function processOneRule(
  rule: RecurringRule,
  nowMs: number,
): Promise<PerRuleOutcome> {
  const ruleKey = `${rule.ownerAddr}/${rule.walletId}/${rule.ruleId}`;

  // ── Phase A: alert (pendingFireAt was null) ─────────────────────────
  if (rule.pendingFireAt === null) {
    // Confirm the wallet still exists + active. Skip if not (will be
    // cleaned up by archive cascade or hard-delete cascade).
    const wallet = await getActiveAgenticWallet(rule.ownerAddr, rule.walletId);
    if (!wallet) {
      return { ruleKey, walletId: rule.walletId, outcome: "skipped-wallet-missing" };
    }
    await markRulePending(rule, nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "alert-sent" };
  }

  // ── Phase B: fire ────────────────────────────────────────────────────
  const wallet = await getActiveAgenticWallet(rule.ownerAddr, rule.walletId);
  if (!wallet) {
    // Wallet vanished between alert and fire (archived OR hard-deleted
    // mid-window). Cascade should have already paused/deleted; this is
    // a belt-and-suspenders no-op.
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-wallet-archived" };
  }

  // Per-tx max — re-checked at fire because the user may have lowered
  // the cap after rule creation. Terminal state: rule freezes until
  // user fixes it (raise cap OR cancel + recreate).
  const amountUsd = Number(rule.amount);
  if (
    wallet.perTxMaxUsd !== undefined &&
    wallet.perTxMaxUsd !== null &&
    amountUsd > wallet.perTxMaxUsd
  ) {
    await recordRuleCapExceeded(
      rule,
      `Amount $${amountUsd} now exceeds the wallet's per-tx cap $${wallet.perTxMaxUsd}.`,
      nowMs,
    );
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-per-tx-exceeded" };
  }

  // Subscription gate — only relevant for non-BNB chains. If a paid
  // sub lapsed, freeze the rule rather than hammering /relay with a
  // doomed call.
  const sub = await getSubscription(rule.ownerAddr);
  if (rule.chain !== "bnb" && !hasMultichainScope(sub)) {
    await recordRuleCapExceeded(
      rule,
      `Non-BNB recurring requires a paid multichain subscription. Re-subscribe to resume.`,
      nowMs,
    );
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-subscription-lapsed" };
  }

  // Pick the apiKey the same way Mode C send does: BNB → trial OR paid;
  // anything else → paid only.
  const apiKey = rule.chain === "bnb"
    ? (sub?.trialApiKey || sub?.apiKey)
    : sub?.apiKey;
  if (!apiKey) {
    await recordRuleCapExceeded(
      rule,
      `No active apiKey on the subscription. Re-activate and resume to retry.`,
      nowMs,
    );
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-no-api-key" };
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    await recordRuleTransientError(rule, "relayer key not loaded");
    return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: "relay_unavailable" };
  }

  // Sign + submit. Errors here are TRANSIENT — the rule stays pending,
  // cron retries on the next tick. Permanent failures (PK rotation,
  // missing keystore) need ops intervention; the lastError field
  // surfaces them in the dashboard.
  let txHash: string | undefined;
  try {
    const pk = decryptPrivateKey(wallet);
    const signed = await signAgenticPayment({
      privateKey: pk as Hex,
      chain: rule.chain,
      token: rule.token,
      to: rule.recipient as Address,
      amount: rule.amount,
      facilitator: relayerKey.address as Address,
    });
    const resp = await submitToRelay(internalBaseUrl(), apiKey, signed);
    const respBody = (await resp.json().catch(() => null)) as { txHash?: string; error?: string } | null;
    if (!resp.ok || !respBody || typeof respBody.txHash !== "string") {
      const errMsg = respBody?.error ?? `relay HTTP ${resp.status}`;
      await recordRuleTransientError(rule, errMsg);
      return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: errMsg };
    }
    txHash = respBody.txHash;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordRuleTransientError(rule, msg);
    return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: msg };
  }

  await recordRuleFired(rule, amountUsd, nowMs);
  return { ruleKey, walletId: rule.walletId, outcome: "fired", txHash };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const now = Date.now();
  let due: RecurringRule[];
  try {
    due = await pullDueRules(now, MAX_RULES_PER_TICK);
  } catch (e) {
    console.error("[cron/recurring-payouts] pullDueRules failed:", e);
    return NextResponse.json({ error: "pull_failed" }, { status: 502 });
  }

  const outcomes: PerRuleOutcome[] = [];
  for (const rule of due) {
    try {
      const outcome = await processOneRule(rule, now);
      outcomes.push(outcome);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/recurring-payouts] rule ${rule.ruleId} crashed:`, e);
      outcomes.push({
        ruleKey: `${rule.ownerAddr}/${rule.walletId}/${rule.ruleId}`,
        walletId: rule.walletId,
        outcome: "transient-error",
        error: msg,
      });
    }
  }

  return NextResponse.json({
    asOf: new Date(now).toISOString(),
    pulled: due.length,
    outcomes,
  });
}
