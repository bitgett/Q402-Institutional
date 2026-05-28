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

import type { AgenticChainKey, AgenticToken } from "./agentic-wallet-sign";

export const RECURRING_NEXT_ACTION_ZSET = "aw:recurring:next-action";

/** Minimum cancel window. Anything less wouldn't give the user time to react. */
export const MIN_CANCEL_WINDOW_HOURS = 24;
/** Sanity ceiling; longer than this and the rule effectively never fires on time. */
export const MAX_CANCEL_WINDOW_HOURS = 24 * 14;

/**
 * Backoff applied on a transient cron failure (relay 5xx, RPC down,
 * sign error). The rule's ZSET score is pushed forward by this much so
 * the failing rule doesn't pin the front of the queue and starve every
 * other due rule behind it. Picked at 5 min so a quick recovery still
 * tries within one cron interval (15min) but a chain-wide RPC outage
 * doesn't burn every tick.
 */
export const TRANSIENT_BACKOFF_MS = 5 * 60 * 1000;

/**
 * If the planned fire time has elapsed by MORE than this when the cron
 * finally gets to the rule (cron downtime, paused-then-resumed-late,
 * etc.), the cron does NOT replay the missed fire — it jumps forward
 * to the next future slot. Policy decision: better to under-pay one
 * cycle than double-pay several weeks of catch-up. Currently the
 * threshold is the rule's own `cancelWindowHours`, so a "you got
 * notified 24h in advance" promise is the same threshold for "did
 * this fire actually happen recently enough that you'd still
 * expect it".
 */
function catchUpThresholdMs(rule: { cancelWindowHours: number }): number {
  return rule.cancelWindowHours * 60 * 60 * 1000;
}

/**
 * The longest cancel window that can fit inside one frequency interval.
 * If we let `cancelWindow > frequencyInterval`, the second-and-onward
 * fires would silently honour only `frequencyInterval` hours of notice
 * (the first fire gets the full window because we add it onto `now`,
 * but subsequent slots are spaced at the natural interval and the
 * alert would fire in the past). Validate at create time so the
 * promise on the modal — "you'll have N hours to cancel each fire" —
 * is true for every fire, not just the first.
 */
export function maxCancelWindowForFrequency(f: FrequencyEnum): number {
  if (f === "daily") return 24;
  if (f.startsWith("weekly:")) return 24 * 7;
  // monthly: shortest possible month is February at 28 days. Use that
  // floor so a "monthly:15" rule fired on Jan 15 doesn't see its
  // Feb 15 cancel window collapse.
  return 24 * 28;
}

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

/**
 * A single payout row in a recurring rule. Multi-recipient rules fan
 * out into N of these per slot. Single-recipient rules just have a
 * 1-row array. Per-row amounts are independent so a payroll rule can
 * pay each contractor a different amount on the same schedule.
 */
export interface RecurringRecipient {
  /** Lowercased 0x-prefixed EVM address. */
  to: string;
  /** Human-decimal amount string (e.g. "25.50"). Per-row, so a 5-person
   *  payroll can carry 5 different amounts under one schedule. */
  amount: string;
}

/** Trial-tier subscribers: same cap as batch send. */
export const MAX_RECIPIENTS_TRIAL = 5;
/** Paid Multichain subscribers: same cap as batch send (20). */
export const MAX_RECIPIENTS_PAID = 20;

export interface RecurringRule {
  ruleId: string;
  walletId: string;       // lowercased wallet address
  ownerAddr: string;      // lowercased owner address
  label: string | null;

