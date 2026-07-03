import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory KV stand-in — same shape as agentic-wallet-recurring.test.ts.
const store = new Map<string, unknown>();
const listStore = new Map<string, unknown[]>();
const zsetStore = new Map<string, Map<string, number>>();

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  rpush: vi.fn(),
  lrange: vi.fn(),
  zadd: vi.fn(),
  zrem: vi.fn(),
  zrange: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import {
  createTrigger,
  getTrigger,
  listTriggers,
  applyUserTriggerAction,
  pauseTriggersForArchive,
  resumeTriggersForRestore,
  deleteTriggersForHardDelete,
  pullDueTriggers,
  claimCrossingFire,
  releaseCrossingFire,
  recordTriggerFired,
  recordTriggerTransientError,
  recordTriggerCapExceeded,
  advanceTriggerAfterMissedBookkeeping,
  markCrossingFired,
  conditionMet,
  inCooldown,
  dailyCapSatisfied,
  hasPositiveDailyCap,
  TriggerValidationError,
  RSTRIGGER_NEXT_CHECK_ZSET,
  type RedStoneTrigger,
} from "@/app/lib/redstone-trigger";

const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const RECIP = "0x3333333333333333333333333333333333333333";

function baseInput() {
  return {
    ownerAddr: OWNER,
    walletId: WALLET,
    feedId: "ETH",
    op: ">=" as const,
    threshold: 2000,
    chain: "bnb" as const,
    token: "USDC" as const,
    recipient: RECIP,
    amount: "10",
  };
}

