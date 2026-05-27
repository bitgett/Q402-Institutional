import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory KV stand-in covering the subset of @vercel/kv that the
// recurring library + cascade hooks touch. Pattern mirrors
// agentic-wallet.test.ts so the same in-memory shape can co-exist
// for the cascade tests later in this file.

const store = new Map<string, unknown>();
const listStore = new Map<string, unknown[]>();
const zsetStore = new Map<string, Map<string, number>>();

const mockKv = vi.hoisted(() => ({
  get:   vi.fn(),
  set:   vi.fn(),
  del:   vi.fn(),
  rpush: vi.fn(),
  lpush: vi.fn(),
  ltrim: vi.fn(),
  lrange: vi.fn(),
  zadd:  vi.fn(),
  zrem:  vi.fn(),
  zrange: vi.fn(),
  incrbyfloat: vi.fn(),
  incrby: vi.fn(),
  expire: vi.fn(),
  // Track raw set calls with options so tests can assert SET NX semantics.
  __setOptions: new Map<string, { nx?: boolean; ex?: number } | undefined>(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import {
  isFrequencyEnum,
  computeNextFireAt,
  computeFirstFireAt,
  createRecurringRule,
  listRecurringRules,
  getRecurringRule,
  applyUserStatusAction,
  pauseRulesForArchive,
  resumeRulesForRestore,
  deleteRulesForHardDelete,
  pullDueRules,
  markRulePending,
  recordRuleFired,
  computeNextActionAt,
  parseZsetMember,
  claimFireSlot,
  releaseFireSlot,
  removeFromActionZset,
  isStaleSlot,
  skipStaleSlot,
  recordRuleTransientError,
  RecurringValidationError,
  MIN_CANCEL_WINDOW_HOURS,
  TRANSIENT_BACKOFF_MS,
  RECURRING_NEXT_ACTION_ZSET,
} from "@/app/lib/agentic-wallet-recurring";

// Type-safe expect-throws helper: assert the thrown error's `code` field.
async function expectThrowsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RecurringValidationError);
    expect((e as RecurringValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected throw with code=${code}, but no error was thrown`);
}

const TEST_OWNER  = "0x1111111111111111111111111111111111111111";
const TEST_WALLET = "0x2222222222222222222222222222222222222222";
const TEST_RECIP  = "0x3333333333333333333333333333333333333333";

beforeEach(() => {
  store.clear();
  listStore.clear();
  zsetStore.clear();
  vi.clearAllMocks();

  mockKv.get.mockImplementation((key: string) =>
    Promise.resolve(store.get(key) ?? null),
  );
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
    (
      zsetKey: string,
      _min: number,
      max: number,
      _opts: { byScore?: boolean; offset?: number; count?: number },
    ) => {
      const m = zsetStore.get(zsetKey);
      if (!m) return Promise.resolve([]);
      const filtered = [...m.entries()]
        .filter(([, score]) => score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
      return Promise.resolve(filtered.slice(_opts?.offset ?? 0, (_opts?.offset ?? 0) + (_opts?.count ?? filtered.length)));
    },
  );
});

// ── Frequency enum guard ──────────────────────────────────────────────────

describe("isFrequencyEnum", () => {
  it("accepts daily", () => {
    expect(isFrequencyEnum("daily")).toBe(true);
  });
  it("accepts weekly:<day>", () => {
    expect(isFrequencyEnum("weekly:mon")).toBe(true);
    expect(isFrequencyEnum("weekly:fri")).toBe(true);
    expect(isFrequencyEnum("weekly:sun")).toBe(true);
  });
  it("rejects weekly with bad day", () => {
    expect(isFrequencyEnum("weekly:funday")).toBe(false);
    expect(isFrequencyEnum("weekly:")).toBe(false);
  });
  it("accepts monthly:<N> for 1..31", () => {
    expect(isFrequencyEnum("monthly:1")).toBe(true);
    expect(isFrequencyEnum("monthly:15")).toBe(true);
    expect(isFrequencyEnum("monthly:31")).toBe(true);
  });
  it("rejects monthly:<N> outside 1..31 or non-integer", () => {
    expect(isFrequencyEnum("monthly:0")).toBe(false);
    expect(isFrequencyEnum("monthly:32")).toBe(false);
    expect(isFrequencyEnum("monthly:15.5")).toBe(false);
    expect(isFrequencyEnum("monthly:abc")).toBe(false);
  });
  it("accepts monthly:last", () => {
    expect(isFrequencyEnum("monthly:last")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isFrequencyEnum("")).toBe(false);
    expect(isFrequencyEnum("hourly")).toBe(false);
    expect(isFrequencyEnum(null)).toBe(false);
    expect(isFrequencyEnum(42)).toBe(false);
  });
});

// ── computeNextFireAt ─────────────────────────────────────────────────────

describe("computeNextFireAt", () => {
  it("daily adds 24h", () => {
    const from = Date.UTC(2026, 4, 27, 9, 0, 0); // Wed 09:00 UTC
    const next = computeNextFireAt("daily", from);
    expect(next).toBe(from + 24 * 60 * 60 * 1000);
  });

  it("weekly:fri from a Wednesday → coming Friday same hh:mm", () => {
    // 2026-05-27 is a Wednesday.
    const from = Date.UTC(2026, 4, 27, 9, 0, 0);
    const next = computeNextFireAt("weekly:fri", from);
    const nextDate = new Date(next);
    expect(nextDate.getUTCDay()).toBe(5); // Friday
    expect(nextDate.getUTCHours()).toBe(9);
  });

  it("weekly:fri from a Friday → following Friday (never same day)", () => {
    // 2026-05-29 = Friday.
    const from = Date.UTC(2026, 4, 29, 9, 0, 0);
    const next = computeNextFireAt("weekly:fri", from);
    expect(next - from).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("monthly:15 from May 27 → June 15", () => {
    const from = Date.UTC(2026, 4, 27, 9, 0, 0); // May (m=4)
    const next = computeNextFireAt("monthly:15", from);
    const d = new Date(next);
    expect(d.getUTCMonth()).toBe(5); // June
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(9);
  });

  it("monthly:31 from January → snaps to Feb 28/29 (no Feb 31)", () => {
    const from = Date.UTC(2026, 0, 31, 9, 0, 0); // Jan 31 2026 (non-leap)
    const next = computeNextFireAt("monthly:31", from);
    const d = new Date(next);
    expect(d.getUTCMonth()).toBe(1); // February
    expect(d.getUTCDate()).toBeGreaterThanOrEqual(28);
    expect(d.getUTCDate()).toBeLessThanOrEqual(29);
  });

  it("monthly:last fires last day of next month", () => {
    const from = Date.UTC(2026, 4, 15, 9, 0, 0); // May 15
    const next = computeNextFireAt("monthly:last", from);
    const d = new Date(next);
    expect(d.getUTCMonth()).toBe(5); // June
    expect(d.getUTCDate()).toBe(30); // June has 30 days
  });
});

// ── computeFirstFireAt — 24h cancel-window guarantee ──────────────────────

describe("computeFirstFireAt", () => {
  it("Wed 14:00 + weekly:fri (cw=24h) → this week's Friday (>24h ahead)", () => {
    const wedMs = Date.UTC(2026, 4, 27, 14, 0, 0);
    const first = computeFirstFireAt("weekly:fri", wedMs, 24);
    expect(first - wedMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(new Date(first).getUTCDay()).toBe(5);
  });

  it("Thu 23:00 + weekly:fri (cw=24h) → NEXT Friday (this Fri is <24h)", () => {
    const thuMs = Date.UTC(2026, 4, 28, 23, 0, 0); // Thursday
    const first = computeFirstFireAt("weekly:fri", thuMs, 24);
    expect(first - thuMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    // This week's Friday is only ~10h away → must skip to next week.
    const days = (first - thuMs) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThanOrEqual(7);
  });

  it("daily + cw=24h → fires day after tomorrow at same time-of-day", () => {
    const t = Date.UTC(2026, 4, 27, 14, 0, 0);
    const first = computeFirstFireAt("daily", t, 24);
    // computeNextFireAt fires 24h after the input; we feed (t + 24h),
    // so first fire is at t + 48h.
    expect(first - t).toBe(48 * 60 * 60 * 1000);
  });
});

// ── computeNextActionAt ───────────────────────────────────────────────────

describe("computeNextActionAt", () => {
  it("pendingFireAt=null → returns nextRunAt − cancelWindow (alert time)", () => {
    const rule = { nextRunAt: 1_000_000_000, pendingFireAt: null, cancelWindowHours: 24 };
    expect(computeNextActionAt(rule)).toBe(1_000_000_000 - 24 * 60 * 60 * 1000);
  });
  it("pendingFireAt set → returns nextRunAt (fire time)", () => {
    const rule = { nextRunAt: 1_000_000_000, pendingFireAt: 999_000_000, cancelWindowHours: 24 };
    expect(computeNextActionAt(rule)).toBe(1_000_000_000);
  });
});

// ── parseZsetMember ───────────────────────────────────────────────────────

describe("parseZsetMember", () => {
  it("parses 3-segment owner/wallet/rule", () => {
    expect(parseZsetMember("0xabc/0xdef/ruleid123")).toEqual({
      ownerAddr: "0xabc",
      walletId: "0xdef",
      ruleId: "ruleid123",
    });
  });
  it("rejects 2-segment or 4-segment garbage", () => {
    expect(parseZsetMember("0xabc/0xdef")).toBeNull();
    expect(parseZsetMember("0xabc/0xdef/rule/extra")).toBeNull();
    expect(parseZsetMember("")).toBeNull();
  });
});

// ── createRecurringRule — happy path + validation ─────────────────────────

const VALID_INPUT = {
  ownerAddr: TEST_OWNER,
  walletId: TEST_WALLET,
  frequency: "weekly:fri" as const,
  chain: "bnb" as const,
  token: "USDT" as const,
  recipient: TEST_RECIP,
  amount: "25",
};

describe("createRecurringRule", () => {
  it("creates a rule with sane defaults", async () => {
    const rule = await createRecurringRule(VALID_INPUT);
    expect(rule.status).toBe("active");
    expect(rule.cancelWindowHours).toBe(MIN_CANCEL_WINDOW_HOURS);
    expect(rule.pendingFireAt).toBeNull();
    expect(rule.totalFiredCount).toBe(0);
    expect(rule.nextRunAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("persists into KV (record + list)", async () => {
    const rule = await createRecurringRule(VALID_INPUT);
    const got = await getRecurringRule(TEST_OWNER, TEST_WALLET, rule.ruleId);
    expect(got).not.toBeNull();
    expect(got?.amount).toBe("25");
  });

  it("registers into the next-action ZSET", async () => {
    await createRecurringRule(VALID_INPUT);
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET);
    expect(m?.size).toBe(1);
  });

  it("rejects invalid frequency", async () => {
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, frequency: "monthly:99" as never }),
      "INVALID_FREQUENCY",
    );
  });
  it("rejects invalid recipient", async () => {
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, recipient: "0xnotahex" }),
      "INVALID_RECIPIENT",
    );
  });
  it("rejects negative or zero amount", async () => {
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, amount: "0" }),
      "INVALID_AMOUNT",
    );
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, amount: "-5" }),
      "INVALID_AMOUNT",
    );
  });
  it("rejects cancel window below MIN", async () => {
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, cancelWindowHours: 12 }),
      "INVALID_CANCEL_WINDOW",
    );
  });
  it("rejects cancel window > frequency interval (daily + 48h)", async () => {
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, frequency: "daily", cancelWindowHours: 48 }),
      "CANCEL_WINDOW_EXCEEDS_FREQUENCY",
    );
  });
  it("rejects cancel window > frequency interval (weekly + 200h)", async () => {
    await expectThrowsCode(
      () => createRecurringRule({ ...VALID_INPUT, frequency: "weekly:fri", cancelWindowHours: 200 }),
      "CANCEL_WINDOW_EXCEEDS_FREQUENCY",
    );
  });
  it("accepts cancel window exactly at the frequency interval (weekly + 168h)", async () => {
    const r = await createRecurringRule({ ...VALID_INPUT, frequency: "weekly:fri", cancelWindowHours: 168 });
    expect(r.cancelWindowHours).toBe(168);
  });
});

// ── listRecurringRules ordering ───────────────────────────────────────────

describe("listRecurringRules", () => {
  it("orders active rules first, then paused, then cancelled", async () => {
    const r1 = await createRecurringRule({ ...VALID_INPUT, amount: "1" });
    const r2 = await createRecurringRule({ ...VALID_INPUT, amount: "2" });
    const r3 = await createRecurringRule({ ...VALID_INPUT, amount: "3" });
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r2.ruleId, "pause");
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r3.ruleId, "cancel");
    const rules = await listRecurringRules(TEST_OWNER, TEST_WALLET);
    expect(rules.map((r) => r.status)).toEqual(["active", "paused", "cancelled"]);
    expect(rules[0].ruleId).toBe(r1.ruleId);
  });
});

// ── Status transitions ───────────────────────────────────────────────────

describe("applyUserStatusAction", () => {
  it("pause → resume restores to active", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const paused = await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "pause");
    expect(paused.status).toBe("paused");
    const resumed = await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "resume");
    expect(resumed.status).toBe("active");
  });

  it("cancel is terminal — cannot un-cancel", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "cancel");
    await expectThrowsCode(
      () => applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "resume"),
      "ALREADY_CANCELLED",
    );
  });

  it("skip-next advances nextRunAt past the current slot", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const before = r.nextRunAt;
    const after = await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "skip-next");
    expect(after.nextRunAt).toBeGreaterThan(before);
  });

  it("paused rule removed from ZSET so cron skips it", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "pause");
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET);
    expect(m?.size ?? 0).toBe(0);
  });

  it("resume re-registers into ZSET", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "pause");
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "resume");
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET);
    expect(m?.size).toBe(1);
  });

  it("resume works from fired-cap-exceeded (user fixed the cap)", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    // Simulate the cron transitioning the rule to "fired-cap-exceeded".
    const { recordRuleCapExceeded } = await import("@/app/lib/agentic-wallet-recurring");
    const fresh = (await getRecurringRule(TEST_OWNER, TEST_WALLET, r.ruleId))!;
    await recordRuleCapExceeded(fresh, "Amount $200 now exceeds per-tx cap $100", Date.now());
    const beforeResume = (await getRecurringRule(TEST_OWNER, TEST_WALLET, r.ruleId))!;
    expect(beforeResume.status).toBe("fired-cap-exceeded");
    expect(beforeResume.lastError).toContain("exceeds");
    // User raises the cap, then resumes.
    const resumed = await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r.ruleId, "resume");
    expect(resumed.status).toBe("active");
    expect(resumed.lastError).toBeNull();
    // Re-queued into ZSET.
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET);
    expect(m?.size).toBe(1);
  });
});

// ── Cascade helpers ──────────────────────────────────────────────────────

describe("cascade hooks", () => {
  it("pauseRulesForArchive only pauses active rules", async () => {
    const r1 = await createRecurringRule({ ...VALID_INPUT, amount: "1" });
    const r2 = await createRecurringRule({ ...VALID_INPUT, amount: "2" });
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r2.ruleId, "pause");
    const result = await pauseRulesForArchive(TEST_OWNER, TEST_WALLET);
    expect(result.pausedCount).toBe(1);
    const r1After = await getRecurringRule(TEST_OWNER, TEST_WALLET, r1.ruleId);
    const r2After = await getRecurringRule(TEST_OWNER, TEST_WALLET, r2.ruleId);
    expect(r1After?.status).toBe("paused-by-archive");
    expect(r2After?.status).toBe("paused"); // user-paused stays
  });

  it("resumeRulesForRestore resumes only paused-by-archive (user-paused stays)", async () => {
    const r1 = await createRecurringRule({ ...VALID_INPUT, amount: "1" });
    const r2 = await createRecurringRule({ ...VALID_INPUT, amount: "2" });
    await applyUserStatusAction(TEST_OWNER, TEST_WALLET, r2.ruleId, "pause");
    await pauseRulesForArchive(TEST_OWNER, TEST_WALLET);
    const result = await resumeRulesForRestore(TEST_OWNER, TEST_WALLET);
    expect(result.resumedCount).toBe(1);
    const r1After = await getRecurringRule(TEST_OWNER, TEST_WALLET, r1.ruleId);
    const r2After = await getRecurringRule(TEST_OWNER, TEST_WALLET, r2.ruleId);
    expect(r1After?.status).toBe("active");
    expect(r2After?.status).toBe("paused"); // user-pause survives cascade
  });

  it("deleteRulesForHardDelete removes all rules + their ZSET entries", async () => {
    await createRecurringRule({ ...VALID_INPUT, amount: "1" });
    await createRecurringRule({ ...VALID_INPUT, amount: "2" });
    const result = await deleteRulesForHardDelete(TEST_OWNER, TEST_WALLET);
    expect(result.deletedCount).toBe(2);
    const rules = await listRecurringRules(TEST_OWNER, TEST_WALLET);
    expect(rules).toEqual([]);
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET);
    expect(m?.size ?? 0).toBe(0);
  });
});

// ── Cron lifecycle (pull → markPending → recordFired) ────────────────────

describe("cron lifecycle helpers", () => {
  it("pullDueRules returns rules whose nextActionAt ≤ now", async () => {
    const r1 = await createRecurringRule(VALID_INPUT);
    // Force the rule's ZSET score back to a past time so the pull sees it.
    const member = `${TEST_OWNER.toLowerCase()}/${TEST_WALLET.toLowerCase()}/${r1.ruleId}`;
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET)!;
    m.set(member, Date.now() - 1000);
    const due = await pullDueRules(Date.now(), 10);
    expect(due.length).toBe(1);
    expect(due[0].ruleId).toBe(r1.ruleId);
  });

  it("markRulePending sets pendingFireAt + advances ZSET score to nextRunAt", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const now = Date.now();
    const updated = await markRulePending(r, now);
    expect(updated.pendingFireAt).toBe(now);
    // ZSET score is now r.nextRunAt (the fire time)
    const m = zsetStore.get(RECURRING_NEXT_ACTION_ZSET)!;
    const member = `${TEST_OWNER.toLowerCase()}/${TEST_WALLET.toLowerCase()}/${r.ruleId}`;
    expect(m.get(member)).toBe(r.nextRunAt);
  });

  it("recordRuleFired advances nextRunAt, increments counters, resets pendingFireAt", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    await markRulePending(r, Date.now());
    const fresh = (await getRecurringRule(TEST_OWNER, TEST_WALLET, r.ruleId))!;
    const prevNextRun = fresh.nextRunAt;
    const fired = await recordRuleFired(fresh, 25, Date.now());
    expect(fired.totalFiredCount).toBe(1);
    expect(fired.totalSpentUsd).toBe(25);
    expect(fired.pendingFireAt).toBeNull();
    expect(fired.nextRunAt).toBeGreaterThan(prevNextRun);
  });
});

// ── Catch-up policy ──────────────────────────────────────────────────────

describe("catch-up policy (cron resumes after downtime)", () => {
  it("isStaleSlot is false for a normal due rule", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    expect(isStaleSlot(r, Date.now())).toBe(false);
  });

  it("isStaleSlot is true when nextRunAt is more than cancelWindow in the past", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    // 25h beyond a 24h cancel window → stale.
    const longGoneNow = r.nextRunAt + 25 * 60 * 60 * 1000;
    expect(isStaleSlot(r, longGoneNow)).toBe(true);
  });

  it("skipStaleSlot advances nextRunAt to a future slot without firing", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const longGoneNow = r.nextRunAt + 25 * 60 * 60 * 1000;
    const advanced = await skipStaleSlot(r, longGoneNow);
    expect(advanced.totalFiredCount).toBe(0);
    expect(advanced.nextRunAt).toBeGreaterThan(longGoneNow);
    expect(advanced.lastError).toContain("stale slot");
  });

  it("recordRuleFired jumps to the next future slot when cron is late (never replays missed weeks)", async () => {
    const r = await createRecurringRule({ ...VALID_INPUT, frequency: "daily" });
    // Cron wakes 5 days after the planned fire.
    const lateNow = r.nextRunAt + 5 * 24 * 60 * 60 * 1000;
    const fired = await recordRuleFired(r, 25, lateNow);
    // New nextRunAt must be in the future relative to `now`, not just
    // relative to the original nextRunAt (otherwise we'd replay each
    // missed day for the next 4 cron ticks).
    expect(fired.nextRunAt).toBeGreaterThan(lateNow);
    // Same fire, single counter increment.
    expect(fired.totalFiredCount).toBe(1);
  });
});

// ── Fire-lock semantics ──────────────────────────────────────────────────

describe("fire-lock per slot", () => {
  it("first claim succeeds; second claim on same slot is rejected", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const first = await claimFireSlot(r);
    expect(first.ok).toBe(true);
    const second = await claimFireSlot(r);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("fire-lock");
  });

  it("releaseFireSlot frees the lock so a retry can proceed", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    await claimFireSlot(r);
    await releaseFireSlot(r);
    const retry = await claimFireSlot(r);
    expect(retry.ok).toBe(true);
  });

  it("the next scheduled slot gets its own lock (different nextRunAt → different key)", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const first = await claimFireSlot(r);
    expect(first.ok).toBe(true);
    // Simulate the rule advancing to the next slot after a successful fire.
    const fired = await recordRuleFired(r, 25, Date.now());
    const nextSlot = await claimFireSlot(fired);
    expect(nextSlot.ok).toBe(true);
  });
});

// ── Transient backoff (queue-starvation guard) ───────────────────────────

describe("transient backoff", () => {
  it("recordRuleTransientError pushes the ZSET score forward by TRANSIENT_BACKOFF_MS", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const member = `${TEST_OWNER.toLowerCase()}/${TEST_WALLET.toLowerCase()}/${r.ruleId}`;
    const zset = zsetStore.get(RECURRING_NEXT_ACTION_ZSET)!;
    const scoreBefore = zset.get(member);
    expect(typeof scoreBefore).toBe("number");
    const now = Date.now();
    await recordRuleTransientError(r, "relay 502", now);
    const scoreAfter = zset.get(member);
    expect(scoreAfter).toBe(now + TRANSIENT_BACKOFF_MS);
    // The rule itself is unchanged except for lastError.
    const fresh = (await getRecurringRule(TEST_OWNER, TEST_WALLET, r.ruleId))!;
    expect(fresh.lastError).toBe("relay 502");
    expect(fresh.status).toBe("active");
  });
});

// ── Create idempotency ───────────────────────────────────────────────────

describe("createRecurringRule idempotency", () => {
  it("two creates with the same canonical shape return the same rule (not a duplicate)", async () => {
    const r1 = await createRecurringRule(VALID_INPUT);
    const r2 = await createRecurringRule(VALID_INPUT);
    expect(r2.ruleId).toBe(r1.ruleId);
    const rules = await listRecurringRules(TEST_OWNER, TEST_WALLET);
    expect(rules.length).toBe(1);
  });

  it("different amount → different fingerprint → different rule", async () => {
    const r1 = await createRecurringRule({ ...VALID_INPUT, amount: "25" });
    const r2 = await createRecurringRule({ ...VALID_INPUT, amount: "50" });
    expect(r2.ruleId).not.toBe(r1.ruleId);
    const rules = await listRecurringRules(TEST_OWNER, TEST_WALLET);
    expect(rules.length).toBe(2);
  });

  it("different recipient → different fingerprint → different rule", async () => {
    const otherRecip = "0x4444444444444444444444444444444444444444";
    const r1 = await createRecurringRule(VALID_INPUT);
    const r2 = await createRecurringRule({ ...VALID_INPUT, recipient: otherRecip });
    expect(r2.ruleId).not.toBe(r1.ruleId);
  });
});

// ── ZSET cleanup ─────────────────────────────────────────────────────────

describe("removeFromActionZset", () => {
  it("removes the rule from ZSET without changing its record", async () => {
    const r = await createRecurringRule(VALID_INPUT);
    const member = `${TEST_OWNER.toLowerCase()}/${TEST_WALLET.toLowerCase()}/${r.ruleId}`;
    expect(zsetStore.get(RECURRING_NEXT_ACTION_ZSET)?.has(member)).toBe(true);
    await removeFromActionZset(r);
    expect(zsetStore.get(RECURRING_NEXT_ACTION_ZSET)?.has(member)).toBe(false);
    // Record is intact.
    const fresh = await getRecurringRule(TEST_OWNER, TEST_WALLET, r.ruleId);
    expect(fresh).not.toBeNull();
  });
});
