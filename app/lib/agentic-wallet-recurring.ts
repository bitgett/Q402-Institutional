/**
 * Recurring payouts for Agent Wallets.
 *
 * Each rule is attached to a specific Agent Wallet (matches the
 * wallet's chain, token, signer, and identity). The cron route polls
 * a single ZSET (`aw:recurring:next-action`) for due rules, advances
 * each through alert → cancel-window → fire → reschedule.
 *
 * Schema
 * ──────
 *   aw:recurring:{owner}:{walletId}:{ruleId}    → RecurringRule
 *   aw:recurring:list:{owner}:{walletId}        → ruleId[]
 *   aw:recurring:next-action                    → ZSET; member="<owner>/<walletId>/<ruleId>"
 *
 * Lifecycle
 * ─────────
 *   nextRunAt        — when the rule SHOULD fire
 *   pendingFireAt    — null until alert fired; then = ms when alert went out
 *   nextActionAt     — when the cron should next look at this rule
 *                     · pendingFireAt is null → nextRunAt − cancelWindow (alert time)
 *                     · pendingFireAt is set  → nextRunAt (fire time)
 *
 * Caps
 * ────
 *   per-tx max  — validated at RULE CREATION (not at fire time, because
 *                 the user might lower the cap later and the rule would
 *                 silently freeze; we want the failure to surface
 *                 at the modal, not 30 days from now)
 *   daily cap   — bypassed for recurring fires; the rule itself is the
 *                 spend ceiling (user explicitly authorised the recurring
 *                 amount at create time via intent-bound signature). Manual
 *                 sends still count against daily cap, recurring fires
 *                 are tracked in a separate `totalSpentUsd` counter on the
 *                 rule for visibility.
 *
 * Cascade
 * ───────
 *   wallet soft-delete   → active rules → "paused-by-archive"
 *   wallet restore       → "paused-by-archive" rules → "active"
 *                          (user-paused rules stay paused)
 *   wallet hard-delete   → all rules cascade-deleted (record + list + ZSET)
 */

import { kv } from "@vercel/kv";
import { ethers } from "ethers";

import type { AgenticChainKey, AgenticToken } from "./agentic-wallet-sign.js";

export const RECURRING_NEXT_ACTION_ZSET = "aw:recurring:next-action";

/** Minimum cancel window. Anything less wouldn't give the user time to react. */
export const MIN_CANCEL_WINDOW_HOURS = 24;
/** Sanity ceiling; longer than this and the rule effectively never fires on time. */
export const MAX_CANCEL_WINDOW_HOURS = 24 * 14;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── Frequency enum + parsing ─────────────────────────────────────────────

export type WeekdayShort = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type FrequencyEnum =
  | "daily"
  | `weekly:${WeekdayShort}`
  | `monthly:${number}` // 1..31; if the month has no Nth day, fires on the last day
  | "monthly:last";

const WEEKDAY_TO_INDEX: Record<WeekdayShort, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Type guard for a FrequencyEnum string. Rejects garbage early at the API layer. */
export function isFrequencyEnum(s: unknown): s is FrequencyEnum {
  if (typeof s !== "string") return false;
  if (s === "daily" || s === "monthly:last") return true;
  if (s.startsWith("weekly:")) {
    const day = s.slice("weekly:".length);
    return day in WEEKDAY_TO_INDEX;
  }
  if (s.startsWith("monthly:")) {
    const n = Number(s.slice("monthly:".length));
    return Number.isInteger(n) && n >= 1 && n <= 31;
  }
  return false;
}

// ── Rule shape ───────────────────────────────────────────────────────────

export type RecurringStatus =
  | "active"
  | "paused"
  | "paused-by-archive"
  | "cancelled"
  | "fired-cap-exceeded";

export interface RecurringRule {
  ruleId: string;
  walletId: string;       // lowercased wallet address
  ownerAddr: string;      // lowercased owner address
  label: string | null;

  frequency: FrequencyEnum;
  chain: AgenticChainKey;
  token: AgenticToken;
  recipient: string;      // lowercased
  amount: string;         // human decimal string

  cancelWindowHours: number;