async function expectThrowsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TriggerValidationError);
    expect((e as TriggerValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected throw with code=${code}, but none was thrown`);
}

beforeEach(() => {
  store.clear();
  listStore.clear();
  zsetStore.clear();
  vi.clearAllMocks();

  mockKv.get.mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null));
  mockKv.set.mockImplementation((key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
    if (opts?.nx && store.has(key)) return Promise.resolve(null);
    store.set(key, value);
    return Promise.resolve("OK");
  });
  mockKv.del.mockImplementation((key: string) => {
    const had = store.delete(key) || listStore.delete(key);
    return Promise.resolve(had ? 1 : 0);
  });
  mockKv.rpush.mockImplementation((key: string, ...values: unknown[]) => {
    const arr = listStore.get(key) ?? [];
    arr.push(...values);
    listStore.set(key, arr);
    return Promise.resolve(arr.length);
  });
  mockKv.lrange.mockImplementation((key: string, start: number, end: number) => {
    const arr = listStore.get(key) ?? [];
    if (end === -1) return Promise.resolve(arr.slice(start));
    return Promise.resolve(arr.slice(start, end + 1));
  });
  mockKv.zadd.mockImplementation((zsetKey: string, entry: { score: number; member: string }) => {
    const m = zsetStore.get(zsetKey) ?? new Map<string, number>();
    m.set(entry.member, entry.score);
    zsetStore.set(zsetKey, m);
    return Promise.resolve(1);
  });
  mockKv.zrem.mockImplementation((zsetKey: string, member: string) => {
    const m = zsetStore.get(zsetKey);
    if (!m) return Promise.resolve(0);
    return Promise.resolve(m.delete(member) ? 1 : 0);
  });
  mockKv.zrange.mockImplementation(
    (zsetKey: string, _min: number, max: number, opts: { offset?: number; count?: number }) => {
      const m = zsetStore.get(zsetKey);
      if (!m) return Promise.resolve([]);
      const filtered = [...m.entries()]
        .filter(([, score]) => score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
      return Promise.resolve(
        filtered.slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.count ?? filtered.length)),
      );
    },
  );
});

// ── conditionMet truth table ──────────────────────────────────────────────

describe("conditionMet", () => {
  it(">= boundary + above + below", () => {
    expect(conditionMet(2000, ">=", 2000)).toBe(true);
    expect(conditionMet(2001, ">=", 2000)).toBe(true);
    expect(conditionMet(1999, ">=", 2000)).toBe(false);
  });
  it("> strict", () => {
    expect(conditionMet(2000, ">", 2000)).toBe(false);
    expect(conditionMet(2001, ">", 2000)).toBe(true);
  });
  it("<= boundary", () => {
    expect(conditionMet(2000, "<=", 2000)).toBe(true);
    expect(conditionMet(1999, "<=", 2000)).toBe(true);
    expect(conditionMet(2001, "<=", 2000)).toBe(false);
  });
  it("< strict", () => {
    expect(conditionMet(2000, "<", 2000)).toBe(false);
    expect(conditionMet(1999, "<", 2000)).toBe(true);
  });
});

// ── daily-cap fail-closed predicate (create/resume/watcher all gate on this) ──

describe("hasPositiveDailyCap", () => {
  it("true only for a positive finite number", () => {
    expect(hasPositiveDailyCap(100)).toBe(true);
    expect(hasPositiveDailyCap(0.01)).toBe(true);
    expect(hasPositiveDailyCap(0)).toBe(false);
    expect(hasPositiveDailyCap(-5)).toBe(false);
    expect(hasPositiveDailyCap(undefined)).toBe(false);
    expect(hasPositiveDailyCap(NaN)).toBe(false);
    expect(hasPositiveDailyCap(Infinity)).toBe(false);
  });
});

describe("dailyCapSatisfied (repeat triggers fail-CLOSED without a daily cap)", () => {
  it("once is ALWAYS allowed (bounded by its single amount)", () => {
    expect(dailyCapSatisfied("once", undefined)).toBe(true);
    expect(dailyCapSatisfied("once", 0)).toBe(true);
    expect(dailyCapSatisfied("once", 100)).toBe(true);
  });
  it("repeat requires a positive daily cap", () => {
    expect(dailyCapSatisfied("repeat", 100)).toBe(true);
    expect(dailyCapSatisfied("repeat", undefined)).toBe(false); // cap deleted/null
    expect(dailyCapSatisfied("repeat", 0)).toBe(false);
    expect(dailyCapSatisfied("repeat", -1)).toBe(false);
    expect(dailyCapSatisfied("repeat", NaN)).toBe(false);
  });
});

describe("inCooldown", () => {
  it("false when never fired or cooldown 0", () => {
    const t = { cooldownSec: 0, lastFiredAt: null } as RedStoneTrigger;
    expect(inCooldown(t, 1000)).toBe(false);
    const t2 = { cooldownSec: 60, lastFiredAt: null } as RedStoneTrigger;
    expect(inCooldown(t2, 1000)).toBe(false);
  });
  it("true inside window, false after", () => {
    const t = { cooldownSec: 60, lastFiredAt: 1_000_000 } as RedStoneTrigger;
    expect(inCooldown(t, 1_000_000 + 30_000)).toBe(true);
    expect(inCooldown(t, 1_000_000 + 60_000)).toBe(false);
    expect(inCooldown(t, 1_000_000 + 90_000)).toBe(false);
  });
});

// ── create ──────────────────────────────────────────────────────────────

describe("createTrigger", () => {
  it("creates DISARMED at crossingSeq 0, queued in the scan set", async () => {
    const t = await createTrigger(baseInput());
    expect(t.armed).toBe(false);
    expect(t.crossingSeq).toBe(0);
    expect(t.status).toBe("active");
    expect(t.feedId).toBe("ETH");
    expect(t.recipient).toBe(RECIP.toLowerCase());
    const zmembers = zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET);
    expect(zmembers?.size).toBe(1);
  });

  it("rejects a bad address / amount / op / feed", async () => {
    await expectThrowsCode(() => createTrigger({ ...baseInput(), recipient: "0xnope" }), "INVALID_RECIPIENT");
    await expectThrowsCode(() => createTrigger({ ...baseInput(), amount: "0" }), "INVALID_AMOUNT");
    await expectThrowsCode(
      () => createTrigger({ ...baseInput(), op: "!=" as unknown as ">=" }),
      "INVALID_OP",
    );
    await expectThrowsCode(() => createTrigger({ ...baseInput(), feedId: "bad feed!" }), "INVALID_FEED");
  });
});

// ── fire-lock idempotency ─────────────────────────────────────────────────

describe("claimCrossingFire idempotency", () => {
  it("first claim wins; a concurrent second claim on the same crossing is refused", async () => {
    const t = await createTrigger(baseInput());
    const a = await claimCrossingFire(t);
    expect(a.ok).toBe(true);
    const b = await claimCrossingFire(t);
    expect(b.ok).toBe(false);
    expect(b.alreadyFired).toBeFalsy();
  });

  it("a durable fired-marker refuses re-entry even after the lock is released", async () => {
    const t = await createTrigger(baseInput());
    await markCrossingFired(t.id, t.crossingSeq, "confirmed");
    // Lock was never taken, but the marker alone must block re-firing this crossing.
    const c = await claimCrossingFire(t);
    expect(c.ok).toBe(false);
    expect(c.alreadyFired).toBe(true);
  });

  it("releaseCrossingFire frees a pre-broadcast lock for retry", async () => {
    const t = await createTrigger(baseInput());
    expect((await claimCrossingFire(t)).ok).toBe(true);
    await releaseCrossingFire(t);
    expect((await claimCrossingFire(t)).ok).toBe(true);
  });
});

// ── recordTriggerFired: once vs repeat ────────────────────────────────────

describe("recordTriggerFired", () => {
  it("once → fired-once, disarmed, crossingSeq++, dropped from scan set", async () => {
    let t = await createTrigger({ ...baseInput(), mode: "once" });
    t = { ...t, armed: true }; // simulate an armed edge
    const after = await recordTriggerFired(t, 10, 5_000_000, 0);
    expect(after.status).toBe("fired-once");
    expect(after.armed).toBe(false);
    expect(after.crossingSeq).toBe(1);
    expect(after.totalFiredCount).toBe(1);
    expect(after.totalSpentUsd).toBe(10);
    expect(zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET)?.has(`${OWNER}/${WALLET}/${t.id}`.toLowerCase())).toBe(false);
  });

  it("repeat → stays active, disarmed, crossingSeq++, re-queued", async () => {
    let t = await createTrigger({ ...baseInput(), mode: "repeat", cooldownSec: 60 });
    t = { ...t, armed: true };
    const after = await recordTriggerFired(t, 10, 5_000_000, 0);
    expect(after.status).toBe("active");
    expect(after.armed).toBe(false);
    expect(after.crossingSeq).toBe(1);
    expect(zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET)?.has(`${OWNER}/${WALLET}/${t.id}`.toLowerCase())).toBe(true);
  });

  it("writes a durable marker so a re-fire of the SAME crossing is blocked", async () => {
    let t = await createTrigger({ ...baseInput(), mode: "repeat" });
    t = { ...t, armed: true };
    await recordTriggerFired(t, 10, 5_000_000, 0);
    // The just-fired crossing (seq 0) is now marked; claiming it again is refused.
    const c = await claimCrossingFire({ ...t, crossingSeq: 0 });
    expect(c.ok).toBe(false);
    expect(c.alreadyFired).toBe(true);
  });
});

// ── recovery + transient ──────────────────────────────────────────────────

describe("advanceTriggerAfterMissedBookkeeping", () => {
  it("advances a confirmed crossing without a relay, crediting the amount", async () => {
    let t = await createTrigger({ ...baseInput(), mode: "repeat" });
    t = { ...t, armed: true };
    await markCrossingFired(t.id, t.crossingSeq, "confirmed");
    const after = await advanceTriggerAfterMissedBookkeeping(t, 6_000_000, 0);
    expect(after.crossingSeq).toBe(1);
    expect(after.armed).toBe(false);
    expect(after.totalFiredCount).toBe(1);
    expect(after.totalSpentUsd).toBe(10);
  });

  it("advances an UNCERTAIN crossing WITHOUT crediting totals", async () => {
    let t = await createTrigger({ ...baseInput(), mode: "repeat" });
    t = { ...t, armed: true };
    await markCrossingFired(t.id, t.crossingSeq, "uncertain");
    const after = await advanceTriggerAfterMissedBookkeeping(t, 6_000_000, 0);
    expect(after.crossingSeq).toBe(1);
    expect(after.totalFiredCount).toBe(0);
    expect(after.totalSpentUsd).toBe(0);
    expect(after.lastError).toMatch(/uncertain/i);
  });
});

describe("recordTriggerTransientError", () => {
  it("does NOT consume the crossing (armed + crossingSeq preserved), backs off scan", async () => {
    let t = await createTrigger(baseInput());
    t = { ...t, armed: true };
    await recordTriggerTransientError(t, "feed unreadable", 7_000_000);
    const reloaded = await getTrigger(OWNER, WALLET, t.id);
    expect(reloaded?.armed).toBe(true);
    expect(reloaded?.crossingSeq).toBe(0);
    expect(reloaded?.lastError).toMatch(/unreadable/);
    // Scan score pushed into the future (>= now + backoff), so it isn't due now.
    const member = `${OWNER}/${WALLET}/${t.id}`.toLowerCase();
    const score = zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET)?.get(member);
    expect(score).toBeGreaterThan(7_000_000);
  });
});

// ── status actions + cascade ──────────────────────────────────────────────

describe("user status actions", () => {
  it("pause disarms + removes from scan set; resume re-adds disarmed", async () => {
    const t = await createTrigger(baseInput());
    const member = `${OWNER}/${WALLET}/${t.id}`.toLowerCase();
    const paused = await applyUserTriggerAction(OWNER, WALLET, t.id, "pause");
    expect(paused.status).toBe("paused");
    expect(paused.armed).toBe(false);
    expect(zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET)?.has(member)).toBe(false);
    const resumed = await applyUserTriggerAction(OWNER, WALLET, t.id, "resume");
    expect(resumed.status).toBe("active");
    expect(resumed.armed).toBe(false);
    expect(zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET)?.has(member)).toBe(true);
  });

  it("cancel is terminal", async () => {
    const t = await createTrigger(baseInput());
    const cancelled = await applyUserTriggerAction(OWNER, WALLET, t.id, "cancel");
    expect(cancelled.status).toBe("cancelled");
    await expectThrowsCode(() => applyUserTriggerAction(OWNER, WALLET, t.id, "resume"), "ALREADY_CANCELLED");
  });
});

describe("wallet cascade", () => {
  it("archive pauses active triggers; restore re-activates them disarmed", async () => {
    await createTrigger(baseInput());
    const arch = await pauseTriggersForArchive(OWNER, WALLET);
    expect(arch.pausedCount).toBe(1);
    let list = await listTriggers(OWNER, WALLET);
    expect(list[0].status).toBe("paused-by-archive");
    const res = await resumeTriggersForRestore(OWNER, WALLET);
    expect(res.resumedCount).toBe(1);
    list = await listTriggers(OWNER, WALLET);
    expect(list[0].status).toBe("active");
    expect(list[0].armed).toBe(false);
  });

  it("hard-delete removes record + list + scan entry", async () => {
    const t = await createTrigger(baseInput());
    const del = await deleteTriggersForHardDelete(OWNER, WALLET);
    expect(del.deletedCount).toBe(1);
    expect(await getTrigger(OWNER, WALLET, t.id)).toBeNull();
    expect(await listTriggers(OWNER, WALLET)).toEqual([]);
  });
});

// ── pullDueTriggers hygiene ────────────────────────────────────────────────

describe("pullDueTriggers", () => {
  it("returns only active, due triggers and cleans stale members", async () => {
    const t = await createTrigger(baseInput());
    // A cancelled trigger left in the scan set must be pruned, not returned.
    await recordTriggerCapExceeded(t, "test terminal", 1000);
    // Re-add a stale member manually to simulate a dangling ZSET entry.
    zsetStore.get(RSTRIGGER_NEXT_CHECK_ZSET)?.set(`${OWNER}/${WALLET}/${t.id}`.toLowerCase(), 1);
    const due = await pullDueTriggers(9_000_000, 50);
    expect(due.find((d) => d.id === t.id)).toBeUndefined();
  });
});
