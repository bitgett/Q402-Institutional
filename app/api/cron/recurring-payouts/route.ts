/**
 * GET /api/cron/recurring-payouts
 *
 * Vercel Cron sweep. Drives the alert → fire → reschedule lifecycle
 * for every recurring rule attached to an Agent Wallet.
 *
 * Cron cadence: ~hourly via the Render recurring-trigger heartbeat, with a
 * Vercel daily backstop (see vercel.json); the cron-watchdog pages ops if it
 * goes stale. The cron only touches rules whose `nextActionAt` ZSET score is
 * ≤ now — so even at
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
 * Daily cap IS enforced at fire time (security audit FIX 2026-06-07).
 * Previously the cron only re-checked per-tx max, leaving an abuse
 * vector: API-key-only rule creation × no rule-count cap × no daily
 * cap on fire = an attacker with the user's API key could create
 * many small-amount hourly rules and drain the wallet far past the
 * dashboard's daily cap. Fires now reserve against
 * `chargeAgainstDailyLimit` for the rule's total amount; if today's
 * bucket would overflow, the fire is skipped (transient — same
 * nextActionAt is re-attempted next tick when the bucket has space).
 * A non-transient cap exceedance (rule total alone > cap) still
 * terminates the rule the same way per-tx exceedance does.
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

import { NextRequest, NextResponse, after } from "next/server";
import type { Address, Hex } from "viem";

import { requireCronAuth } from "@/app/lib/cron-auth";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import { dispatchRecurringWebhook } from "@/app/lib/recurring-webhook";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
  chargeAgainstDailyLimit,
  refundDailySpend,
  acquireWalletChainLock,
  releaseWalletChainLock,
} from "@/app/lib/agentic-wallet";
import {
  signAgenticPayment,
  submitToRelay,
  internalBaseUrl,
  isRelayConnectPhaseError,
} from "@/app/lib/agentic-wallet-sign";
import { runHooks } from "@/app/lib/hooks";
import {
  pullDueRules,
  markRulePending,
  recordRuleFired,
  markSlotFired,
  recordRuleFireLog,
  recordRuleCapExceeded,
  recordRuleTransientError,
  claimFireSlot,
  getRecurringRule,
  advanceAfterMissedBookkeeping,
  releaseFireSlot,
  removeFromActionZset,
  isStaleSlot,
  skipStaleSlot,
  type RecurringRule,
} from "@/app/lib/agentic-wallet-recurring";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

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
    | "skipped-status-changed"
    | "skipped-fire-lock-held"
    | "skipped-wallet-missing"
    | "skipped-wallet-archived"
    | "skipped-subscription-lapsed"
    | "skipped-no-api-key"
    | "skipped-per-tx-exceeded"
    | "skipped-daily-cap-too-low"
    | "skipped-daily-cap-full"
    | "skipped-hook-denied"
    | "transient-error"
    | "uncertain-after-broadcast"
    | "recovered-missed-bookkeeping";
  txHash?: string;
  /** Multi-recipient rules: number of rows that successfully settled. */
  settled?: number;
  /** Multi-recipient rules: number of rows that hit a per-row error. */
  failed?: number;
  error?: string;
}

/**
 * Dispatch a recurring webhook event for a non-fire outcome (stopped
 * or transient error). Schedules via after() so we don't block the
 * cron response on the customer's endpoint. Best-effort — a dispatch
 * failure is logged but never alters rule state. Mirrors the
 * recurring.fired path's posture so customers get one consistent
 * delivery model across all three event types.
 */
