/**
 * GET /api/cron/redstone-watcher
 *
 * Sweeps every active RedStone data-event trigger, reads its feed, evaluates
 * the edge-latch, and fires a single gasless payout on a rising-edge crossing.
 * The data-event analogue of /api/cron/recurring-payouts — it reuses the exact
 * same sign → relay → durable-marker idempotency spine, only the "is it due?"
 * decision differs (feed crossing instead of a schedule slot).
 *
 * OFF BY DEFAULT. When REDSTONE_ENABLED is unset the route inert-skips (reads
 * nothing, fires nothing, returns disabled:true), so it is safe to expose before
 * the feature is turned on. A Vercel cron (every 15 min) IS scheduled for it;
 * while off it inert-returns but still records a healthy heartbeat, so the
 * watchdog (which now tracks this cron via CRON_NAMES.REDSTONE_WATCHER) never
 * false-pages a cron-scheduled-but-flag-off deployment.
 *
 * ── ENABLE CHECKLIST (do the rest before flipping REDSTONE_ENABLED=1 in prod) ──
 *   1. DONE — Vercel cron (every 15 min) + CRON_NAMES.REDSTONE_WATCHER +
 *      CRON_META + recordCronStatus (success/error/inert) are all wired, so a
 *      wedged money-cron surfaces on the watchdog once enabled.
 *   2. Every wallet that will host a trigger MUST have BOTH perTxMaxUsd AND
 *      dailyLimitUsd set — the daily-cap reserve is the only spend bound beyond
 *      per-tx, and (matching recurring) chargeAgainstDailyLimit fails OPEN if no
 *      positive limit is configured. A trigger fires on an attacker-choosable
 *      feed crossing, so both caps matter.
 *   3. Set REDSTONE_UNIQUE_SIGNERS (>= 3 for multi-signer crypto feeds; RWA/NAV
 *      feeds like ACRED are single-institutional-signer ⇒ 1), REDSTONE_ALLOWED_FEEDS
 *      (absent ⇒ nothing readable), and a REDSTONE_BAND_* per feed. See
 *      docs/redstone-triggers.md.
 *
 * Edge-latch (see redstone-trigger.ts):
 *   feed UNMET      → (re-)arm; never fires.
 *   feed MET, armed → rising edge → fire once, then disarm.
 *   feed MET, !armed→ already fired this crossing (or created while breached) → observe, no fire.
 * A feed READ FAILURE is transient and NEVER fires (fail closed).
 *
 * Auth: shared CRON_SECRET via Authorization header (requireCronAuth).
 */

import { NextRequest, NextResponse } from "next/server";
import type { Address, Hex } from "viem";

import { requireCronAuth } from "@/app/lib/cron-auth";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
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
import { redstoneEnabled, redstonePrice } from "@/app/lib/redstone";
import {
  pullDueTriggers,
  rescheduleCheck,
  claimCrossingFire,
  releaseCrossingFire,
  recordTriggerFired,
  recordTriggerTransientError,
  recordTriggerCapExceeded,
  advanceTriggerAfterMissedBookkeeping,
  markCrossingFired,
  removeFromCheckZset,
  conditionMet,
  inCooldown,
  dailyCapSatisfied,
  hasPositiveDailyCap,
  getTrigger,
  type RedStoneTrigger,
} from "@/app/lib/redstone-trigger";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Per-tick cap. Each fire = one feed read + one sign + one relay round-trip. */
const MAX_TRIGGERS_PER_TICK = 50;

/** Base re-check throttle. 0 (default) = re-evaluate on every tick so the
 *  edge-latch is observed as promptly as the cron cadence allows. A dead feed
 *  is separately backed off via recordTriggerTransientError. */