  nextRunAt: number;
  pendingFireAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  totalFiredCount: number;
  totalSpentUsd: number;

  status: RecurringStatus;

  createdAt: number;
  cancelledAt?: number;
}

// ── Key helpers ──────────────────────────────────────────────────────────

const lower = (s: string) => s.toLowerCase();

function ruleKey(owner: string, walletId: string, ruleId: string): string {
  return `aw:recurring:${lower(owner)}:${lower(walletId)}:${ruleId}`;
}

function ruleListKey(owner: string, walletId: string): string {
  return `aw:recurring:list:${lower(owner)}:${lower(walletId)}`;
}

function zsetMember(owner: string, walletId: string, ruleId: string): string {
  return `${lower(owner)}/${lower(walletId)}/${ruleId}`;
}

export function parseZsetMember(
  member: string,
): { ownerAddr: string; walletId: string; ruleId: string } | null {
  const parts = member.split("/");
  if (parts.length !== 3) return null;
  const [owner, walletId, ruleId] = parts;
  if (!owner || !walletId || !ruleId) return null;
  return { ownerAddr: owner, walletId, ruleId };
}

// ── nextActionAt resolver (single source of truth) ──────────────────────

/**
 * Compute the ms timestamp at which the cron should NEXT look at this
 * rule. A rule's lifecycle has two phases:
 *
 *   1. Alert phase   — cron wakes at `nextRunAt − cancelWindow` and
 *                      sets `pendingFireAt = now`. The rule row now
 *                      shows "Pending — fires at …" to the user, who
 *                      has the cancel-window duration to skip/cancel.
 *   2. Fire phase    — cron wakes at `nextRunAt` (now in the past
 *                      relative to `pendingFireAt + cancelWindow`),
 *                      executes the transfer, resets pendingFireAt,
 *                      advances nextRunAt to the next slot.
 */
export function computeNextActionAt(rule: Pick<RecurringRule, "nextRunAt" | "pendingFireAt" | "cancelWindowHours">): number {
  if (rule.pendingFireAt === null) {
    return rule.nextRunAt - rule.cancelWindowHours * HOUR_MS;
  }
  return rule.nextRunAt;
}

// ── Frequency → next-fire calculator ─────────────────────────────────────

/**
 * Given a frequency and a starting timestamp, return the ms timestamp
 * of the next time the rule should fire. Caller must add the cancel
 * window beforehand if it wants "first fire ≥ now + cancelWindow".
 *
 * Semantics:
 *   - `daily`             → +24h from the slot, anchored to the same time-of-day
 *   - `weekly:fri`        → next Friday (UTC) at the slot's time-of-day
 *   - `monthly:15`        → 15th of next month (UTC) at the slot's time-of-day;
 *                           if the month has no 15th (only Feb might, no it doesn't —
 *                           well, every month has a 15th, but 31 fires last day of
 *                           Feb/Apr/etc.)
 *   - `monthly:last`      → last day of next month at the slot's time-of-day
 *
 * All math is UTC. Daylight-savings is not a concept on UTC-anchored
 * timestamps, so the rule fires at the same UTC hour every cycle even
 * though that may appear at a different local hour for the user.
 */
