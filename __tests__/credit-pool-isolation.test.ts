/**
 * credit-pool-isolation.test.ts
 *
 * KV-mocked behavior tests for the two-pool credit model. Source-grep tests
 * (credit-pool-separation.test.ts) cover the wire shape; these tests cover
 * the runtime invariant that the two pools are independent counters.
 *
 * Specifically:
 *   - addScopedCredits writes to quota:{scope}:{addr}, never the opposite pool
 *   - decrementScopedCredit only touches the scope it was called with
 *   - refundScopedCredit only touches the scope it was called with
 *   - getScopedCredits reads the scoped key first, falls back to legacy
 *     ONLY when scope matches the account's plan signal
 *   - opposite-scope legacy fallback returns 0
 *   - seedFromLegacy returns 0 when there's no signal (orphan account)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory KV store ───────────────────────────────────────────────────────
const store = new Map<string, unknown>();

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  // unused but present so any code that touches these doesn't blow up
  sadd: vi.fn(),
  srem: vi.fn(),
  smembers: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hgetall: vi.fn(),
  hincrbyfloat: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

// Stub ops-alert to avoid network in tests.
vi.mock("@/app/lib/ops-alert", () => ({
  sendOpsAlert: vi.fn(() => Promise.resolve()),
}));

import {
  addScopedCredits,
  decrementScopedCredit,
  refundScopedCredit,
  getScopedCredits,
  seedFromLegacy,
} from "@/app/lib/db";

// ── Helpers ───────────────────────────────────────────────────────────────────
function resetStore() {
  store.clear();
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();

  mockKv.get.mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null));

  mockKv.set.mockImplementation((key: string, value: unknown, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(key)) return Promise.resolve(null);
    store.set(key, value);
    return Promise.resolve("OK");
  });

  mockKv.del.mockImplementation((key: string) => {
    const had = store.has(key);
    store.delete(key);
    return Promise.resolve(had ? 1 : 0);
  });

  mockKv.incrby.mockImplementation((key: string, n: number) => {
    const cur = (store.get(key) as number | undefined) ?? 0;
    const next = cur + n;
    store.set(key, next);
    return Promise.resolve(next);
  });

  mockKv.decrby.mockImplementation((key: string, n: number) => {
    const cur = (store.get(key) as number | undefined) ?? 0;
    const next = cur - n;
    store.set(key, next);
    return Promise.resolve(next);
  });
});

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addScopedCredits — writes only to the matching pool", () => {
  it("100 trial + 50 paid yields two independent counters", async () => {
    await addScopedCredits(ADDR, "trial", 100);
    await addScopedCredits(ADDR, "paid", 50);

    expect(await getScopedCredits(ADDR, "trial")).toBe(100);
    expect(await getScopedCredits(ADDR, "paid")).toBe(50);

    // Verify the underlying KV keys are distinct.
    expect(store.get(`quota:trial:${ADDR}`)).toBe(100);
    expect(store.get(`quota:paid:${ADDR}`)).toBe(50);
  });

  it("amount <= 0 is a no-op (returns current scope balance)", async () => {
    await addScopedCredits(ADDR, "trial", 100);
    const res = await addScopedCredits(ADDR, "trial", 0);
    expect(res).toBe(100);
    expect(await getScopedCredits(ADDR, "trial")).toBe(100);
    expect(await getScopedCredits(ADDR, "paid")).toBe(0);
  });
});

describe("decrementScopedCredit — only touches the scope it was called with", () => {
  it("trial decrement does not affect paid pool", async () => {
    await addScopedCredits(ADDR, "trial", 100);
    await addScopedCredits(ADDR, "paid", 50);

    const dec = await decrementScopedCredit(ADDR, "trial");
    expect(dec.ok).toBe(true);
    expect(dec.remaining).toBe(99);

    expect(await getScopedCredits(ADDR, "trial")).toBe(99);
    expect(await getScopedCredits(ADDR, "paid")).toBe(50);
  });

  it("paid decrement does not affect trial pool", async () => {
    await addScopedCredits(ADDR, "trial", 100);
    await addScopedCredits(ADDR, "paid", 50);

    const dec = await decrementScopedCredit(ADDR, "paid");
    expect(dec.ok).toBe(true);
    expect(dec.remaining).toBe(49);

    expect(await getScopedCredits(ADDR, "trial")).toBe(100);
    expect(await getScopedCredits(ADDR, "paid")).toBe(49);
  });

  it("returns ok: false and refunds when balance would go negative", async () => {
    // Seed with 1 then drain — second call must roll back.
    await addScopedCredits(ADDR, "trial", 1);
    const first = await decrementScopedCredit(ADDR, "trial");
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(0);

    const second = await decrementScopedCredit(ADDR, "trial");
    expect(second.ok).toBe(false);
    expect(second.remaining).toBe(0);
    // The over-decrement was rolled back.
    expect(await getScopedCredits(ADDR, "trial")).toBe(0);
  });
});

describe("refundScopedCredit — only touches the scope it was called with", () => {
  it("trial refund does not affect paid pool", async () => {
    await addScopedCredits(ADDR, "trial", 10);
    await addScopedCredits(ADDR, "paid", 20);

    await refundScopedCredit(ADDR, "trial");
    expect(await getScopedCredits(ADDR, "trial")).toBe(11);
    expect(await getScopedCredits(ADDR, "paid")).toBe(20);
  });

  it("paid refund does not affect trial pool", async () => {
    await addScopedCredits(ADDR, "trial", 10);
    await addScopedCredits(ADDR, "paid", 20);

    await refundScopedCredit(ADDR, "paid");
    expect(await getScopedCredits(ADDR, "trial")).toBe(10);
    expect(await getScopedCredits(ADDR, "paid")).toBe(21);
  });
});

describe("seedFromLegacy — safety net routing", () => {
  it("returns 0 when there's no legacy key", async () => {
    expect(await seedFromLegacy(ADDR, "trial")).toBe(0);
    expect(await seedFromLegacy(ADDR, "paid")).toBe(0);
  });

  it("trial-only signal: returns legacy value for trial, 0 for paid", async () => {
    // Pure trial signal: trialApiKey + future trialExpiresAt, no paid signal.
    store.set(`quota:${ADDR}`, 1500);
    store.set(`sub:${ADDR}`, {
      paidAt:         "",
      apiKey:         "",
      plan:           "trial",
      txHash:         "",
      amountUSD:      0,
      trialApiKey:    "q402_live_trial_x",
      trialExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    expect(await seedFromLegacy(ADDR, "trial")).toBe(1500);
    expect(await seedFromLegacy(ADDR, "paid")).toBe(0);
  });

  it("paid-only signal: returns legacy value for paid, 0 for trial", async () => {
    // Paid signal: amountUSD > 0 + paidAt + non-trial plan, no trial key.
    store.set(`quota:${ADDR}`, 750);
    store.set(`sub:${ADDR}`, {
      paidAt:    new Date().toISOString(),
      apiKey:    "q402_live_paid_x",
      plan:      "starter",
      txHash:    "0xdeadbeef",
      amountUSD: 29,
    });

    expect(await seedFromLegacy(ADDR, "paid")).toBe(750);
    expect(await seedFromLegacy(ADDR, "trial")).toBe(0);
  });

  it("hybrid signal: biases legacy to paid (trial stays 0 until reconciliation)", async () => {
    // Both signals present. Safety-net rule: paid pool gets the legacy value,
    // trial pool starts at 0. The reconciliation script does an honest split.
    store.set(`quota:${ADDR}`, 2400);
    store.set(`sub:${ADDR}`, {
      paidAt:         new Date().toISOString(),
      apiKey:         "q402_live_paid_x",
      plan:           "starter",
      txHash:         "0xdeadbeef",
      amountUSD:      29,
      trialApiKey:    "q402_live_trial_x",
      trialExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    expect(await seedFromLegacy(ADDR, "paid")).toBe(2400);
    expect(await seedFromLegacy(ADDR, "trial")).toBe(0);
  });

  it("orphan account (no signals): returns 0 for both scopes", async () => {
    store.set(`quota:${ADDR}`, 500);
    store.set(`sub:${ADDR}`, {
      paidAt: "", apiKey: "", plan: "starter", txHash: "", amountUSD: 0,
    });

    expect(await seedFromLegacy(ADDR, "trial")).toBe(0);
    expect(await seedFromLegacy(ADDR, "paid")).toBe(0);
  });

  it("expired trial signal disqualifies the trial scope", async () => {
    // trialExpiresAt is in the past — trial signal is gone, no paid signal.
    store.set(`quota:${ADDR}`, 1000);
    store.set(`sub:${ADDR}`, {
      paidAt:         "",
      apiKey:         "",
      plan:           "trial",
      txHash:         "",
      amountUSD:      0,
      trialApiKey:    "q402_live_trial_x",
      trialExpiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    expect(await seedFromLegacy(ADDR, "trial")).toBe(0);
    expect(await seedFromLegacy(ADDR, "paid")).toBe(0);
  });
});

describe("getScopedCredits — read priority", () => {
  it("prefers the scoped key when present (ignores legacy)", async () => {
    // Set both the scoped key AND the legacy key. Scoped must win.
    store.set(`quota:trial:${ADDR}`, 42);
    store.set(`quota:${ADDR}`, 9999);
    store.set(`sub:${ADDR}`, {
      paidAt: "", apiKey: "", plan: "trial", txHash: "", amountUSD: 0,
      trialApiKey: "q402_live_trial_x",
      trialExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    expect(await getScopedCredits(ADDR, "trial")).toBe(42);
  });

  it("falls back to legacy only when scope matches the plan signal", async () => {
    // Paid-only signal + no scoped paid key → fallback to legacy.
    store.set(`quota:${ADDR}`, 333);
    store.set(`sub:${ADDR}`, {
      paidAt: new Date().toISOString(),
      apiKey: "q402_live_paid_x",
      plan:   "starter",
      txHash: "0xdeadbeef",
      amountUSD: 29,
    });

    expect(await getScopedCredits(ADDR, "paid")).toBe(333);
    // Opposite scope: 0 (legacy belongs to paid, not trial).
    expect(await getScopedCredits(ADDR, "trial")).toBe(0);
  });
});
