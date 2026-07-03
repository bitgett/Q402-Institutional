/**
 * RedStone data-event triggers for Agent Wallets.
 *
 * A trigger watches ONE RedStone feed (a NAV / price / RWA feed) and fires a
 * single gasless payout the instant the feed CROSSES a threshold — "when the
 * fund NAV drops to X, send the redemption", "when ETH >= 2000, pay the coupon".
 * It is the data-event analogue of a recurring rule: same KV + fire-lock +
 * durable-marker idempotency spine (mirrors `agentic-wallet-recurring.ts`), but
 * the schedule is replaced by an EDGE-LATCH state machine so a level that stays
 * breached fires exactly once, not every tick.
 *
 * Edge-latch (the whole safety story)
 * ───────────────────────────────────
 *   armed=false  ⇒ will NOT fire even if the condition is met right now.
 *   armed=true   ⇒ eligible; the first tick that observes `met` fires, then disarms.
 *
 *   A trigger RE-ARMS only when the feed returns to the UNMET side. So for
 *   "ETH >= 2000": create disarmed while ETH is 1700 → tick observes unmet →
 *   arms → ETH rises through 2000 → fires once → disarms. ETH staying above 2000
 *   does NOT re-fire; it must dip below 2000 and cross up again (repeat mode).
 *
 *   New triggers are created armed=false ON PURPOSE: if the feed is ALREADY past
 *   the threshold at creation, we must not instant-fire — the user armed the
 *   trigger to catch a future crossing, not to pay out on today's spot level.
 *
 *   `crossingSeq` counts fired crossings and keys the per-crossing fire-lock +
 *   durable fired-marker, so a retry after a dropped bookkeeping write recovers
 *   (disarm + advance) without re-sending on-chain — exactly like recurring's
 *   (ruleId, slot) lock.
 *
 * Schema
 * ──────
 *   aw:rstrigger:{owner}:{walletId}:{id}   → RedStoneTrigger
 *   aw:rstrigger:list:{owner}:{walletId}   → id[]
 *   aw:rstrigger:next-check                → ZSET; member="<owner>/<walletId>/<id>", score=nextCheckAt
 *   aw:rstrigger:fire-lock:{id}:{seq}      → per-crossing fire-lock (SET NX, TTL)
 *   aw:rstrigger:fired:{id}:{seq}          → durable per-crossing settled marker
 */

import { kv } from "@vercel/kv";
import { ethers } from "ethers";

import type { AgenticChainKey, AgenticToken } from "./agentic-wallet-sign";

export const RSTRIGGER_NEXT_CHECK_ZSET = "aw:rstrigger:next-check";

/** Max active triggers per (owner, walletId). Bounds KV growth + per-tick work;
 *  well above any real setup (single-digit triggers per wallet in normal use). */
export const MAX_TRIGGERS_PER_WALLET = 50;

/** Backoff on a transient check failure (feed unreadable, relay 5xx) so a dead
 *  feed doesn't pin the front of the scan queue. Mirrors recurring. */
export const TRANSIENT_BACKOFF_MS = 5 * 60 * 1000;

/** How long a fired-once/settled crossing's fire-lock lingers. Longer than the
 *  watcher route's maxDuration so a timed-out-mid-relay retry still hits it. */
const FIRE_LOCK_TTL_SEC = 60 * 60;
/** Durable settled-marker TTL. Long enough to survive a scheduler outage on a
 *  crossing, bounded so KV pressure stays sane. */
const FIRED_MARKER_TTL_SEC = 90 * 24 * 60 * 60;

const HOUR_MS = 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

export type TriggerOp = ">=" | "<=" | ">" | "<";
export type TriggerMode = "once" | "repeat";

export type TriggerStatus =
  | "active"
  | "paused"
  | "paused-by-archive"
  | "cancelled"
  | "fired-once"
  | "fired-cap-exceeded";

export interface RedStoneTrigger {
  id: string;
  walletId: string; // lowercased wallet address
  ownerAddr: string; // lowercased owner address
  label: string | null;

  /** RedStone feed id (must be in REDSTONE_ALLOWED_FEEDS), e.g. "ETH". */
  feedId: string;
  op: TriggerOp;
  /** Value the feed is compared against. */
  threshold: number;

  chain: AgenticChainKey;
  token: AgenticToken;
  /** Single payout recipient (lowercased 0x address). */
  recipient: string;
  /** Human-decimal payout amount string (e.g. "25.5"). */
  amount: string;