export function computeNextFireAt(
  frequency: FrequencyEnum,
  fromMs: number,
): number {
  const from = new Date(fromMs);

  if (frequency === "daily") {
    // Next day, same UTC hh:mm:ss. Add 24h, that's it.
    return fromMs + DAY_MS;
  }

  if (frequency.startsWith("weekly:")) {
    const targetDay = WEEKDAY_TO_INDEX[frequency.slice("weekly:".length) as WeekdayShort];
    const fromDay = from.getUTCDay();
    // Days until the target: strictly forward (1..7), so a rule that
    // fired Mon @ 09:00 with target=mon goes to next Mon, not today.
    let daysAhead = (targetDay - fromDay + 7) % 7;
    if (daysAhead === 0) daysAhead = 7;
    return fromMs + daysAhead * DAY_MS;
  }

  if (frequency === "monthly:last") {
    // Last day of the NEXT month from `from`. We pick "next month" by
    // taking from-month + 1 and asking for day-0 of the month AFTER
    // that, which is the last day of the +1 month. UTC throughout.
    const y = from.getUTCFullYear();
    const m = from.getUTCMonth(); // 0..11
    // last day of month (m+1): use Date.UTC(y, m+2, 0) → day=0 rolls back to last day of m+1.
    const lastDayOfNextMonth = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
    return Date.UTC(
      y, m + 1, lastDayOfNextMonth,
      from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(),
    );
  }

  if (frequency.startsWith("monthly:")) {
    const day = Number(frequency.slice("monthly:".length));
    const y = from.getUTCFullYear();
    const m = from.getUTCMonth(); // 0..11
    // Last day of month m+1 (the target month).
    const lastDayOfTargetMonth = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
    const effectiveDay = Math.min(day, lastDayOfTargetMonth);
    return Date.UTC(
      y, m + 1, effectiveDay,
      from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(),
    );
  }

  // Should never happen — caller validates with isFrequencyEnum before.
  throw new Error(`INVALID_FREQUENCY: ${String(frequency)}`);
}

/**
 * First-fire timing: guarantees that at least `cancelWindowHours` exist
 * between rule creation and the first fire, so the user always has the
 * full cancel window after creating a rule.
 *
 * Implementation: compute the next matching slot from `now + cancelWindow`,
 * not from `now`. A weekly:fri rule created Thursday 23:00 UTC therefore
 * lands on the FOLLOWING Friday (10h is < 24h cancel window), not this
 * week's.
 */
export function computeFirstFireAt(
  frequency: FrequencyEnum,
  nowMs: number,
  cancelWindowHours: number,
): number {
  const earliestAllowed = nowMs + cancelWindowHours * HOUR_MS;
  return computeNextFireAt(frequency, earliestAllowed);
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export interface CreateRuleInput {
  ownerAddr: string;
  walletId: string;
  label?: string | null;
  frequency: FrequencyEnum;
  chain: AgenticChainKey;
  token: AgenticToken;
  recipient: string;
  amount: string;
  cancelWindowHours?: number;
}

export class RecurringValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function generateRuleId(): string {
  // 12 random bytes → 24 hex chars, urlsafe-by-default.
  return ethers.hexlify(ethers.randomBytes(12)).slice(2);
}

export async function createRecurringRule(
  input: CreateRuleInput,
): Promise<RecurringRule> {
  // ── Validation ───────────────────────────────────────────────────────
  if (!isFrequencyEnum(input.frequency)) {
    throw new RecurringValidationError("INVALID_FREQUENCY", `Frequency must be one of: daily, weekly:<day>, monthly:<N>, monthly:last (got "${input.frequency}").`);
  }
  if (!ADDR_RE.test(input.recipient)) {
    throw new RecurringValidationError("INVALID_RECIPIENT", "recipient must be a 0x-prefixed 20-byte address.");
  }
  if (!AMOUNT_RE.test(input.amount)) {
    throw new RecurringValidationError("INVALID_AMOUNT", "amount must be a decimal string (e.g. \"25.5\").");
  }
  const amountNum = Number(input.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new RecurringValidationError("INVALID_AMOUNT", "amount must be > 0.");
  }
  const cancelWindow = input.cancelWindowHours ?? MIN_CANCEL_WINDOW_HOURS;
  if (!Number.isInteger(cancelWindow) || cancelWindow < MIN_CANCEL_WINDOW_HOURS || cancelWindow > MAX_CANCEL_WINDOW_HOURS) {
    throw new RecurringValidationError(
      "INVALID_CANCEL_WINDOW",
      `cancelWindowHours must be an integer between ${MIN_CANCEL_WINDOW_HOURS} and ${MAX_CANCEL_WINDOW_HOURS}.`,
    );
  }
  if (typeof input.label === "string" && input.label.length > 64) {
    throw new RecurringValidationError("INVALID_LABEL", "label must be ≤64 chars.");
  }

  const now = Date.now();
  const ruleId = generateRuleId();
  const firstFireAt = computeFirstFireAt(input.frequency, now, cancelWindow);

  const rule: RecurringRule = {
    ruleId,
    walletId: lower(input.walletId),
    ownerAddr: lower(input.ownerAddr),
    label: input.label ?? null,
    frequency: input.frequency,
    chain: input.chain,
    token: input.token,
    recipient: lower(input.recipient),
    amount: input.amount,
    cancelWindowHours: cancelWindow,
    nextRunAt: firstFireAt,
    pendingFireAt: null,
    lastRunAt: null,
    lastError: null,
    totalFiredCount: 0,
    totalSpentUsd: 0,
    status: "active",
    createdAt: now,
  };

  // Persist record first, then list (NX so concurrent retries don't
  // duplicate the ruleId in the list — the ruleId is random anyway so
  // we shouldn't hit this in practice). ZSET last so a partial write
  // never leaves a rule the cron can fire against without a record.
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, ruleId), rule);
  // RPUSH to preserve creation order in the list.
  await kv.rpush(ruleListKey(rule.ownerAddr, rule.walletId), ruleId);
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
    score: computeNextActionAt(rule),
    member: zsetMember(rule.ownerAddr, rule.walletId, ruleId),
  });

  return rule;
}

