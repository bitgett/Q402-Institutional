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
  advanceAfterMissedBookkeeping,
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
    | "transient-error"
    | "recovered-missed-bookkeeping";
  txHash?: string;
  /** Multi-recipient rules: number of rows that successfully settled. */
  settled?: number;
  /** Multi-recipient rules: number of rows that hit a per-row error. */
  failed?: number;
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
  // Skip the alert phase entirely when the user opted into a zero-second
  // cancel window. The two-phase design (alert tick → fire tick) was
  // built around giving a human time to skip a pending fire; with
  // cancelWindowHours === 0 the user explicitly chose "no advance
  // notice, just fire", and putting an alert tick in front would
  // stretch an hourly:1 cadence into effectively two-hour fires
  // because the next heartbeat is up to 60min later. Honour the
  // user's choice by falling straight through to Phase B.
  if (rule.pendingFireAt === null && rule.cancelWindowHours > 0) {
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

  // 2. Per-tx max — re-checked at fire (per-row, since each recipient
  //    is its own settlement). If ANY recipient row now exceeds the
  //    wallet's per-tx cap, the rule is terminal: the user must raise
  //    the cap (or cancel + recreate) before resuming. Better to
  //    freeze entirely than partial-fire a payroll where one row
  //    silently drops.
  if (wallet.perTxMaxUsd !== undefined && wallet.perTxMaxUsd !== null) {
    for (let i = 0; i < rule.recipients.length; i++) {
      const n = Number(rule.recipients[i].amount);
      if (n > wallet.perTxMaxUsd) {
        await recordRuleCapExceeded(
          rule,
          `recipients[${i}] amount $${n} now exceeds the wallet's per-tx cap $${wallet.perTxMaxUsd}.`,
          nowMs,
        );
        return { ruleKey, walletId: rule.walletId, outcome: "skipped-per-tx-exceeded" };
      }
    }
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
    if (claim.alreadyFired) {
      // Marker proves the on-chain TX landed on a previous tick, but
      // the bookkeeping write (rule state + ZSET advance) didn't. Run
      // ONLY the bookkeeping side now so the rule moves past the
      // stuck slot — no relay, no second on-chain send. Without this,
      // every future heartbeat would also hit the marker and bail,
      // leaving the user with a rule that appears "never to fire".
      await advanceAfterMissedBookkeeping(rule, nowMs);
      return {
        ruleKey,
        walletId: rule.walletId,
        outcome: "recovered-missed-bookkeeping",
        error: claim.reason,
      };
    }
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

  // 5. Sign + submit, sequentially per recipient. Two failure modes:
  //
  //    (a) FIRST recipient fails before any settles → treat as a
  //        rule-level transient error, release the lock, retry next
  //        tick. Nothing has actually moved on chain.
  //    (b) PARTIAL success — N of M recipients settled, then one
  //        failed. We cannot rollback the N already on-chain. Advance
  //        the schedule, record the rows that landed, surface the
  //        failure in lastError so the dashboard shows "K of M fired:
  //        <reason for row K+1>" and the user can decide whether to
  //        manually re-send to the missed recipients (the rule will
  //        not retry the missed rows itself — that's by design, to
  //        avoid surprise double-pays after the user has manually
  //        topped them up).
  //
  //    Lock semantics still apply at the rule level: a successful
  //    fire-slot keeps its lock held until TTL even on partial-success
  //    paths so a retry tick can't re-attempt the rows that ALREADY
  //    settled.
  const settledRows: Array<{ to: string; amount: string; txHash: string }> = [];
  const failedRows: Array<{ to: string; amount: string; reason: string; index: number }> = [];
  let firstFailureBeforeAnySuccess: string | null = null;

  for (let i = 0; i < rule.recipients.length; i++) {
    const row = rule.recipients[i];
    try {
      const pk = decryptPrivateKey(wallet);
      const signed = await signAgenticPayment({
        privateKey: pk as Hex,
        chain: rule.chain,
        token: rule.token,
        to: row.to as Address,
        amount: row.amount,
        facilitator: relayerKey.address as Address,
      });
      const resp = await submitToRelay(internalBaseUrl(), apiKey, signed);
      const respBody = (await resp.json().catch(() => null)) as { txHash?: string; error?: string } | null;
      if (!resp.ok || !respBody || typeof respBody.txHash !== "string") {
        const errMsg = respBody?.error ?? `relay HTTP ${resp.status}`;
        if (settledRows.length === 0) {
          firstFailureBeforeAnySuccess = errMsg;
          break;
        }
        failedRows.push({ to: row.to, amount: row.amount, reason: errMsg, index: i });
        continue;
      }
      settledRows.push({ to: row.to, amount: row.amount, txHash: respBody.txHash });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (settledRows.length === 0) {
        firstFailureBeforeAnySuccess = msg;
        break;
      }
      failedRows.push({ to: row.to, amount: row.amount, reason: msg, index: i });
    }
  }

  // Case (a) — zero recipients settled. Release lock, transient retry.
  if (firstFailureBeforeAnySuccess !== null && settledRows.length === 0) {
    await releaseFireSlot(rule);
    await recordRuleTransientError(rule, firstFailureBeforeAnySuccess, nowMs);
    return {
      ruleKey,
      walletId: rule.walletId,
      outcome: "transient-error",
      error: firstFailureBeforeAnySuccess,
    };
  }

  // 6. At least one settled. Update the rule record + ZSET. If THIS
  //    write fails, the lock we still hold blocks the next tick from
  //    re-firing the same slot — the rule will look stuck-pending in
  //    the dashboard until ops re-runs the cron or until the lock TTL
  //    expires (1h), by which point recordRuleFired has typically
  //    retried via the transient path. Silence over double-spend.
  const settledUsdTotal = settledRows.reduce((acc, r) => acc + Number(r.amount), 0);
  const partialFailureNote =
    failedRows.length > 0
      ? `${settledRows.length}/${rule.recipients.length} fired; failed rows: ${failedRows
          .map((f) => `[${f.index}] ${f.reason}`)
          .join("; ")}`
      : null;
  await recordRuleFired(rule, settledUsdTotal, nowMs, partialFailureNote);

  return {
    ruleKey,
    walletId: rule.walletId,
    outcome: "fired",
    txHash: settledRows[0]?.txHash,
    settled: settledRows.length,
    failed: failedRows.length,
  };
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