function checkIntervalSec(): number {
  const raw = Number(process.env.REDSTONE_CHECK_INTERVAL_SEC);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

type Outcome =
  | "armed"
  | "observed-unmet"
  | "met-not-armed"
  | "cooldown"
  | "fired"
  | "feed-unreadable"
  | "skipped-wallet-missing"
  | "skipped-wallet-archived"
  | "skipped-status-changed"
  | "skipped-fire-lock-held"
  | "skipped-subscription-lapsed"
  | "skipped-no-api-key"
  | "skipped-per-tx-exceeded"
  | "skipped-daily-cap-too-low"
  | "skipped-daily-cap-full"
  | "skipped-hook-denied"
  | "transient-error"
  | "uncertain-after-broadcast"
  | "recovered-missed-bookkeeping";

interface PerTriggerOutcome {
  triggerKey: string;
  walletId: string;
  feedId: string;
  value?: number;
  outcome: Outcome;
  txHash?: string;
  error?: string;
}

async function processOneTrigger(
  t: RedStoneTrigger,
  nowMs: number,
): Promise<PerTriggerOutcome> {
  const triggerKey = `${t.ownerAddr}/${t.walletId}/${t.id}`;
  const intervalSec = checkIntervalSec();
  const base = { triggerKey, walletId: t.walletId, feedId: t.feedId };

  // 1. Wallet must still exist + be active.
  const wallet = await getActiveAgenticWallet(t.ownerAddr, t.walletId);
  if (!wallet) {
    await removeFromCheckZset(t);
    return { ...base, outcome: "skipped-wallet-missing" };
  }

  // 2. Read the feed — FAIL CLOSED. Any throw (disabled, not allowlisted, gateway
  //    down, too few signatures, untrusted signer, stale, out of band) is
  //    transient and MUST NOT fire. It only advances lastError + backs off.
  let value: number;
  try {
    const reading = await redstonePrice(t.feedId);
    value = reading.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordTriggerTransientError(t, `feed unreadable: ${msg}`, nowMs);
    return { ...base, outcome: "feed-unreadable", error: msg };
  }

  const met = conditionMet(value, t.op, t.threshold);

  // 3. Edge-latch evaluation.
  if (!met) {
    // Unmet side → (re-)arm and observe. Never fires. Arming here is what makes
    // the NEXT rising edge fire exactly once.
    await rescheduleCheck(t, nowMs, intervalSec, { armed: true, lastValue: value, lastError: null });
    return { ...base, value, outcome: t.armed ? "observed-unmet" : "armed" };
  }
  if (!t.armed) {
    // Met but not armed: we already fired for this crossing, or the trigger was
    // created while the feed was already past the threshold. Observe; a level
    // that stays breached must NOT re-fire. Re-arms only after an unmet tick.
    await rescheduleCheck(t, nowMs, intervalSec, { lastValue: value });
    return { ...base, value, outcome: "met-not-armed" };
  }
  if (t.mode === "repeat" && inCooldown(t, nowMs)) {
    // Genuine new crossing but still inside the post-fire cooldown. Stay armed;
    // the first post-cooldown tick fires.
    await rescheduleCheck(t, nowMs, intervalSec, { lastValue: value });
    return { ...base, value, outcome: "cooldown" };
  }

  // ── met && armed (&& not cooling down) → RISING EDGE → fire path ──

  const amt = Number(t.amount);

  // 3a. Per-tx cap (terminal, mirrors recurring).
  if (wallet.perTxMaxUsd !== undefined && wallet.perTxMaxUsd !== null && amt > wallet.perTxMaxUsd) {
    const reason = `amount $${amt} exceeds the wallet's per-tx cap $${wallet.perTxMaxUsd}.`;
    await recordTriggerCapExceeded(t, reason, nowMs);
    return { ...base, value, outcome: "skipped-per-tx-exceeded", error: reason };
  }

  // 3b. beforeAuthorize hooks (SpendCapPolicy allowlist/window, ComplianceGate
  //     OFAC). On the unattended cron a deny OR require_approval terminates the
  //     trigger (no human to approve in-band) — same posture as recurring.
  //     Nothing reserved yet, so no refund needed on this path.
  const auth = await runHooks("beforeAuthorize", {
    lifecycle: "beforeAuthorize",
    owner: t.ownerAddr,
    walletId: t.walletId,
    chain: t.chain,
    token: t.token,
    recipient: t.recipient,
    amount: t.amount,
    amountUsd: amt,
    source: "redstone-trigger",
    params: undefined,
  });
  if (auth.outcome.action === "deny" || auth.outcome.action === "require_approval") {
    const { code, reason } = auth.outcome;
    const reasonMsg = `recipient (${t.recipient}) blocked by ${code}: ${reason} Update the wallet's spend policy / compliance posture and resume the trigger.`;
    await recordTriggerCapExceeded(t, reasonMsg, nowMs);
    return { ...base, value, outcome: "skipped-hook-denied", error: reasonMsg };
  }

  // 3b.5 FAIL-CLOSED: a REPEAT trigger MUST have a positive wallet daily cap.
  //     chargeAgainstDailyLimit only reserves when dailyLimitUsd > 0, so a repeat
  //     trigger on a cap-less wallet would fire its per-tx-bounded amount on every
  //     crossing with NO aggregate bound (wallet-limits can be deleted to null).
  //     A `once` trigger is inherently bounded by its single fixed amount, so it
  //     is exempt. Terminal — the owner must set a daily cap and resume. Same
  //     predicate the create/resume routes reject on.
  if (!dailyCapSatisfied(t.mode, wallet.dailyLimitUsd)) {
    const reason = `repeat trigger requires a wallet daily spend cap (dailyLimitUsd); none is set. Set one and resume.`;
    await recordTriggerCapExceeded(t, reason, nowMs);
    return { ...base, value, outcome: "skipped-daily-cap-too-low", error: reason };
  }

  // 3c. Daily-cap reservation (same abuse surface as recurring — API-key-only
  //     trigger creation × automated fire must respect the wallet's daily cap).
  let dailyReserved = false;
  if (amt > 0 && hasPositiveDailyCap(wallet.dailyLimitUsd) && wallet.dailyLimitUsd) {
    if (amt > wallet.dailyLimitUsd) {
      const reason = `amount $${amt.toFixed(2)} exceeds the wallet's daily cap $${wallet.dailyLimitUsd.toFixed(2)}. Raise the cap (or cancel + recreate the trigger).`;
      await recordTriggerCapExceeded(t, reason, nowMs);
      return { ...base, value, outcome: "skipped-daily-cap-too-low", error: reason };
    }
    const reservation = await chargeAgainstDailyLimit(t.ownerAddr, t.walletId, amt, wallet.dailyLimitUsd);
    if (!reservation.allowed) {
      // Transient: today's bucket full. Don't disarm — the crossing hasn't fired;
      // recordTriggerTransientError leaves armed/crossingSeq intact and backs off.
      await recordTriggerTransientError(
        t,
        `daily-cap reservation deferred (bucket full): spent $${reservation.spent}, cap $${reservation.limit}, requested $${reservation.requested}.`,
        nowMs,
      );
      return { ...base, value, outcome: "skipped-daily-cap-full" };
    }
    dailyReserved = true;
  }

  const refundIfReserved = async () => {
    if (dailyReserved) {
      await refundDailySpend(t.ownerAddr, t.walletId, amt).catch(() => {});
    }
  };

  // 3d. Subscription gate — automated fires are a paid feature on every chain
  //     (including BNB), same as recurring.
  const sub = await getSubscription(t.ownerAddr);
  if (!hasMultichainScope(sub)) {
    const reason = `RedStone triggers require an active paid Multichain subscription on every chain (including BNB). Re-subscribe and resume.`;
    await refundIfReserved();
    await recordTriggerCapExceeded(t, reason, nowMs);
    return { ...base, value, outcome: "skipped-subscription-lapsed", error: reason };
  }
  const apiKey = sub?.apiKey;
  if (!apiKey) {
    const reason = `No paid apiKey on the subscription. Re-activate the paid plan and resume.`;
    await refundIfReserved();
    await recordTriggerCapExceeded(t, reason, nowMs);
    return { ...base, value, outcome: "skipped-no-api-key", error: reason };
  }

  // 3e. Claim the per-crossing fire-lock BEFORE any relay work. Keyed on
  //     (id, crossingSeq) so each crossing has a unique lock. A concurrent tick
  //     or a retry-after-KV-fail both hit the same key and abort here.
  const claim = await claimCrossingFire(t);
  if (!claim.ok) {
    if (claim.alreadyFired) {
      // Marker proves a previous tick relayed but the bookkeeping write dropped.
      // Advance past the crossing WITHOUT re-relaying. Refund — the first tick
      // already charged on its way to firing.
      await refundIfReserved();
      await advanceTriggerAfterMissedBookkeeping(t, nowMs, intervalSec);
      return { ...base, value, outcome: "recovered-missed-bookkeeping", error: claim.reason };
    }
    await refundIfReserved();
    return { ...base, value, outcome: "skipped-fire-lock-held", error: claim.reason };
  }

  // 3f. Reload under the lock and refuse to fire anything not STILL active and
  //     STILL armed on this exact crossing (a cancel/pause could have landed
  //     between pull and now; the ZSET zrem only stops FUTURE pulls).
  const fresh = await getTrigger(t.ownerAddr, t.walletId, t.id);
  if (!fresh || fresh.status !== "active" || !fresh.armed || fresh.crossingSeq !== t.crossingSeq) {
    await releaseCrossingFire(t);
    await refundIfReserved();
    return {
      ...base,
      value,
      outcome: "skipped-status-changed",
      error: `trigger no longer active/armed on this crossing (status=${fresh?.status ?? "deleted"}, armed=${fresh?.armed})`,
    };
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    await releaseCrossingFire(t);
    await refundIfReserved();
    await recordTriggerTransientError(t, "relayer key not loaded", nowMs);
    return { ...base, value, outcome: "transient-error", error: "relay_unavailable" };
  }

  // 3g. Serialize against concurrent send/batch/yield ops on the same wallet+chain
  //     (EIP-7702 auth-nonce safety). On contention: transient retry.
  let wcLockToken: string | null = await acquireWalletChainLock(t.walletId, t.chain);
  const releaseWcLock = async () => {
    if (!wcLockToken) return;
    const tok = wcLockToken;
    wcLockToken = null;
    await releaseWalletChainLock(t.walletId, t.chain, tok).catch(() => {});
  };
  if (!wcLockToken) {
    await releaseCrossingFire(t);
    await refundIfReserved();
    await recordTriggerTransientError(t, "wallet+chain busy (concurrent op in flight)", nowMs);
    return { ...base, value, outcome: "transient-error", error: "wallet_busy" };
  }

  // 3h. beforeSettle hooks (ReputationGate, ConditionalOracle) — last gate before
  //     signature + relay. A deny/require_approval here is pre-broadcast → clean
  //     transient retry (release lock + refund).
  let broadcastAttempted = false;
  try {
    const settleHook = await runHooks("beforeSettle", {
      lifecycle: "beforeSettle",
      owner: t.ownerAddr,
      walletId: t.walletId,
      chain: t.chain,
      token: t.token,
      recipient: t.recipient,
      amount: t.amount,
      amountUsd: amt,
      source: "redstone-trigger",
      params: undefined,
    });
    if (settleHook.outcome.action === "deny" || settleHook.outcome.action === "require_approval") {
      const reason = `${settleHook.outcome.code}: ${settleHook.outcome.reason}`;
      await releaseCrossingFire(t);
      await refundIfReserved();
      await recordTriggerTransientError(t, reason, nowMs);
      await releaseWcLock();
      return { ...base, value, outcome: "skipped-hook-denied", error: reason };
    }

    const pk = decryptPrivateKey(wallet);
    const signed = await signAgenticPayment({
      privateKey: pk as Hex,
      expectedOwner: wallet.address as Address,
      chain: t.chain,
      token: t.token,
      to: t.recipient as Address,
      amount: t.amount,
      facilitator: relayerKey.address as Address,
    });
    // Past this line the relay may broadcast on-chain; a throw is AMBIGUOUS.
    broadcastAttempted = true;
    const resp = await submitToRelay(internalBaseUrl(), apiKey, signed, {
      source: "redstone-trigger",
      ruleId: t.id,
      internalTrustToken: process.env.CRON_SECRET,
    });
    const body = (await resp.json().catch(() => null)) as { txHash?: string; error?: string } | null;
    if (!resp.ok || !body || typeof body.txHash !== "string") {
      // Clean pre-settlement failure (relay returned an error response, no throw)
      // → transient retry. No money moved.
      const errMsg = body?.error ?? `relay HTTP ${resp.status}`;
      await releaseCrossingFire(t);
      await refundIfReserved();
      await recordTriggerTransientError(t, errMsg, nowMs);
      await releaseWcLock();
      return { ...base, value, outcome: "transient-error", error: errMsg };
    }

    // ── Success ── advance past this crossing (disarm + crossingSeq++), record
    //    the fire. recordTriggerFired writes the durable marker FIRST so a
    //    follow-up KV failure recovers via advanceTriggerAfterMissedBookkeeping.
    await recordTriggerFired(t, amt, nowMs, intervalSec);
    await releaseWcLock();
    return { ...base, value, outcome: "fired", txHash: body.txHash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (broadcastAttempted && !isRelayConnectPhaseError(e)) {
      // Ambiguous: the relay fetch threw AFTER it may have broadcast. KEEP the
      // fire-lock, write the UNCERTAIN marker so the next tick recovers via
      // claimCrossingFire → advanceTriggerAfterMissedBookkeeping (no re-relay,
      // no double-pay). Do NOT refund (funds may have moved). Page ops.
      await markCrossingFired(t.id, t.crossingSeq, "uncertain");
      await recordTriggerTransientError(t, `relay outcome uncertain (may have settled on-chain): ${msg}`, nowMs);
      void sendOpsAlert(
        `redstone-watcher relay FETCH threw — outcome UNCERTAIN. owner=${t.ownerAddr} walletId=${t.walletId} triggerId=${t.id} feed=${t.feedId} crossing=${t.crossingSeq} chain=${t.chain} token=${t.token}. Verify on-chain BEFORE any manual re-send — a re-fire re-signs with a fresh witness nonce and double-pays if the relay actually broadcast. The crossing is marked fired so the cron will NOT auto re-fire. Error: ${msg}`,
        "critical",
      );
      await releaseWcLock();
      return { ...base, value, outcome: "uncertain-after-broadcast", error: msg };
    }
    // Pre-broadcast throw (hook/sign error, or a clean connect-phase failure that
    // never reached the relay) → clean transient retry.
    await releaseCrossingFire(t);
    await refundIfReserved();
    await recordTriggerTransientError(t, msg, nowMs);
    await releaseWcLock();
    return { ...base, value, outcome: "transient-error", error: msg };
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();
  const now = startedAt;

  // Inert-skip when the feature is off — reads nothing, fires nothing. Still
  // record a healthy heartbeat so the watchdog (which now tracks this cron)
  // doesn't false-page a deployment that has the cron scheduled but the feature
  // flag off.
  if (!redstoneEnabled()) {
    await recordCronStatus(CRON_NAMES.REDSTONE_WATCHER, {
      lastStatus: "success",
      lastResult: { disabled: true, pulled: 0 },
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      asOf: new Date(now).toISOString(),
      disabled: true,
      pulled: 0,
      outcomes: [],
    });
  }

  let due: RedStoneTrigger[];
  try {
    due = await pullDueTriggers(now, MAX_TRIGGERS_PER_TICK);
  } catch (e) {
    console.error("[cron/redstone-watcher] pullDueTriggers failed:", e);
    await recordCronStatus(CRON_NAMES.REDSTONE_WATCHER, {
      lastStatus: "error",
      lastError: `pull_failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "pull_failed" }, { status: 502 });
  }

  const outcomes: PerTriggerOutcome[] = [];
  for (const t of due) {
    try {
      outcomes.push(await processOneTrigger(t, now));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/redstone-watcher] trigger ${t.id} crashed:`, e);
      outcomes.push({
        triggerKey: `${t.ownerAddr}/${t.walletId}/${t.id}`,
        walletId: t.walletId,
        feedId: t.feedId,
        outcome: "transient-error",
        error: msg,
      });
    }
  }

  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
    return acc;
  }, {});
  await recordCronStatus(CRON_NAMES.REDSTONE_WATCHER, {
    lastStatus: "success",
    lastResult: { pulled: due.length, summary },
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    asOf: new Date(now).toISOString(),
    pulled: due.length,
    outcomes,
  });
}