function fireStateWebhook(
  rule: RecurringRule,
  event: "recurring.stopped" | "recurring.error",
  errorMsg: string,
  nowMs: number,
): void {
  after(
    dispatchRecurringWebhook(rule.ownerAddr, {
      event,
      sandbox:    false,
      ruleId:     rule.ruleId,
      walletId:   rule.walletId,
      ownerAddr:  rule.ownerAddr,
      frequency:  rule.frequency,
      chain:      rule.chain,
      token:      rule.token,
      slot:       rule.nextRunAt,
      error:      errorMsg,
      timestamp:  new Date(nowMs).toISOString(),
    }).catch((e) => console.error(`[cron/recurring-payouts] webhook dispatch failed for ${rule.ruleId} (${event}):`, e)),
  );
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
        const errMsg = `recipients[${i}] amount $${n} now exceeds the wallet's per-tx cap $${wallet.perTxMaxUsd}.`;
        await recordRuleCapExceeded(rule, errMsg, nowMs);
        fireStateWebhook(rule, "recurring.stopped", errMsg, nowMs);
        return { ruleKey, walletId: rule.walletId, outcome: "skipped-per-tx-exceeded" };
      }
    }
  }

  // 2a. Q402 Hooks — beforeAuthorize, screened per recipient
  //     (security audit FIX 2026-06-10). Runs BEFORE the daily-cap
  //     reservation (mirrors /send + /batch ordering: beforeAuthorize
  //     fires before any daily charge) so a hook deny never shadow-locks
  //     the daily bucket. Without this loop the unattended cron settled
  //     each recipient straight through submitToRelay and NEVER bound the
  //     wallet owner's opted-in policy hooks: SpendCapPolicy's
  //     allowedRecipients whitelist (HARD deny — "only pay these
  //     counterparties") and allowedWindowsUtc (business-hours-only),
  //     plus the GLOBAL ComplianceGate (OFAC). Rules are creatable with
  //     just an API key (Mode C), so a compromised key could stand up a
  //     rule paying recipients the owner explicitly excluded, at any
  //     hour — all silently honoured by the cron. /api/relay only
  //     backstops OFAC, nothing else.
  //
  //     Semantics on the unattended cron: there is no client to surface
  //     an interactive hold to, so a deny OR a require_approval (e.g. the
  //     SpendCapPolicy soft cap perCallApprovalUsd — a recurring auto-fire
  //     can't be human-approved in-band) TERMINATES the rule the same way
  //     a per-tx / daily-cap exceedance does: recordRuleCapExceeded freezes
  //     the rule (fired-cap-exceeded), removes it from the ZSET, surfaces
  //     the hook's reason in lastError, and fires the recurring.stopped
  //     webhook. The owner must fix the config (widen the allowlist /
  //     window / approve out-of-band) and resume. We screen EVERY
  //     recipient up front and do NOT settle any of them when one is
  //     blocked — a payroll with one excluded counterparty freezes whole
  //     rather than partial-firing the rest. Nothing reserved yet here, so
  //     no refund is needed on this path.
  for (let i = 0; i < rule.recipients.length; i++) {
    const row = rule.recipients[i];
    const auth = await runHooks("beforeAuthorize", {
      lifecycle: "beforeAuthorize",
      owner: rule.ownerAddr,
      walletId: rule.walletId,
      chain: rule.chain,
      token: rule.token,
      recipient: row.to.toLowerCase(),
      amount: row.amount,
      amountUsd: Number(row.amount),
      source: "recurring",
      // Recurring rules carry no per-payment hook params surface; only
      // the wallet's STORED hook config (SpendCapPolicy allowlist/window,
      // ComplianceGate's global OFAC list) applies.
      params: undefined,
    });
    if (auth.outcome.action === "deny" || auth.outcome.action === "require_approval") {
      const { code, reason } = auth.outcome;
      const errMsg =
        `recipients[${i}] (${row.to.toLowerCase()}) blocked by ${code}: ${reason} ` +
        `Update the wallet's spend policy / compliance posture and resume the rule.`;
      await recordRuleCapExceeded(rule, errMsg, nowMs);
      fireStateWebhook(rule, "recurring.stopped", errMsg, nowMs);
      return { ruleKey, walletId: rule.walletId, outcome: "skipped-hook-denied" };
    }
  }

  // 2b. Daily-cap reservation (security audit FIX 2026-06-07).
  //    Compute the rule's total fire amount and reserve it against the
  //    wallet's dailyLimitUsd bucket BEFORE firing. If the rule's total
  //    is itself above the cap, terminate the rule (analog to per-tx
  //    exceedance). If the bucket overflows because of TODAY'S earlier
  //    fires, skip this fire (transient — tomorrow's bucket allows).
  //    Without this, API-key-only rule creation × any rule-count + a
  //    "daily cap bypassed by design" cron is an abuse vector.
  let ruleTotalUsd = 0;
  for (const r of rule.recipients) {
    const n = Number(r.amount);
    if (Number.isFinite(n) && n > 0) ruleTotalUsd += n;
  }
  let dailyReserved = false;
  if (
    ruleTotalUsd > 0 &&
    typeof wallet.dailyLimitUsd === "number" &&
    Number.isFinite(wallet.dailyLimitUsd) &&
    wallet.dailyLimitUsd > 0
  ) {
    // Terminal: rule total alone exceeds cap. Same shape as per-tx
    // exceedance — the user must raise the cap or cancel + recreate.
    if (ruleTotalUsd > wallet.dailyLimitUsd) {
      const errMsg =
        `rule total $${ruleTotalUsd.toFixed(2)} exceeds the wallet's daily cap ` +
        `$${wallet.dailyLimitUsd.toFixed(2)}. Raise the cap (or cancel + recreate the rule).`;
      await recordRuleCapExceeded(rule, errMsg, nowMs);
      fireStateWebhook(rule, "recurring.stopped", errMsg, nowMs);
      return { ruleKey, walletId: rule.walletId, outcome: "skipped-daily-cap-too-low" };
    }
    const reservation = await chargeAgainstDailyLimit(
      rule.ownerAddr,
      rule.walletId,
      ruleTotalUsd,
      wallet.dailyLimitUsd,
    );
    if (!reservation.allowed) {
      // Transient: today's bucket is full. Don't terminate — next tick
      // is rolled back when the cap rolls (00:00 UTC). Reuse the
      // existing transient-error log path so the rule's
      // nextActionAt isn't advanced.
      await recordRuleTransientError(
        rule,
        `daily-cap reservation deferred (bucket full): spent $${reservation.spent}, ` +
          `cap $${reservation.limit}, requested $${reservation.requested}.`,
        nowMs,
      );
      return { ruleKey, walletId: rule.walletId, outcome: "skipped-daily-cap-full" };
    }
    dailyReserved = true;
  }

  // 3. Subscription gate — recurring is a paid feature on every chain,
  //    including BNB. Trial keys may MANUALLY pay via /api/relay, but
  //    scheduled fires consume paid-tier quota / sponsorship and must
  //    therefore use the live (paid) key. Locking it here also closes
  //    a key-scope confusion: a paid user creating a BNB rule should
  //    never see their fires routed through their trial key just
  //    because trialApiKey was still present on the sub.
  // Helper: refund the daily reservation on every path that aborts AFTER
  // we charged but BEFORE the relay confirms. Without this, a paid-sub
  // lapse / fire-lock contention / sign failure would silently lock
  // ruleTotalUsd out of the user's cap for the rest of the day even
  // though no money moved.
  const refundDailyIfReserved = async () => {
    if (dailyReserved) {
      await refundDailySpend(rule.ownerAddr, rule.walletId, ruleTotalUsd).catch(() => {});
    }
  };

  const sub = await getSubscription(rule.ownerAddr);
  if (!hasMultichainScope(sub)) {
    const errMsg = `Recurring requires an active paid Multichain subscription on every chain (including BNB). Re-subscribe and resume to retry.`;
    await refundDailyIfReserved();
    await recordRuleCapExceeded(rule, errMsg, nowMs);
    fireStateWebhook(rule, "recurring.stopped", errMsg, nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "skipped-subscription-lapsed" };
  }

  // Paid key only. We do NOT fall back to trialApiKey even on BNB —
  // that was the pre-audit behaviour and caused paid rules to silently
  // burn trial quota when both keys coexisted on the same owner sub.
  const apiKey = sub?.apiKey;
  if (!apiKey) {
    const errMsg = `No paid apiKey on the subscription. Re-activate the paid plan and resume to retry.`;
    await refundDailyIfReserved();
    await recordRuleCapExceeded(rule, errMsg, nowMs);
    fireStateWebhook(rule, "recurring.stopped", errMsg, nowMs);
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
      //
      // Refund the reservation: the FIRST tick already charged on the
      // way to firing, so charging again here would double-debit the
      // user's daily bucket.
      await refundDailyIfReserved();
      await advanceAfterMissedBookkeeping(rule, nowMs);
      return {
        ruleKey,
        walletId: rule.walletId,
        outcome: "recovered-missed-bookkeeping",
        error: claim.reason,
      };
    }
    // Lock contention with another tick. Refund — the OTHER tick will
    // charge fresh inside its own iteration.
    await refundDailyIfReserved();
    return {
      ruleKey,
      walletId: rule.walletId,
      outcome: "skipped-fire-lock-held",
      error: claim.reason,
    };
  }

  // F2: pullDueRules snapshotted this rule; a cancel/pause could have landed
  // between the pull and now (the ZSET zrem only stops FUTURE pulls). Reload
  // under the fire-lock and refuse to fire anything not still active on this
  // exact slot — otherwise a just-cancelled rule pays AND gets resurrected by
  // the bookkeeping write below.
  const freshRule = await getRecurringRule(rule.ownerAddr, rule.walletId, rule.ruleId);
  if (!freshRule || freshRule.status !== "active" || freshRule.nextRunAt !== rule.nextRunAt) {
    await releaseFireSlot(rule);
    await refundDailyIfReserved();
    return {
      ruleKey,
      walletId: rule.walletId,
      outcome: "skipped-status-changed",
      error: `rule no longer active on this slot (status=${freshRule?.status ?? "deleted"})`,
    };
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    // Release the lock so a quick retry (next tick or manual cron
    // re-run) isn't blocked for the full TTL; the relayer-key
    // recovery is a config fix, not a re-fire race.
    await releaseFireSlot(rule);
    await refundDailyIfReserved();
    await recordRuleTransientError(rule, "relayer key not loaded", nowMs);
    fireStateWebhook(rule, "recurring.error", "relayer key not loaded", nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: "relay_unavailable" };
  }

  // Serialize against concurrent send/batch/yield ops on the SAME wallet+chain
  // so a recurring fire can't collide with a user send on the EIP-7702 auth
  // nonce. On contention treat exactly like a transient relayer-unavailable:
  // release the fire-slot + refund the reservation so the rule retries cleanly
  // next tick (no double-fire — the slot was NOT marked fired). 90s TTL
  // backstop releases the lease if a completion path is ever missed.
  let wcLockToken: string | null = null;
  const releaseWcLock = async () => {
    if (!wcLockToken) return;
    const t = wcLockToken;
    wcLockToken = null;
    await releaseWalletChainLock(rule.walletId, rule.chain, t).catch(() => {});
  };
  wcLockToken = await acquireWalletChainLock(rule.walletId, rule.chain);
  if (!wcLockToken) {
    await releaseFireSlot(rule);
    await refundDailyIfReserved();
    await recordRuleTransientError(rule, "wallet+chain busy (concurrent op in flight)", nowMs);
    return { ruleKey, walletId: rule.walletId, outcome: "transient-error", error: "wallet_busy" };
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
  // Set when the relay fetch threw AFTER it may have broadcast on-chain
  // (ambiguous). Distinct from a clean pre-broadcast failure: it must NOT
  // release the lock / refund / retry, or the next tick double-pays.
  let relayUncertain: string | null = null;

  // Final status re-check immediately before broadcast. The reload above runs
  // right after the fire-lock claim, but the prologue between it and here
  // (relayer-key load, daily reservation, wallet-chain lock) takes long enough
  // for a cancel/pause to land — and the per-slot lease a cancel claims is a
  // no-op once we already hold it. Re-reading here shrinks the "UI says
  // cancelled but a payout still fires" window to sub-millisecond.
  {
    const lastCheck = await getRecurringRule(rule.ownerAddr, rule.walletId, rule.ruleId);
    if (!lastCheck || lastCheck.status !== "active" || lastCheck.nextRunAt !== rule.nextRunAt) {
      await releaseFireSlot(rule);
      await refundDailyIfReserved();
      return {
        ruleKey,
        walletId: rule.walletId,
        outcome: "skipped-status-changed",
        error: `rule cancelled/paused just before broadcast (status=${lastCheck?.status ?? "deleted"})`,
      };
    }
  }

  for (let i = 0; i < rule.recipients.length; i++) {
    const row = rule.recipients[i];
    // Whether the relay fetch for THIS row was dispatched. A throw past that
    // point may have broadcast on-chain (see the catch's uncertain branch).
    let broadcastAttempted = false;
    try {
      // Q402 Hooks — beforeSettle, per recipient (security audit FIX
      // 2026-06-10). Runs after all native gating (per-tx, daily cap,
      // subscription, api key) and BEFORE the signature + relay, mirroring
      // /send. Binds ReputationGate (recipient must meet the wallet's
      // ERC-8004 minScore) and ConditionalOracle on the unattended cron;
      // a deny / require_approval here blocks THIS recipient's settlement.
      // Treated like a per-row relay failure (no money moved for this
      // row): if it's the first row before any settle → rule-level abort
      // (transient retry path below releases the lock + refunds the full
      // reservation); on a partial it's recorded as a failed row and the
      // daily reservation reconciliation refunds the unsettled portion.
      const settleHook = await runHooks("beforeSettle", {
        lifecycle: "beforeSettle",
        owner: rule.ownerAddr,
        walletId: rule.walletId,
        chain: rule.chain,
        token: rule.token,
        recipient: row.to.toLowerCase(),
        amount: row.amount,
        amountUsd: Number(row.amount),
        source: "recurring",
        params: undefined,
      });
      if (
        settleHook.outcome.action === "deny" ||
        settleHook.outcome.action === "require_approval"
      ) {
        const errMsg = `${settleHook.outcome.code}: ${settleHook.outcome.reason}`;
        if (settledRows.length === 0) {
          firstFailureBeforeAnySuccess = errMsg;
          break;
        }
        failedRows.push({ to: row.to, amount: row.amount, reason: errMsg, index: i });
        continue;
      }
      const pk = decryptPrivateKey(wallet);
      const signed = await signAgenticPayment({
        privateKey: pk as Hex,
        expectedOwner: wallet.address as Address,
        chain: rule.chain,
        token: rule.token,
        to: row.to as Address,
        amount: row.amount,
        facilitator: relayerKey.address as Address,
      });
      // Tag this fire as recurring so the dashboard's Transactions →
      // "Recurring only" filter can find it and the per-rule
      // reconciliation joins on ruleId. The CRON_SECRET trust token is
      // what /api/relay checks before honouring the source/ruleId body
      // fields — external customers calling /api/relay directly can't
      // forge the tag without it.
      // Past this line the relay may broadcast on-chain; a throw is ambiguous.
      broadcastAttempted = true;
      const resp = await submitToRelay(internalBaseUrl(), apiKey, signed, {
        source: "recurring",
        ruleId: rule.ruleId,
        internalTrustToken: process.env.CRON_SECRET,
      });
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
        // A throw AFTER the relay fetch was dispatched is AMBIGUOUS — the
        // transfer may have settled on-chain even though we lost the response.
        // Route it to the uncertain handler (keep the lock + mark the slot
        // fired) instead of the transient retry path: re-firing would re-sign
        // with a fresh witness nonce and double-pay. A throw BEFORE the fetch
        // (hook / sign error) is pre-broadcast → safe transient retry.
        // A connect/DNS-phase throw never reached the relay → clean (no
        // broadcast). Only a post-connect throw is ambiguous → uncertain.
        // Without this, a relay DNS/connect blip wrote a fired-marker and the
        // next tick inflated totalFiredCount / totalSpentUsd for a payout that
        // never happened.
        if (broadcastAttempted && !isRelayConnectPhaseError(e)) {
          relayUncertain = msg;
          break;
        }
        firstFailureBeforeAnySuccess = msg;
        break;
      }
      failedRows.push({ to: row.to, amount: row.amount, reason: msg, index: i });
    }
  }

  // Case (uncertain) — the relay fetch threw AFTER it may have broadcast. The
  // transfer might have settled on-chain. KEEP the fire-lock held and write the
  // durable fired-marker so the NEXT tick recovers via claimFireSlot →
  // advanceAfterMissedBookkeeping (advances the schedule, NO re-relay, NO
  // double-pay) instead of re-firing. Do NOT refund the reservation (the funds
  // may have moved). Page ops to verify on-chain. Mirrors
  // /api/wallet/agentic/send's relay_unreachable_uncertain handling.
  if (relayUncertain !== null && settledRows.length === 0) {
    await markSlotFired(rule.ruleId, rule.nextRunAt, "uncertain");
    await recordRuleTransientError(
      rule,
      `relay outcome uncertain (may have settled on-chain): ${relayUncertain}`,
      nowMs,
    );
    void sendOpsAlert(
      `recurring-payouts relay FETCH threw — outcome UNCERTAIN. ` +
        `owner=${rule.ownerAddr} walletId=${rule.walletId} ruleId=${rule.ruleId} ` +
        `slot=${rule.nextRunAt} chain=${rule.chain} token=${rule.token}. Verify on-chain ` +
        `BEFORE any manual re-send — a re-fire re-signs with a fresh witness nonce and ` +
        `double-pays if the relay actually broadcast. The slot is marked fired so the ` +
        `cron will NOT auto re-fire. Error: ${relayUncertain}`,
      "critical",
    );
    fireStateWebhook(rule, "recurring.error", `relay outcome uncertain: ${relayUncertain}`, nowMs);
    await releaseWcLock();
    return {
      ruleKey,
      walletId: rule.walletId,
      outcome: "uncertain-after-broadcast",
      error: relayUncertain,
    };
  }

  // Case (a) — zero recipients settled. Release lock, transient retry.
  if (firstFailureBeforeAnySuccess !== null && settledRows.length === 0) {
    await releaseFireSlot(rule);
    // No money moved on chain; full refund of the reservation.
    await refundDailyIfReserved();
    await recordRuleTransientError(rule, firstFailureBeforeAnySuccess, nowMs);
    fireStateWebhook(rule, "recurring.error", firstFailureBeforeAnySuccess, nowMs);
    await releaseWcLock();
    return {
      ruleKey,
      walletId: rule.walletId,
      outcome: "transient-error",
      error: firstFailureBeforeAnySuccess,
    };
  }

  // 6. At least one settled. Update the rule record + ZSET. If THIS
  //    write fails the next tick will pull the same rule, hit the durable
  //    fired-marker written inside recordRuleFired, and route through
  //    advanceAfterMissedBookkeeping — which advances nextRunAt and
  //    backfills totalFiredCount/totalSpentUsd without re-relaying.
  //    Net effect: a write failure on a settled fire never double-sends
  //    on-chain; worst case is one cycle's bookkeeping arrives a tick
  //    late and the Recent Fires entry for that slot is missing (the
  //    recovery path doesn't write to the fire log).
  const settledUsdTotal = settledRows.reduce((acc, r) => acc + Number(r.amount), 0);
  // Partial-success refund: we reserved ruleTotalUsd against the daily
  // cap but only `settledUsdTotal` actually moved. The diff is owed
  // back to the user's bucket so it isn't shadow-locked until 00:00 UTC.
  if (dailyReserved) {
    const unsettledUsd = Math.max(0, ruleTotalUsd - settledUsdTotal);
    if (unsettledUsd > 0) {
      await refundDailySpend(rule.ownerAddr, rule.walletId, unsettledUsd).catch(() => {});
    }
  }
  const partialFailureNote =
    failedRows.length > 0
      ? `${settledRows.length}/${rule.recipients.length} fired; failed rows: ${failedRows
          .map((f) => `[${f.index}] ${f.reason}`)
          .join("; ")}`
      : null;
  // Capture the slot that just settled BEFORE recordRuleFired advances
  // nextRunAt — the fire log entry pins this fire to the schedule slot
  // it was paying for (not to the new slot the rule rolls forward to).
  const firedSlot = rule.nextRunAt;
  await recordRuleFired(rule, settledUsdTotal, nowMs, partialFailureNote);
  // Append to the per-rule fire log. Best-effort: a KV blip here loses
  // ONE log entry but leaves bookkeeping (rule state, ZSET, marker) on
  // chain-of-truth correct. The dashboard's "Recent fires" panel
  // tolerates gaps.
  try {
    await recordRuleFireLog(rule, {
      firedAt: nowMs,
      slot: firedSlot,
      amountUsd: settledUsdTotal,
      txHashes: settledRows.map((r) => r.txHash),
      settledCount: settledRows.length,
      failedCount: failedRows.length,
      partialFailureNote,
    });
  } catch (e) {
    console.error(`[cron/recurring-payouts] fire log write failed for ${rule.ruleId}:`, e);
  }

  // Fire the customer's recurring.fired webhook (best-effort). after()
  // keeps Vercel alive past the cron response so retries 2 + 3 (1s, 3s
  // backoff) actually land — a raw setTimeout chain inside the
  // serverless context can drop later attempts. A delivery failure here
  // never blocks rule advancement or the on-chain settle.
  after(
    dispatchRecurringWebhook(rule.ownerAddr, {
      event:              "recurring.fired",
      sandbox:            false, // recurring is paid-only on every chain
      ruleId:             rule.ruleId,
      walletId:           rule.walletId,
      ownerAddr:          rule.ownerAddr,
      frequency:          rule.frequency,
      chain:              rule.chain,
      token:              rule.token,
      amountUsd:          settledUsdTotal,
      slot:               firedSlot,
      txHashes:           settledRows.map((r) => r.txHash),
      recipientCount:     rule.recipients.length,
      settledCount:       settledRows.length,
      failedCount:        failedRows.length,
      partialFailureNote,
      timestamp:          new Date(nowMs).toISOString(),
    }).catch((e) => console.error(`[cron/recurring-payouts] webhook dispatch failed for ${rule.ruleId}:`, e)),
  );

  await releaseWcLock();
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

  const startedAt = Date.now();
  const now = startedAt;
  let due: RecurringRule[];
  try {
    due = await pullDueRules(now, MAX_RULES_PER_TICK);
  } catch (e) {
    console.error("[cron/recurring-payouts] pullDueRules failed:", e);
    await recordCronStatus(CRON_NAMES.RECURRING_PAYOUTS, {
      lastStatus: "error",
      lastError: `pull_failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    });
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

  // Roll outcomes into a compact summary so the status row stays small
  // and the operator sees the shape of activity at a glance.
  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const durationMs = Date.now() - startedAt;
  await recordCronStatus(CRON_NAMES.RECURRING_PAYOUTS, {
    lastStatus: "success",
    lastResult: { pulled: due.length, summary },
    durationMs,
  });

  return NextResponse.json({
    asOf: new Date(now).toISOString(),
    pulled: due.length,
    outcomes,
  });
}
