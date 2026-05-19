/**
 * rotate-scope.test.ts
 *
 * Regression cover for the trial/paid scope split in /api/keys/rotate.
 *
 * Prior to this fix the rotate endpoint hard-coded sub.apiKey, so the
 * Dashboard's Trial-view rotate button silently rotated the paid slot —
 * the trial key on screen stayed valid AND the same value, leaving the
 * user with no signal that anything had changed.
 *
 * These tests pin rotateApiKey's new scope param so the right slot
 * always wins, including the pre-Phase-1 legacy shape where the trial
 * key lived in the apiKey slot (plan === "trial" + apiKey set +
 * trialApiKey empty).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, unknown>();

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
  smembers: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hgetall: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));
vi.mock("@/app/lib/ops-alerts", () => ({
  sendOpsAlert: vi.fn(() => Promise.resolve()),
}));

import { rotateApiKey, type Subscription } from "@/app/lib/db";

const ADDR = "0xabcdef0123456789abcdef0123456789abcdef01";

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  mockKv.get.mockImplementation((key: string) =>
    Promise.resolve(store.get(key) ?? null),
  );
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
});

describe("rotateApiKey — scope='paid' (default)", () => {
  it("rotates sub.apiKey and leaves trialApiKey untouched", async () => {
    const initial: Subscription = {
      apiKey: "q402_live_paidkey_old",
      sandboxApiKey: "q402_test_sb",
      plan: "starter",
      paidAt: "2026-05-01T00:00:00Z",
      amountUSD: 29,
      txHash: "0xdeadbeef",
      trialApiKey: "q402_live_trialkey_kept",
    };
    store.set(`sub:${ADDR}`, initial);
    store.set(`apikey:q402_live_paidkey_old`, {
      address: ADDR, createdAt: "x", active: true, plan: "starter",
    });

    const newKey = await rotateApiKey(ADDR, "paid");
    expect(newKey).toMatch(/^q402_live_/);
    expect(newKey).not.toBe("q402_live_paidkey_old");

    const updated = store.get(`sub:${ADDR}`) as Subscription;
    expect(updated.apiKey).toBe(newKey);
    expect(updated.trialApiKey).toBe("q402_live_trialkey_kept");
  });

  it("backwards compatible: default scope (no arg) still rotates paid", async () => {
    store.set(`sub:${ADDR}`, {
      apiKey: "q402_live_paid_v",
      plan: "starter",
      paidAt: "2026-05-01T00:00:00Z",
      amountUSD: 29,
      txHash: "0xx",
      trialApiKey: "q402_live_trial_v",
    });
    store.set(`apikey:q402_live_paid_v`, {
      address: ADDR, createdAt: "x", active: true, plan: "starter",
    });

    const newKey = await rotateApiKey(ADDR);  // default
    const updated = store.get(`sub:${ADDR}`) as Subscription;
    expect(updated.apiKey).toBe(newKey);
    expect(updated.trialApiKey).toBe("q402_live_trial_v");
  });

  it("throws when no paid key exists", async () => {
    store.set(`sub:${ADDR}`, {
      apiKey: "",
      plan: "trial",
      paidAt: "2026-05-19T17:14:23Z",
      amountUSD: 0,
      txHash: "trial",
      trialApiKey: "q402_live_trialonly",
    });
    await expect(rotateApiKey(ADDR, "paid")).rejects.toThrow(/No paid key/);
  });
});

describe("rotateApiKey — scope='trial' (modern post-Phase-1)", () => {
  it("rotates sub.trialApiKey and leaves apiKey untouched", async () => {
    const initial: Subscription = {
      apiKey: "q402_live_paid_keep",
      sandboxApiKey: "q402_test_sb",
      plan: "starter",
      paidAt: "2026-05-01T00:00:00Z",
      amountUSD: 29,
      txHash: "admin_grant:1747671132478",
      trialApiKey: "q402_live_trialkey_old",
      trialSandboxApiKey: "q402_test_trial_sb",
      trialExpiresAt: "2026-06-18T00:00:00Z",
    };
    store.set(`sub:${ADDR}`, initial);
    store.set(`apikey:q402_live_trialkey_old`, {
      address: ADDR, createdAt: "x", active: true, plan: "trial",
    });

    const newKey = await rotateApiKey(ADDR, "trial");
    expect(newKey).toMatch(/^q402_live_/);
    expect(newKey).not.toBe("q402_live_trialkey_old");

    const updated = store.get(`sub:${ADDR}`) as Subscription;
    expect(updated.apiKey).toBe("q402_live_paid_keep");
    expect(updated.trialApiKey).toBe(newKey);
  });

  it("new apikey record carries plan='trial' regardless of sub.plan", async () => {
    store.set(`sub:${ADDR}`, {
      apiKey: "q402_live_paid_x",
      plan: "starter",      // ← paid sub
      paidAt: "2026-05-01T00:00:00Z",
      amountUSD: 29,
      txHash: "0xdead",
      trialApiKey: "q402_live_trial_x",
      trialExpiresAt: "2026-06-18T00:00:00Z",
    });
    store.set(`apikey:q402_live_trial_x`, {
      address: ADDR, createdAt: "x", active: true, plan: "trial",
    });

    const newKey = await rotateApiKey(ADDR, "trial");
    const newRecord = store.get(`apikey:${newKey}`) as { plan: string };
    expect(newRecord.plan).toBe("trial");
  });
});

describe("rotateApiKey — scope='trial' (pre-Phase-1 legacy shape)", () => {
  it("legacy sub (plan='trial' + apiKey + no trialApiKey) rotates the apiKey slot AND migrates both keys forward", async () => {
    // Both halves of a pre-Phase-1 trial sub sat in the paid slots
    // (apiKey + sandboxApiKey were the trial pair). After rotation the
    // live key is replaced AND the sandbox key is moved — not minted
    // fresh — into trialSandboxApiKey. Without that move, the next
    // /api/payment/activate would treat the stale trial sandbox key
    // as the paid sandbox key (it reuses existing.sandboxApiKey when
    // populated), mixing trial and paid scopes on the Dashboard.
    store.set(`sub:${ADDR}`, {
      apiKey: "q402_live_legacy_trial",
      sandboxApiKey: "q402_test_legacy_sb",
      plan: "trial",
      paidAt: "2026-02-10T00:00:00Z",
      amountUSD: 0,
      txHash: "trial",
      trialExpiresAt: "2026-03-10T00:00:00Z",
      // no trialApiKey / trialSandboxApiKey
    });
    store.set(`apikey:q402_live_legacy_trial`, {
      address: ADDR, createdAt: "x", active: true, plan: "trial",
    });

    const newKey = await rotateApiKey(ADDR, "trial");
    const updated = store.get(`sub:${ADDR}`) as Subscription;

    // Live half: rotated into trialApiKey, paid slot cleared.
    expect(updated.trialApiKey).toBe(newKey);
    expect(updated.apiKey).toBe("");

    // Sandbox half: MOVED (not rotated) from paid slot into trial slot
    // so a future paid activation will mint a fresh paid sandbox key
    // into the now-empty sandboxApiKey slot instead of reusing the
    // legacy trial sandbox value.
    expect(updated.trialSandboxApiKey).toBe("q402_test_legacy_sb");
    expect(updated.sandboxApiKey).toBeUndefined();
  });

  it("legacy sub without sandboxApiKey leaves the trial sandbox slot untouched", async () => {
    // The rare legacy variant where the sandbox key was never written
    // (older accounts before sandbox keys were standard). Make sure
    // the migration doesn't synthesize a value.
    store.set(`sub:${ADDR}`, {
      apiKey: "q402_live_legacy_trial",
      plan: "trial",
      paidAt: "2026-02-10T00:00:00Z",
      amountUSD: 0,
      txHash: "trial",
      trialExpiresAt: "2026-03-10T00:00:00Z",
      // no sandboxApiKey, no trialApiKey
    });
    store.set(`apikey:q402_live_legacy_trial`, {
      address: ADDR, createdAt: "x", active: true, plan: "trial",
    });

    const newKey = await rotateApiKey(ADDR, "trial");
    const updated = store.get(`sub:${ADDR}`) as Subscription;
    expect(updated.trialApiKey).toBe(newKey);
    expect(updated.apiKey).toBe("");
    expect(updated.trialSandboxApiKey).toBeUndefined();
    expect(updated.sandboxApiKey).toBeUndefined();
  });

  it("throws when no trial key exists in either slot", async () => {
    store.set(`sub:${ADDR}`, {
      apiKey: "q402_live_paidonly",
      plan: "starter",
      paidAt: "2026-05-01T00:00:00Z",
      amountUSD: 29,
      txHash: "0xdead",
    });
    await expect(rotateApiKey(ADDR, "trial")).rejects.toThrow(/No trial key/);
  });
});

describe("rotateApiKey — distributed lock is scope-aware", () => {
  it("trial and paid rotations do not block each other", async () => {
    // The lock key is per (scope, address), so simulating a held paid
    // lock should not prevent a trial rotation from starting.
    store.set(`sub:${ADDR}`, {
      apiKey: "q402_live_paid",
      plan: "starter",
      paidAt: "2026-05-01T00:00:00Z",
      amountUSD: 29,
      txHash: "0xdead",
      trialApiKey: "q402_live_trial",
      trialExpiresAt: "2026-06-18T00:00:00Z",
    });
    store.set(`apikey:q402_live_trial`, {
      address: ADDR, createdAt: "x", active: true, plan: "trial",
    });
    // Pre-claim the paid lock as if another tab were rotating.
    store.set(`rotation_pending:paid:${ADDR}`, "1");

    // Trial rotation should still succeed.
    const newKey = await rotateApiKey(ADDR, "trial");
    expect(newKey).toMatch(/^q402_live_/);
    expect(newKey).not.toBe("q402_live_trial");
  });
});