  mode: TriggerMode;
  /** repeat mode: minimum seconds between fires even across re-arms. 0 = none. */
  cooldownSec: number;

  // ── Edge-latch state ──
  /** Eligible to fire on the next observed `met`. Created false (see file doc). */
  armed: boolean;
  /** Count of fired crossings — keys the per-crossing fire-lock + marker. */
  crossingSeq: number;

  lastFiredAt: number | null;
  lastCheckedAt: number | null;
  lastValue: number | null;
  lastError: string | null;
  totalFiredCount: number;
  totalSpentUsd: number;

  status: TriggerStatus;

  createdAt: number;
  cancelledAt?: number;
}

/** Public projection for MCP / dashboard responses. Whole shape is safe to
 *  expose (no secrets); kept in one place so both routes stay in sync. */
export function projectTrigger(t: RedStoneTrigger) {
  return {
    id: t.id,
    walletId: t.walletId,
    label: t.label ?? null,
    status: t.status,
    feedId: t.feedId,
    op: t.op,
    threshold: t.threshold,
    chain: t.chain,
    token: t.token,
    recipient: t.recipient,
    amount: t.amount,
    mode: t.mode,
    cooldownSec: t.cooldownSec,
    armed: t.armed,
    crossingSeq: t.crossingSeq,
    lastFiredAt: t.lastFiredAt,
    lastCheckedAt: t.lastCheckedAt,
    lastValue: t.lastValue,
    lastError: t.lastError ?? null,
    totalFiredCount: t.totalFiredCount,
    totalSpentUsd: t.totalSpentUsd,
    createdAt: t.createdAt,
    cancelledAt: t.cancelledAt ?? null,
  };
}

/** True when the feed value satisfies the trigger's comparison. */
export function conditionMet(value: number, op: TriggerOp, threshold: number): boolean {
  switch (op) {
    case ">=":
      return value >= threshold;
    case "<=":
      return value <= threshold;
    case ">":
      return value > threshold;
    case "<":
      return value < threshold;
    default:
      return false;
  }
}

// ── Key helpers ──────────────────────────────────────────────────────────────

const lower = (s: string) => s.toLowerCase();

function triggerKey(owner: string, walletId: string, id: string): string {
  return `aw:rstrigger:${lower(owner)}:${lower(walletId)}:${id}`;
}
function triggerListKey(owner: string, walletId: string): string {
  return `aw:rstrigger:list:${lower(owner)}:${lower(walletId)}`;
}
function zsetMember(owner: string, walletId: string, id: string): string {
  return `${lower(owner)}/${lower(walletId)}/${id}`;
}
function fireLockKey(id: string, seq: number): string {
  return `aw:rstrigger:fire-lock:${id}:${seq}`;
}
function firedMarkerKey(id: string, seq: number): string {
  return `aw:rstrigger:fired:${id}:${seq}`;
}

export function parseZsetMember(
  member: string,
): { ownerAddr: string; walletId: string; id: string } | null {
  const parts = member.split("/");
  if (parts.length !== 3) return null;
  const [owner, walletId, id] = parts;
  if (!owner || !walletId || !id) return null;
  return { ownerAddr: owner, walletId, id };
}

// ── Validation ───────────────────────────────────────────────────────────────

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FEED_RE = /^[A-Za-z0-9._-]{1,32}$/;
const VALID_OPS: TriggerOp[] = [">=", "<=", ">", "<"];