export async function getRecurringRule(
  ownerAddr: string,
  walletId: string,
  ruleId: string,
): Promise<RecurringRule | null> {
  const rule = await kv.get<RecurringRule>(ruleKey(ownerAddr, walletId, ruleId));
  return rule ?? null;
}

export async function listRecurringRules(
  ownerAddr: string,
  walletId: string,
): Promise<RecurringRule[]> {
  // lrange supports `0, -1` for "all". Falsy → empty list.
  const ids = (await kv.lrange<string>(ruleListKey(ownerAddr, walletId), 0, -1)) ?? [];
  if (ids.length === 0) return [];
  // Sequential gets keep this simple; expected list size is small
  // (single-digit rules per wallet in normal use). If a paid power
  // user accumulates 100+ rules we can switch to mget at that point.
  const rules: RecurringRule[] = [];
  for (const id of ids) {
    const r = await getRecurringRule(ownerAddr, walletId, id);
    if (r) rules.push(r);
  }
  // Sort: active (with pendingFireAt first), then paused families, then cancelled.
  return rules.sort((a, b) => {
    const order: Record<RecurringStatus, number> = {
      active: 0, paused: 1, "paused-by-archive": 2, "fired-cap-exceeded": 3, cancelled: 4,
    };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    if ((a.pendingFireAt !== null) !== (b.pendingFireAt !== null)) {
      return a.pendingFireAt !== null ? -1 : 1;
    }
    return a.nextRunAt - b.nextRunAt;
  });
}

// ── Status transitions ───────────────────────────────────────────────────

export type UserStatusAction = "pause" | "resume" | "skip-next" | "cancel";