  frequency: FrequencyEnum;
  chain: AgenticChainKey;
  token: AgenticToken;
  /**
   * Multi-recipient payout list (1 — MAX_RECIPIENTS_PAID rows). Always
   * stored as an array even when there's only one recipient — single-
   * recipient is just `recipients.length === 1`. Pre-v0.6.2 rules
   * stored `recipient: string + amount: string` directly on the rule;
   * `coerceRuleShape()` migrates those into the unified array form on
   * read (best-effort, leaves the record alone if the rule's already
   * in new shape).
   */
  recipients: RecurringRecipient[];

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

/**
 * Legacy single-recipient shape (pre-v0.6.2). Read-only — we never
 * write rules in this shape anymore, but rules created before the
 * multi-recipient migration land in KV with these fields directly
 * on the rule (instead of `recipients: [...]`). `coerceRuleShape()`
 * normalises both shapes into the unified `recipients` array form.
 */
interface LegacyRuleFields {
  recipient?: string;
  amount?: string;
}

/**
 * Normalise a raw KV record into the unified `recipients: [...]`
 * shape. Idempotent — running it twice (or on an already-new record)
 * returns the same object. Used by every read path.
 */
function coerceRuleShape(raw: RecurringRule & LegacyRuleFields): RecurringRule {
  // Already new shape? Skip.
  if (Array.isArray(raw.recipients) && raw.recipients.length > 0) {
    return raw;
  }
  // Legacy single-recipient. Build the 1-row array; preserve everything else.
  if (typeof raw.recipient === "string" && typeof raw.amount === "string") {
    const next: RecurringRule = {
      ...raw,
      recipients: [{ to: raw.recipient, amount: raw.amount }],
    };
    // Strip legacy fields so they don't keep showing up in JSON output.
    delete (next as RecurringRule & LegacyRuleFields).recipient;
    delete (next as RecurringRule & LegacyRuleFields).amount;
    return next;
  }
  // No recipients at all (corrupt rule). Return as-is with empty array
  // so downstream code sees a consistent shape; cron path will skip
  // empty rules.
  return { ...raw, recipients: [] };
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

/**
 * Per-slot fire-lock. Keyed on (ruleId, nextRunAt) so the lock is
 * unique to this specific scheduled fire — a successful fire's lock
 * lingers until expiry, which is exactly what blocks a duplicate
 * cron tick (or a stale retry after a KV write failure) from re-
 * firing the same slot. The next scheduled fire has a different
 * nextRunAt → different lock key → can proceed.
 *
 * TTL is intentionally longer than `maxDuration` of the cron route so
 * even a worst-case "cron timed out mid-relay, retry happens 5 min
 * later" hits the lingering lock and aborts. Set generously since the
 * key auto-expires.
 */
const FIRE_LOCK_TTL_SEC = 60 * 60; // 1h
function fireLockKey(ruleId: string, slotMs: number): string {
  return `aw:recurring:fire-lock:${ruleId}:${slotMs}`;
}

/**
 * Create-idempotency claim. Keyed on the canonical shape of the rule
 * (owner | walletId | freq | chain | token | recipient | amount). If
 * a user retries POST after a network blip, the same body hashes to
 * the same key and the second create returns the cached ruleId.
 *
 * TTL kept tight (10 min) — long enough to absorb a normal client
 * retry, short enough that an intentional "create the same rule
 * shape again on purpose 30 minutes later" still works.
 */
const CREATE_CLAIM_TTL_SEC = 10 * 60;
function createClaimKey(fp: string): string {
  return `aw:recurring:create:${fp}`;
}
/**
 * Stable fingerprint of a rule's spend shape. For multi-recipient
 * rules the recipients list is sorted by (to, amount) before hashing
 * so two clients sending the same logical rule with different array
 * ordering still hash to the same key — `[A, B]` and `[B, A]` are
 * the same recurring obligation.
 */
function createFingerprint(args: {
  ownerAddr: string;
  walletId: string;
  frequency: string;
  chain: string;
  token: string;
  recipients: RecurringRecipient[];
}): string {
  const normRecipients = args.recipients
    .map((r) => `${lower(r.to)}=${r.amount}`)
    .sort();
  const seed = [
    lower(args.ownerAddr),
    lower(args.walletId),
    args.frequency,
    args.chain,
    args.token,
    normRecipients.join(","),
  ].join("|");
  return ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(2, 18);
}

/**
 * Same shape hash as the create-fingerprint, but exposed for the API
 * route's intent-binding canonical message: the user signs a hash of
 * the recipients list so a leaked session sig can't author a rule
 * with a different set of recipients than the modal showed.
 */
export function recipientsCanonicalHash(recipients: RecurringRecipient[]): string {
  const norm = recipients
    .map((r) => `${lower(r.to)}=${r.amount}`)
    .sort()
    .join(",");
  return ethers.keccak256(ethers.toUtf8Bytes(norm)).slice(2, 18);
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
  /** 1 — MAX_RECIPIENTS_PAID rows. Caller validates trial-vs-paid cap. */
  recipients: RecurringRecipient[];
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
  // ── Idempotency claim. SET NX a fingerprint of the canonical rule
  //    shape; if the same body hits us again within the window, return
  //    the rule the first call created instead of authoring a duplicate.
  //    Critical for an "automation engine" — a dropped POST response
  //    shouldn't translate to a second recurring payment getting set up.
  const fp = createFingerprint({
    ownerAddr: input.ownerAddr,
    walletId: input.walletId,
    frequency: input.frequency,
    chain: input.chain,
    token: input.token,
    recipients: input.recipients,
  });
  const claimKey = createClaimKey(fp);
  const claimedRuleId = await kv.set(claimKey, "pending", {
    nx: true,
    ex: CREATE_CLAIM_TTL_SEC,
  });
  if (claimedRuleId === null) {
    // A previous call with this exact shape is in flight or already
    // landed. Resolve the ruleId it produced and return that rule.
    const existing = await kv.get<string>(claimKey);
    if (existing && existing !== "pending") {
      const cached = await getRecurringRule(input.ownerAddr, input.walletId, existing);
      if (cached) return cached;
    }
    throw new RecurringValidationError(
      "DUPLICATE_IN_FLIGHT",
      "An identical recurring rule is being created right now. Retry in a few seconds.",
    );
  }

  // ── Validation ───────────────────────────────────────────────────────
  if (!isFrequencyEnum(input.frequency)) {
    throw new RecurringValidationError("INVALID_FREQUENCY", `Frequency must be one of: daily, weekly:<day>, monthly:<N>, monthly:last (got "${input.frequency}").`);
  }
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new RecurringValidationError("RECIPIENTS_REQUIRED", "At least one recipient row is required.");
  }
  if (input.recipients.length > MAX_RECIPIENTS_PAID) {
    throw new RecurringValidationError(
      "TOO_MANY_RECIPIENTS",
      `A recurring rule can have at most ${MAX_RECIPIENTS_PAID} recipients (got ${input.recipients.length}).`,
    );
  }
  for (let i = 0; i < input.recipients.length; i++) {
    const row = input.recipients[i];
    if (!row || !ADDR_RE.test(row.to)) {
      throw new RecurringValidationError(
        "INVALID_RECIPIENT",
        `recipients[${i}].to must be a 0x-prefixed 20-byte address.`,
      );
    }
    if (!AMOUNT_RE.test(row.amount)) {
      throw new RecurringValidationError(
        "INVALID_AMOUNT",
        `recipients[${i}].amount must be a decimal string (e.g. "25.5").`,
      );
    }
    const n = Number(row.amount);
    if (!Number.isFinite(n) || n <= 0) {
      throw new RecurringValidationError(
        "INVALID_AMOUNT",
        `recipients[${i}].amount must be > 0.`,
      );
    }
  }
  const cancelWindow = input.cancelWindowHours ?? MIN_CANCEL_WINDOW_HOURS;
  if (!Number.isInteger(cancelWindow) || cancelWindow < MIN_CANCEL_WINDOW_HOURS || cancelWindow > MAX_CANCEL_WINDOW_HOURS) {
    throw new RecurringValidationError(
      "INVALID_CANCEL_WINDOW",
      `cancelWindowHours must be an integer between ${MIN_CANCEL_WINDOW_HOURS} and ${MAX_CANCEL_WINDOW_HOURS}.`,
    );
  }
  const maxForFreq = maxCancelWindowForFrequency(input.frequency);
  if (cancelWindow > maxForFreq) {
    throw new RecurringValidationError(
      "CANCEL_WINDOW_EXCEEDS_FREQUENCY",
      `cancelWindowHours (${cancelWindow}h) cannot exceed the frequency interval (${maxForFreq}h for ${input.frequency}). Subsequent fires would silently honour only ${maxForFreq}h of notice, breaking the promise on the modal.`,
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
    recipients: input.recipients.map((r) => ({ to: lower(r.to), amount: r.amount })),
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

  // Persist record first, then list. ZSET last so a partial write
  // never leaves a rule the cron can fire against without a record.
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, ruleId), rule);
  // RPUSH to preserve creation order in the list.
  await kv.rpush(ruleListKey(rule.ownerAddr, rule.walletId), ruleId);
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
    score: computeNextActionAt(rule),
    member: zsetMember(rule.ownerAddr, rule.walletId, ruleId),
  });

  // Stamp the idempotency claim with the resolved ruleId so a retry
  // can resolve to the same rule (the NX claim above was "pending"
  // until this point).
  await kv.set(claimKey, ruleId, { ex: CREATE_CLAIM_TTL_SEC });

  return rule;
}