export class TriggerValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function generateTriggerId(): string {
  return ethers.hexlify(ethers.randomBytes(12)).slice(2);
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateTriggerInput {
  ownerAddr: string;
  walletId: string;
  label?: string | null;
  feedId: string;
  op: TriggerOp;
  threshold: number;
  chain: AgenticChainKey;
  token: AgenticToken;
  recipient: string;
  amount: string;
  mode?: TriggerMode;
  cooldownSec?: number;
}

export async function createTrigger(input: CreateTriggerInput): Promise<RedStoneTrigger> {
  // Validate first (mirrors recurring — a typo must not persist anything).
  if (!FEED_RE.test(input.feedId)) {
    throw new TriggerValidationError("INVALID_FEED", "feedId must be 1-32 chars of [A-Za-z0-9._-].");
  }
  if (!VALID_OPS.includes(input.op)) {
    throw new TriggerValidationError("INVALID_OP", `op must be one of ${VALID_OPS.join(", ")}.`);
  }
  if (!Number.isFinite(input.threshold)) {
    throw new TriggerValidationError("INVALID_THRESHOLD", "threshold must be a finite number.");
  }
  if (!ADDR_RE.test(input.recipient)) {
    throw new TriggerValidationError("INVALID_RECIPIENT", "recipient must be a 0x-prefixed 20-byte address.");
  }
  if (!AMOUNT_RE.test(input.amount)) {
    throw new TriggerValidationError("INVALID_AMOUNT", 'amount must be a decimal string (e.g. "25.5").');
  }
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new TriggerValidationError("INVALID_AMOUNT", "amount must be > 0.");
  }
  const mode: TriggerMode = input.mode === "repeat" ? "repeat" : "once";
  const cooldownSec = input.cooldownSec ?? 0;
  if (!Number.isFinite(cooldownSec) || cooldownSec < 0 || cooldownSec > 365 * 24 * 60 * 60) {
    throw new TriggerValidationError("INVALID_COOLDOWN", "cooldownSec must be between 0 and one year.");
  }
  if (typeof input.label === "string" && input.label.length > 64) {
    throw new TriggerValidationError("INVALID_LABEL", "label must be ≤64 chars.");
  }

  const existing = await listTriggers(input.ownerAddr, input.walletId);
  const activeCount = existing.filter(
    (t) => t.status !== "cancelled" && t.status !== "fired-once",
  ).length;
  if (activeCount >= MAX_TRIGGERS_PER_WALLET) {
    throw new TriggerValidationError(
      "TOO_MANY_TRIGGERS",
      `This Agent Wallet already has the maximum of ${MAX_TRIGGERS_PER_WALLET} triggers. Cancel one before adding another.`,
    );
  }

  const now = Date.now();
  const id = generateTriggerId();
  const trigger: RedStoneTrigger = {
    id,
    walletId: lower(input.walletId),
    ownerAddr: lower(input.ownerAddr),
    label: input.label ?? null,
    feedId: input.feedId.toUpperCase(),
    op: input.op,
    threshold: input.threshold,
    chain: input.chain,
    token: input.token,
    recipient: lower(input.recipient),
    amount: input.amount,
    mode,
    cooldownSec,
    // Created DISARMED — never instant-fire on a level already breached at
    // creation. Arms on the first tick that observes the feed on the unmet side.
    armed: false,
    crossingSeq: 0,
    lastFiredAt: null,
    lastCheckedAt: null,
    lastValue: null,
    lastError: null,
    totalFiredCount: 0,
    totalSpentUsd: 0,
    status: "active",
    createdAt: now,
  };

  // Record → list → scan-set, in that order (a partial write never leaves the
  // watcher a trigger with no record).
  await kv.set(triggerKey(trigger.ownerAddr, trigger.walletId, id), trigger);
  await kv.rpush(triggerListKey(trigger.ownerAddr, trigger.walletId), id);
  await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, {
    score: now, // check ASAP so it arms on the next tick
    member: zsetMember(trigger.ownerAddr, trigger.walletId, id),
  });
  return trigger;
}

export async function getTrigger(
  ownerAddr: string,
  walletId: string,
  id: string,
): Promise<RedStoneTrigger | null> {
  const raw = await kv.get<RedStoneTrigger>(triggerKey(ownerAddr, walletId, id));
  return raw ?? null;
}

export async function listTriggers(
  ownerAddr: string,
  walletId: string,
): Promise<RedStoneTrigger[]> {
  const ids = (await kv.lrange<string>(triggerListKey(ownerAddr, walletId), 0, -1)) ?? [];
  if (ids.length === 0) return [];
  const out: RedStoneTrigger[] = [];
  for (const id of ids) {
    const t = await getTrigger(ownerAddr, walletId, id);
    if (t) out.push(t);
  }
  return out.sort((a, b) => {
    const order: Record<TriggerStatus, number> = {
      active: 0,
      paused: 1,
      "paused-by-archive": 2,
      "fired-cap-exceeded": 3,
      "fired-once": 4,
      cancelled: 5,
    };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return b.createdAt - a.createdAt;
  });
}

// ── User status actions ──────────────────────────────────────────────────────

export type UserTriggerAction = "pause" | "resume" | "cancel";