export async function applyUserStatusAction(
  ownerAddr: string,
  walletId: string,
  ruleId: string,
  action: UserStatusAction,
): Promise<RecurringRule> {
  const rule = await getRecurringRule(ownerAddr, walletId, ruleId);
  if (!rule) {
    throw new RecurringValidationError("RULE_NOT_FOUND", "No recurring rule with that id under this wallet.");
  }
  if (rule.status === "cancelled") {
    throw new RecurringValidationError("ALREADY_CANCELLED", "This rule is cancelled. Create a new one if you want it back.");
  }

  const now = Date.now();
  const next: RecurringRule = { ...rule };

  switch (action) {
    case "pause": {
      // User-pause works from any non-cancelled state; clears any pending alert.
      next.status = "paused";
      next.pendingFireAt = null;
      break;
    }
    case "resume": {
      // Can only resume from "paused" or "paused-by-archive". For
      // "paused-by-archive", the archive cascade owns the resume; we
      // still let the user resume manually if they want.
      if (rule.status !== "paused" && rule.status !== "paused-by-archive") {
        throw new RecurringValidationError(
          "NOT_PAUSED",
          `Cannot resume from status "${rule.status}".`,
        );
      }
      next.status = "active";
      // If nextRunAt is in the past (pause was longer than one cycle),
      // roll it forward to the next slot ≥ now + cancelWindow.
      if (next.nextRunAt < now + next.cancelWindowHours * HOUR_MS) {
        next.nextRunAt = computeFirstFireAt(next.frequency, now, next.cancelWindowHours);
      }
      next.pendingFireAt = null;
      break;
    }
    case "skip-next": {
      // Skip the next scheduled fire and advance to the slot AFTER it.
      // Clears the pending alert so the user doesn't get hit twice.
      if (rule.status !== "active") {
        throw new RecurringValidationError(
          "NOT_ACTIVE",
          `Cannot skip-next from status "${rule.status}". Resume the rule first.`,
        );
      }
      next.nextRunAt = computeNextFireAt(rule.frequency, rule.nextRunAt);
      next.pendingFireAt = null;
      break;
    }
    case "cancel": {
      next.status = "cancelled";
      next.cancelledAt = now;
      next.pendingFireAt = null;
      break;
    }
  }

  await kv.set(ruleKey(ownerAddr, walletId, ruleId), next);

  // Update ZSET. Cancelled rules are removed entirely; everything
  // else gets a fresh nextActionAt.
  const member = zsetMember(ownerAddr, walletId, ruleId);
  if (next.status === "cancelled" || next.status === "paused" || next.status === "paused-by-archive") {
    await kv.zrem(RECURRING_NEXT_ACTION_ZSET, member);
  } else {
    await kv.zadd(RECURRING_NEXT_ACTION_ZSET, { score: computeNextActionAt(next), member });
  }
  return next;
}

// ── Cascade hooks (called from agentic-wallet softDelete/restore/hardDelete) ──

/**
 * On wallet soft-delete: every active rule transitions to
 * "paused-by-archive". user-paused rules stay paused. cancelled rules
 * stay cancelled. Removes affected rules from the ZSET so the cron
 * stops considering them.
 */
export async function pauseRulesForArchive(
  ownerAddr: string,
  walletId: string,
): Promise<{ pausedCount: number }> {
  const rules = await listRecurringRules(ownerAddr, walletId);
  let pausedCount = 0;
  for (const rule of rules) {
    if (rule.status !== "active") continue;
    const next: RecurringRule = { ...rule, status: "paused-by-archive", pendingFireAt: null };
    await kv.set(ruleKey(ownerAddr, walletId, rule.ruleId), next);
    await kv.zrem(RECURRING_NEXT_ACTION_ZSET, zsetMember(ownerAddr, walletId, rule.ruleId));
    pausedCount++;
  }
  return { pausedCount };
}

/**
 * On wallet restore: every "paused-by-archive" rule goes back to "active"
 * with a fresh nextRunAt ≥ now + cancelWindow. User-paused rules stay
 * paused (the user paused them intentionally).
 */
export async function resumeRulesForRestore(
  ownerAddr: string,
  walletId: string,
): Promise<{ resumedCount: number }> {
  const rules = await listRecurringRules(ownerAddr, walletId);
  const now = Date.now();
  let resumedCount = 0;
  for (const rule of rules) {
    if (rule.status !== "paused-by-archive") continue;
    const next: RecurringRule = {
      ...rule,
      status: "active",
      pendingFireAt: null,
      nextRunAt: computeFirstFireAt(rule.frequency, now, rule.cancelWindowHours),
    };
    await kv.set(ruleKey(ownerAddr, walletId, rule.ruleId), next);
    await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
      score: computeNextActionAt(next),
      member: zsetMember(ownerAddr, walletId, rule.ruleId),
    });
    resumedCount++;
  }
  return { resumedCount };
}

/**
 * On wallet hard-delete: every rule cascade-deleted from KV + ZSET.
 * Called by the GC cron AFTER the on-chain balance check confirms the
 * wallet is empty.
 */
export async function deleteRulesForHardDelete(
  ownerAddr: string,
  walletId: string,
): Promise<{ deletedCount: number }> {
  const ids = (await kv.lrange<string>(ruleListKey(ownerAddr, walletId), 0, -1)) ?? [];
  let deletedCount = 0;
  for (const id of ids) {
    await kv.del(ruleKey(ownerAddr, walletId, id));
    await kv.zrem(RECURRING_NEXT_ACTION_ZSET, zsetMember(ownerAddr, walletId, id));
    deletedCount++;
  }
  await kv.del(ruleListKey(ownerAddr, walletId));
  return { deletedCount };
}