export async function getRecurringRule(
  ownerAddr: string,
  walletId: string,
  ruleId: string,
): Promise<RecurringRule | null> {
  const raw = await kv.get<RecurringRule & LegacyRuleFields>(ruleKey(ownerAddr, walletId, ruleId));
  if (!raw) return null;
  return coerceRuleShape(raw);
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
      // Resume from any non-active, non-cancelled state:
      //   - "paused" (user-paused)
      //   - "paused-by-archive" (cascaded; user can still resume manually
      //     before the wallet itself is restored — though the cron will
      //     refuse to fire on an archived wallet anyway)
      //   - "fired-cap-exceeded" (user has presumably raised the cap or
      //     re-subscribed; resuming clears the lastError so the next
      //     tick treats it as a fresh active rule)
      if (
        rule.status !== "paused" &&
        rule.status !== "paused-by-archive" &&
        rule.status !== "fired-cap-exceeded"
      ) {
        throw new RecurringValidationError(
          "NOT_RESUMABLE",
          `Cannot resume from status "${rule.status}".`,
        );
      }
      next.status = "active";
      // If nextRunAt is in the past (pause was longer than one cycle, or
      // cap-exceeded sat for a while), roll it forward to the next slot
      // ≥ now + cancelWindow.
      if (next.nextRunAt < now + next.cancelWindowHours * HOUR_MS) {
        next.nextRunAt = computeFirstFireAt(next.frequency, now, next.cancelWindowHours);
      }
      next.pendingFireAt = null;
      next.lastError = null;
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
 * Try to claim the right to fire `rule` for its current slot. Returns
 * `{ ok: true }` if the cron should proceed with sign+relay; returns
 * `{ ok: false, reason }` if a concurrent tick already owns this slot
 * or the slot was already fired and the rule simply hasn't been moved
 * forward yet (KV write race after a successful relay).
 *
 * The lock key includes `rule.nextRunAt` so each scheduled fire has a
 * unique lock. The NEXT scheduled fire gets a different slot → new
 * lock key → can proceed normally.
 *
 * Critical for post-relay idempotency: if a cron tick successfully
 * relays but the follow-up `recordRuleFired` KV write fails, the rule
 * stays in its "pending fire" state. A retry tick pulls the same
 * rule, calls `claimFireSlot`, finds the lock from the first tick
 * still held — aborts. No double-fire on chain.
 */
export async function claimFireSlot(
  rule: RecurringRule,
): Promise<{ ok: boolean; reason?: string }> {
  const claim = await kv.set(fireLockKey(rule.ruleId, rule.nextRunAt), "in-flight", {
    nx: true,
    ex: FIRE_LOCK_TTL_SEC,
  });
  if (claim === null) {
    return { ok: false, reason: "fire-lock held — concurrent tick or post-relay retry" };
  }
  return { ok: true };
}

/**
 * Release the fire-lock manually. Called when fire was aborted BEFORE
 * any relay attempt (e.g. wallet missing, sub lapsed) so a subsequent
 * retry isn't blocked for the lock's full TTL. NOT called after a
 * successful relay — the lock SHOULD persist so a retry-after-KV-fail
 * sees it.
 */
export async function releaseFireSlot(rule: RecurringRule): Promise<void> {
  await kv.del(fireLockKey(rule.ruleId, rule.nextRunAt));
}

/**
 * Finalise a successful fire. Advances nextRunAt to the next slot,
 * clears pendingFireAt, updates counters. Re-queues into ZSET.
 *
 * Catch-up: next slot is computed from `max(now, rule.nextRunAt)`, not
 * from `rule.nextRunAt` alone. If the cron has been down and the rule
 * fired once on resume, we jump ALL THE WAY forward to the next future
 * slot — we don't replay every missed daily/weekly fire. Better to
 * under-pay one cycle than double-pay several weeks.
 *
 * `partialFailureNote`: for multi-recipient rules where some rows
 * settled and some failed, the cron passes a human-readable summary
 * here. It lands in `lastError` so the dashboard surfaces "3/5 fired;
 * failed rows: [3] relay HTTP 502" inline with the rule row. Pass
 * `null` for an all-rows-succeeded fire.
 */
export async function recordRuleFired(
  rule: RecurringRule,
  amountUsd: number,
  nowMs: number,
  partialFailureNote: string | null = null,
): Promise<RecurringRule> {
  const baseline = Math.max(nowMs, rule.nextRunAt);
  const next: RecurringRule = {
    ...rule,
    lastRunAt: nowMs,
    lastError: partialFailureNote,
    pendingFireAt: null,
    totalFiredCount: rule.totalFiredCount + 1,
    totalSpentUsd: rule.totalSpentUsd + amountUsd,
    nextRunAt: computeNextFireAt(rule.frequency, baseline),
  };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
    score: computeNextActionAt(next),
    member: zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId),
  });
  return next;
}