export async function applyUserTriggerAction(
  ownerAddr: string,
  walletId: string,
  id: string,
  action: UserTriggerAction,
): Promise<RedStoneTrigger> {
  const t = await getTrigger(ownerAddr, walletId, id);
  if (!t) throw new TriggerValidationError("TRIGGER_NOT_FOUND", "No trigger with that id under this wallet.");
  if (t.status === "cancelled") {
    throw new TriggerValidationError("ALREADY_CANCELLED", "This trigger is cancelled. Create a new one.");
  }
  const now = Date.now();
  const next: RedStoneTrigger = { ...t };
  const member = zsetMember(ownerAddr, walletId, id);

  switch (action) {
    case "pause": {
      next.status = "paused";
      // Disarm on pause so a resume can't inherit a stale armed edge and fire
      // on a level that was already breached while paused.
      next.armed = false;
      break;
    }
    case "resume": {
      if (t.status !== "paused" && t.status !== "paused-by-archive" && t.status !== "fired-cap-exceeded") {
        throw new TriggerValidationError("NOT_RESUMABLE", `Cannot resume from status "${t.status}".`);
      }
      next.status = "active";
      next.armed = false; // re-observe before it can fire
      next.lastError = null;
      break;
    }
    case "cancel": {
      // Best-effort claim of the CURRENT crossing's fire-lock so an in-flight
      // watcher tick that hasn't fired yet backs off (mirrors recurring cancel).
      try {
        await kv.set(fireLockKey(id, t.crossingSeq), "cancelled", { nx: true, ex: FIRE_LOCK_TTL_SEC });
      } catch {
        /* best-effort */
      }
      next.status = "cancelled";
      next.cancelledAt = now;
      next.armed = false;
      break;
    }
  }

  await kv.set(triggerKey(ownerAddr, walletId, id), next);
  if (next.status === "active") {
    await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, { score: now, member });
  } else {
    await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, member);
  }
  return next;
}

// ── Cascade hooks (wallet archive / restore / hard-delete) ────────────────────

export async function pauseTriggersForArchive(
  ownerAddr: string,
  walletId: string,
): Promise<{ pausedCount: number }> {
  const list = await listTriggers(ownerAddr, walletId);
  let pausedCount = 0;
  for (const t of list) {
    if (t.status !== "active") continue;
    const next: RedStoneTrigger = { ...t, status: "paused-by-archive", armed: false };
    await kv.set(triggerKey(ownerAddr, walletId, t.id), next);
    await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, zsetMember(ownerAddr, walletId, t.id));
    pausedCount++;
  }
  return { pausedCount };
}

export async function resumeTriggersForRestore(
  ownerAddr: string,
  walletId: string,
): Promise<{ resumedCount: number }> {
  const list = await listTriggers(ownerAddr, walletId);
  const now = Date.now();
  let resumedCount = 0;
  for (const t of list) {
    if (t.status !== "paused-by-archive") continue;
    const next: RedStoneTrigger = { ...t, status: "active", armed: false };
    await kv.set(triggerKey(ownerAddr, walletId, t.id), next);
    await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, { score: now, member: zsetMember(ownerAddr, walletId, t.id) });
    resumedCount++;
  }
  return { resumedCount };
}

export async function deleteTriggersForHardDelete(
  ownerAddr: string,
  walletId: string,
): Promise<{ deletedCount: number }> {
  const ids = (await kv.lrange<string>(triggerListKey(ownerAddr, walletId), 0, -1)) ?? [];
  let deletedCount = 0;
  for (const id of ids) {
    await kv.del(triggerKey(ownerAddr, walletId, id));
    await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, zsetMember(ownerAddr, walletId, id));
    deletedCount++;
  }
  await kv.del(triggerListKey(ownerAddr, walletId));
  return { deletedCount };
}

// ── Cron helpers (used by /api/cron/redstone-watcher) ─────────────────────────

/** Pull every active trigger whose nextCheckAt has elapsed, earliest first. */
export async function pullDueTriggers(nowMs: number, limit: number): Promise<RedStoneTrigger[]> {
  const members = await kv.zrange<string[]>(RSTRIGGER_NEXT_CHECK_ZSET, 0, nowMs, {
    byScore: true,
    offset: 0,
    count: limit,
  });
  if (!Array.isArray(members) || members.length === 0) return [];
  const out: RedStoneTrigger[] = [];
  for (const member of members) {
    const parsed = parseZsetMember(member);
    if (!parsed) {
      await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, member);
      continue;
    }
    const t = await getTrigger(parsed.ownerAddr, parsed.walletId, parsed.id);
    if (!t) {
      await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, member);
      continue;
    }
    // Defensive: only active triggers belong in the scan set.
    if (t.status !== "active") {
      await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, member);
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Reschedule a trigger's next check after a no-op tick (armed/observed, but not
 *  fired). Persists lastCheckedAt/lastValue and re-queues at now + intervalSec. */