// ── Cron helpers (used by /api/cron/recurring-payouts) ────────────────────

/**
 * Pull every rule whose `nextActionAt` has elapsed. Returns up to
 * `limit` rules ordered by score (earliest first). Caller decides
 * per-rule what to do (send alert vs fire transfer).
 */
export async function pullDueRules(
  nowMs: number,
  limit: number,
): Promise<RecurringRule[]> {
  // ZSET stores score = nextActionAt. zrange with byScore + min/max
  // returns members; we then materialise each into a rule.
  const members = await kv.zrange<string[]>(RECURRING_NEXT_ACTION_ZSET, 0, nowMs, {
    byScore: true,
    offset: 0,
    count: limit,
  });
  if (!Array.isArray(members) || members.length === 0) return [];

  const rules: RecurringRule[] = [];
  for (const member of members) {
    const parsed = parseZsetMember(member);
    if (!parsed) {
      // Stale member from a code-version mismatch; clean it up.
      await kv.zrem(RECURRING_NEXT_ACTION_ZSET, member);
      continue;
    }
    const rule = await getRecurringRule(parsed.ownerAddr, parsed.walletId, parsed.ruleId);
    if (!rule) {
      // Rule was deleted but ZSET wasn't cleaned up. Remove now.
      await kv.zrem(RECURRING_NEXT_ACTION_ZSET, member);
      continue;
    }
    rules.push(rule);
  }
  return rules;
}

/**
 * Mark a rule as pending (alert phase). The cron calls this when the
 * cancel-window starts; the next ZSET wake-up is at the actual fire time.
 */
export async function markRulePending(
  rule: RecurringRule,
  nowMs: number,
): Promise<RecurringRule> {
  const next: RecurringRule = { ...rule, pendingFireAt: nowMs };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
    score: computeNextActionAt(next),
    member: zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId),
  });
  return next;
}

/**
 * Finalise a successful fire. Advances nextRunAt to the next slot,
 * clears pendingFireAt, updates counters. Re-queues into ZSET.
 */
export async function recordRuleFired(
  rule: RecurringRule,
  amountUsd: number,
  nowMs: number,
): Promise<RecurringRule> {
  const next: RecurringRule = {
    ...rule,
    lastRunAt: nowMs,
    lastError: null,
    pendingFireAt: null,
    totalFiredCount: rule.totalFiredCount + 1,
    totalSpentUsd: rule.totalSpentUsd + amountUsd,
    nextRunAt: computeNextFireAt(rule.frequency, rule.nextRunAt),
  };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
    score: computeNextActionAt(next),
    member: zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId),
  });
  return next;
}

/**
 * Record a fire that hit a hard cap (per-tx max changed since rule
 * creation, recipient blacklisted, etc.). Rule transitions to a
 * terminal "fired-cap-exceeded" state and stops auto-firing. User
 * can manually delete + recreate.
 */
export async function recordRuleCapExceeded(
  rule: RecurringRule,
  reason: string,
  nowMs: number,
): Promise<RecurringRule> {
  const next: RecurringRule = {
    ...rule,
    pendingFireAt: null,
    status: "fired-cap-exceeded",
    lastError: reason,
    lastRunAt: nowMs,
  };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  await kv.zrem(RECURRING_NEXT_ACTION_ZSET, zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId));
  return next;
}

/**
 * Record a transient failure (RPC down, relay 502, etc.). Does NOT
 * advance nextRunAt or change status — the next cron tick will retry.
 * pendingFireAt stays set so the user still sees "pending" rather
 * than the rule appearing to fire on schedule from their POV.
 */
export async function recordRuleTransientError(
  rule: RecurringRule,
  reason: string,
): Promise<void> {
  const next: RecurringRule = { ...rule, lastError: reason };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  // Leave ZSET as-is — same nextActionAt, cron will try again.
}
