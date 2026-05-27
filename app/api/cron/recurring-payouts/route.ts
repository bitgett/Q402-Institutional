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
  claimFireSlot,
  releaseFireSlot,
  removeFromActionZset,
  isStaleSlot,
  skipStaleSlot,
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
    | "skipped-stale-slot"
    | "skipped-fire-lock-held"
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

  // ── Catch-up gate. If the planned fire is too far in the past, jump
  //    forward instead of replaying. Applies to both phases.
  if (isStaleSlot(rule, nowMs)) {
    await skipStaleSlot(rule, nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-stale-slot" };
  }

  // ── Phase A: alert (pendingFireAt was null) ─────────────────────────
  if (rule.pendingFireAt === null) {
    const wallet = await getActiveAgenticWallet(rule.ownerAddr, rule.walletId);
    if (!wallet) {
      // Wallet hard-deleted but ZSET still has the rule (cascade may
      // have raced or failed). Drop from the queue so the cron stops
      // re-considering this stale entry every tick.
      await removeFromActionZset(rule);
      return { ruleKey, walletId: rule.walletId, outcome: "skipped-wallet-missing" };
    }
    await markRulePending(rule, nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "alert-sent" };
  }

  // ── Phase B: fire ────────────────────────────────────────────────────

  // 1. Wallet must still exist + be active.
  const wallet = await getActiveAgenticWallet(rule.ownerAddr, rule.walletId);
  if (!wallet) {
    // Wallet was archived after the alert. Drop from ZSET; cascade
    // will have set status=paused-by-archive on the rule already (or
    // not, if the cascade itself failed — defensive ZREM here closes
    // the loop either way).
    await removeFromActionZset(rule);
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-wallet-archived" };
  }

  // 2. Per-tx max — re-checked at fire because the user may have
  //    lowered the cap after rule creation. Terminal state: rule
  //    freezes until user fixes it.
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

  // 3. Subscription gate — non-BNB needs multichain. Terminal if
  //    lapsed; user re-subscribes + resumes manually.
  const sub = await getSubscription(rule.ownerAddr);
  if (rule.chain !== "bnb" && !hasMultichainScope(sub)) {
    await recordRuleCapExceeded(
      rule,
      `Non-BNB recurring requires a paid multichain subscription. Re-subscribe to resume.`,
      nowMs,
    );
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-subscription-lapsed" };
  }

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

  // 4. Claim the per-slot fire-lock BEFORE any relay work. Lock key
  //    = (ruleId, nextRunAt) so each scheduled fire has its own
  //    unique slot. Concurrent cron tick / retry-after-KV-fail both
  //    hit the same key and abort here. Lock persists for an hour
  //    after success — long enough to outlive any retry that follows
  //    a recordRuleFired KV write failure.
  const claim = await claimFireSlot(rule);
  if (!claim.ok) {
    return {
      ruleKey,
      walletId: rule.walletId,
      outcome: "skipped-fire-lock-held",
      error: claim.reason,
    };
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    // Release the lock so a quick retry (next tick or manual cron
    // re-run) isn't blocked for the full TTL; the relayer-key
    // recovery is a config fix, not a re-fire race.
    await releaseFireSlot(rule);
    await recordRuleTransientError(rule, "relayer key not loaded", nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: "relay_unavailable" };
  }

  // 5. Sign + submit. Errors before the relay actually settles =
  //    transient (release lock, back off). Errors AFTER the relay
  //    responds with a txHash = success path; we keep the lock so a
  //    failed recordRuleFired write doesn't get re-fired by the next
  //    tick.
  let txHash: string | undefined;
  let releasedLockEarly = false;
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
      // Relay rejected — nothing settled. Release the lock so the
      // next tick can retry the same slot.
      await releaseFireSlot(rule);
      releasedLockEarly = true;
      await recordRuleTransientError(rule, errMsg, nowMs);
      return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: errMsg };
    }
    txHash = respBody.txHash;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!releasedLockEarly) await releaseFireSlot(rule);
    await recordRuleTransientError(rule, msg, nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: msg };
  }

  // 6. Settled. Update the rule record + ZSET. If THIS write fails,
  //    the lock we still hold blocks the next tick from re-firing the
  //    same slot — the rule will look stuck-pending in the dashboard
  //    until ops re-runs the cron or until the lock TTL expires (1h),
  //    by which point recordRuleFired has typically retried via the
  //    transient path. Trade-off favoured: silence over double-spend.
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