export async function rescheduleCheck(
  t: RedStoneTrigger,
  nowMs: number,
  intervalSec: number,
  patch?: Partial<Pick<RedStoneTrigger, "armed" | "lastValue" | "lastError">>,
): Promise<RedStoneTrigger> {
  const next: RedStoneTrigger = {
    ...t,
    ...patch,
    lastCheckedAt: nowMs,
  };
  await kv.set(triggerKey(t.ownerAddr, t.walletId, t.id), next);
  await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, {
    score: nowMs + Math.max(0, intervalSec) * 1000,
    member: zsetMember(t.ownerAddr, t.walletId, t.id),
  });
  return next;
}

/** Durable settled-marker for (trigger, crossing). SET NX; a second writer
 *  treats an existing marker as "already fired". */
export async function markCrossingFired(
  id: string,
  seq: number,
  status: "confirmed" | "uncertain" = "confirmed",
): Promise<void> {
  await kv.set(firedMarkerKey(id, seq), status === "uncertain" ? "uncertain" : "1", {
    ex: FIRED_MARKER_TTL_SEC,
  });
}

async function crossingAlreadyFired(id: string, seq: number): Promise<boolean> {
  const v = await kv.get<string>(firedMarkerKey(id, seq));
  return typeof v === "string" && v.length > 0;
}

/**
 * Claim the right to fire the CURRENT crossing (t.crossingSeq). Mirrors
 * recurring's claimFireSlot: durable-marker check first (survives a fire-lock
 * TTL expiry after a dropped bookkeeping write), then SET NX the lock.
 */
export async function claimCrossingFire(
  t: RedStoneTrigger,
): Promise<{ ok: boolean; reason?: string; alreadyFired?: boolean }> {
  if (await crossingAlreadyFired(t.id, t.crossingSeq)) {
    return { ok: false, alreadyFired: true, reason: "crossing already fired (durable marker present)" };
  }
  const claim = await kv.set(fireLockKey(t.id, t.crossingSeq), "in-flight", {
    nx: true,
    ex: FIRE_LOCK_TTL_SEC,
  });
  if (claim === null) {
    return { ok: false, reason: "fire-lock held — concurrent tick or post-relay retry" };
  }
  return { ok: true };
}

/** Release the current crossing's fire-lock. Called ONLY on a pre-broadcast
 *  abort (nothing settled) so a retry isn't blocked for the full TTL. NOT after
 *  a successful/uncertain relay — the lock must persist to block a re-fire. */
export async function releaseCrossingFire(t: RedStoneTrigger): Promise<void> {
  await kv.del(fireLockKey(t.id, t.crossingSeq));
}

/**
 * Finalise a successful fire. Writes the durable marker FIRST, then re-reads
 * the current record and MERGES bookkeeping (so a cancel/pause landing during
 * the relay isn't clobbered back to active). Disarms, advances crossingSeq.
 * `once` → terminal "fired-once" (dropped from the scan set). `repeat` → stays
 * active, disarmed, re-queued (re-arms when the feed next goes unmet, subject to
 * cooldown).
 */
export async function recordTriggerFired(
  t: RedStoneTrigger,
  amountUsd: number,
  nowMs: number,
  intervalSec: number,
): Promise<RedStoneTrigger> {
  const firedSeq = t.crossingSeq;
  await markCrossingFired(t.id, firedSeq);

  const current = await getTrigger(t.ownerAddr, t.walletId, t.id);
  if (!current) return t;

  const stillActive = current.status === "active";
  const once = current.mode === "once";
  const next: RedStoneTrigger = {
    ...current,
    armed: false,
    crossingSeq: current.crossingSeq + 1,
    lastFiredAt: nowMs,
    lastCheckedAt: nowMs,
    lastError: null,
    totalFiredCount: current.totalFiredCount + 1,
    totalSpentUsd: current.totalSpentUsd + amountUsd,
    status: once ? "fired-once" : current.status,
  };
  await kv.set(triggerKey(t.ownerAddr, t.walletId, t.id), next);

  const member = zsetMember(t.ownerAddr, t.walletId, t.id);
  if (once || !stillActive) {
    // Terminal once-fire, or the trigger was cancelled/paused mid-relay — drop
    // it from the scan set either way.
    await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, member);
  } else {
    await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, { score: nowMs + Math.max(0, intervalSec) * 1000, member });
  }
  return next;
}