/**
 * Catch-up jump. Called when the cron pulls a rule whose nextRunAt is
 * MORE than `catchUpThresholdMs(rule)` in the past — the planned fire
 * was so long ago that replaying it would surprise the user. Skip the
 * stale fire entirely, advance to the next future slot, clear pending,
 * re-queue into ZSET. No relay, no balance change.
 *
 * If `pendingFireAt` was set, the user got an alert for a fire that
 * never landed. They're un-surprised by the no-show because the rule
 * row already showed "Pending — fires <when>" + the inline skip/cancel
 * controls. The next cron cycle will alert them on the new slot
 * normally.
 */
export async function skipStaleSlot(
  rule: RecurringRule,
  nowMs: number,
): Promise<RecurringRule> {
  const next: RecurringRule = {
    ...rule,
    pendingFireAt: null,
    nextRunAt: computeNextFireAt(rule.frequency, nowMs),
    lastError: "skipped stale slot (cron resumed after the planned fire time)",
  };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, {
    score: computeNextActionAt(next),
    member: zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId),
  });
  return next;
}

/** Tell the cron whether this rule's nextRunAt is too stale to fire. */
export function isStaleSlot(rule: RecurringRule, nowMs: number): boolean {
  if (nowMs <= rule.nextRunAt) return false;
  return nowMs - rule.nextRunAt > catchUpThresholdMs(rule);
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
 * advance `nextRunAt` or change status — the next cron tick will
 * retry — but DOES push the ZSET score forward by
 * `TRANSIENT_BACKOFF_MS` so a chronically-failing rule at the front of
 * the queue doesn't block every other due rule from being pulled this
 * tick. If the failure is just a flap, the rule re-enters the queue
 * 5min later (well within one cron interval) and tries again.
 *
 * pendingFireAt stays set so the user keeps seeing "pending" in the
 * dashboard.
 */
export async function recordRuleTransientError(
  rule: RecurringRule,
  reason: string,
  nowMs: number,
): Promise<void> {
  const next: RecurringRule = { ...rule, lastError: reason };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.ruleId), next);
  // Push the ZSET score forward so failing rules don't pin the front
  // of the queue (queue-starvation guard).
  const member = zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId);
  const backedOff = nowMs + TRANSIENT_BACKOFF_MS;
  await kv.zadd(RECURRING_NEXT_ACTION_ZSET, { score: backedOff, member });
}

/**
 * Remove the rule from the ZSET without changing its record. Used by
 * the cron when it pulls a rule and discovers the wallet is gone or
 * archived — without this cleanup the same stale entry would be pulled
 * (and skipped) every tick forever. The cascade hooks
 * (pause/resume/deleteForHardDelete) own the rule's record state;
 * this just stops the cron from re-considering it.
 */
export async function removeFromActionZset(rule: RecurringRule): Promise<void> {
  await kv.zrem(
    RECURRING_NEXT_ACTION_ZSET,
    zsetMember(rule.ownerAddr, rule.walletId, rule.ruleId),
  );
}