/**
 * Recovery for the case where markCrossingFired succeeded on a prior tick but
 * the follow-up record write did not — the on-chain TX settled (marker proves
 * it) yet the trigger still shows armed on the same crossing. Advance past it
 * WITHOUT re-relaying. Idempotent: only advances while the in-memory object
 * still points at the marked crossing.
 */
export async function advanceTriggerAfterMissedBookkeeping(
  t: RedStoneTrigger,
  nowMs: number,
  intervalSec: number,
): Promise<RedStoneTrigger> {
  const firedSeq = t.crossingSeq;
  const markerVal = await kv.get<string>(firedMarkerKey(t.id, firedSeq));
  const isUncertain = markerVal === "uncertain";
  const expectedUsd = Number(t.amount);
  const once = t.mode === "once";
  const next: RedStoneTrigger = {
    ...t,
    armed: false,
    crossingSeq: t.crossingSeq + 1,
    lastFiredAt: nowMs,
    lastCheckedAt: nowMs,
    totalFiredCount: isUncertain ? t.totalFiredCount : t.totalFiredCount + 1,
    totalSpentUsd: isUncertain
      ? t.totalSpentUsd
      : t.totalSpentUsd + (Number.isFinite(expectedUsd) ? expectedUsd : 0),
    lastError: isUncertain
      ? `Advanced past an UNCERTAIN fire (crossing ${firedSeq}): the relay broadcast but ` +
        `settlement could not be confirmed, so it was NOT counted. Verify on-chain.`
      : `Auto-recovered: previous fire settled on-chain but the bookkeeping write failed ` +
        `(crossing ${firedSeq}). Totals reflect the trigger's expected amount ($${
          Number.isFinite(expectedUsd) ? expectedUsd.toFixed(2) : "?"
        }).`,
    status: once ? "fired-once" : t.status,
  };
  await kv.set(triggerKey(t.ownerAddr, t.walletId, t.id), next);
  const member = zsetMember(t.ownerAddr, t.walletId, t.id);
  if (once || t.status !== "active") {
    await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, member);
  } else {
    await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, { score: nowMs + Math.max(0, intervalSec) * 1000, member });
  }
  return next;
}

/** Terminal failure (per-tx cap / hook deny / sub lapse). Drops from scan set. */
export async function recordTriggerCapExceeded(
  t: RedStoneTrigger,
  reason: string,
  nowMs: number,
): Promise<RedStoneTrigger> {
  const next: RedStoneTrigger = {
    ...t,
    status: "fired-cap-exceeded",
    armed: false,
    lastError: reason,
    lastCheckedAt: nowMs,
  };
  await kv.set(triggerKey(t.ownerAddr, t.walletId, t.id), next);
  await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, zsetMember(t.ownerAddr, t.walletId, t.id));
  return next;
}

/**
 * Transient failure (feed unreadable, relay 5xx, RPC down). Does NOT change
 * armed/crossingSeq — the crossing has NOT fired and must retry on a later tick.
 * Pushes the scan score forward by TRANSIENT_BACKOFF_MS so a dead feed doesn't
 * pin the front of the queue.
 */
export async function recordTriggerTransientError(
  t: RedStoneTrigger,
  reason: string,
  nowMs: number,
): Promise<void> {
  const next: RedStoneTrigger = { ...t, lastError: reason, lastCheckedAt: nowMs };
  await kv.set(triggerKey(t.ownerAddr, t.walletId, t.id), next);
  await kv.zadd(RSTRIGGER_NEXT_CHECK_ZSET, {
    score: nowMs + TRANSIENT_BACKOFF_MS,
    member: zsetMember(t.ownerAddr, t.walletId, t.id),
  });
}

/** Remove from the scan set without changing the record (wallet gone/archived
 *  discovered mid-tick). Cascade hooks own the record state. */
export async function removeFromCheckZset(t: RedStoneTrigger): Promise<void> {
  await kv.zrem(RSTRIGGER_NEXT_CHECK_ZSET, zsetMember(t.ownerAddr, t.walletId, t.id));
}

/** Whether a repeat trigger is still inside its post-fire cooldown. */
export function inCooldown(t: RedStoneTrigger, nowMs: number): boolean {
  if (t.cooldownSec <= 0 || t.lastFiredAt === null) return false;
  return nowMs - t.lastFiredAt < t.cooldownSec * 1000;
}

/** Test seam. */
export const __test = { conditionMet, inCooldown, HOUR_MS };
