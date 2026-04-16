/**
 * db-rotate.test.ts
 *
 * Verifies the safe-ordering of rotateApiKey():
 *   new key created → subscription updated → old key deactivated
 *
 * Critical invariant: if setSubscription fails, the old key must still be
 * active so the user is never locked out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── KV mock (hoisted so vi.mock factory can reference it) ────────────────────
const mockKv = vi.hoisted(() => ({
  get:    vi.fn(),
  set:    vi.fn(),
  del:    vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

// ── crypto mock (generateApiKey uses randomBytes) ────────────────────────────
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn(() => Buffer.from("aabbccddeeff00112233445566778899aabbccdd", "hex")),
  };
});

import { rotateApiKey } from "@/app/lib/db";

// ── helpers ───────────────────────────────────────────────────────────────────

const ADDR = "0xtest";
const OLD_KEY = "q402_live_old_key";

const SUBSCRIPTION = {
  paidAt:    "2026-01-01T00:00:00.000Z",
  apiKey:    OLD_KEY,
  plan:      "pro",
  txHash:    "0xabc",
  amountUSD: 149,
};

const OLD_KEY_RECORD = {
  address:   ADDR,
  createdAt: "2026-01-01T00:00:00.000Z",
  active:    true,
  plan:      "pro",
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("rotateApiKey — safe ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock: get subscription, get old key record, NX lock succeeds
    mockKv.get.mockImplementation((key: string) => {
      if (key.includes("sub:"))           return Promise.resolve(SUBSCRIPTION);
      if (key.includes(OLD_KEY))          return Promise.resolve(OLD_KEY_RECORD);
      return Promise.resolve(null);
    });
    mockKv.set.mockResolvedValue("OK");
    mockKv.del.mockResolvedValue(1);
  });

  it("returns a new API key on success", async () => {
    const newKey = await rotateApiKey(ADDR);
    expect(newKey).toMatch(/^q402_live_/);
  });

  it("creates new key BEFORE updating subscription", async () => {
    const callOrder: string[] = [];
    mockKv.set.mockImplementation((key: string) => {
      if (key.startsWith("apikey:"))  callOrder.push("new_key_created");
      if (key.startsWith("sub:"))     callOrder.push("subscription_updated");
      if (key.startsWith("rotation")) callOrder.push("lock");
      return Promise.resolve("OK");
    });

    await rotateApiKey(ADDR);

    const newKeyIdx = callOrder.indexOf("new_key_created");
    const subIdx    = callOrder.indexOf("subscription_updated");
    expect(newKeyIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThan(newKeyIdx);
  });

  it("does NOT deactivate old key if setSubscription throws", async () => {
    let newKeyCreated = false;
    mockKv.set.mockImplementation((key: string, value: unknown) => {
      // NX lock: succeed
      if (key.startsWith("rotation")) return Promise.resolve("OK");
      // New key record: succeed
      if (key.startsWith("apikey:") && (value as { active?: boolean })?.active !== false) {
        newKeyCreated = true;
        return Promise.resolve("OK");
      }
      // Subscription update: fail
      if (key.startsWith("sub:")) return Promise.reject(new Error("KV failure"));
      return Promise.resolve("OK");
    });

    await expect(rotateApiKey(ADDR)).rejects.toThrow("KV failure");

    // Old key deactivation is a set with active: false — must not have been called
    const deactivateCalls = mockKv.set.mock.calls.filter(
      ([key, val]) =>
        typeof key === "string" &&
        key.startsWith("apikey:") &&
        (val as { active?: boolean })?.active === false
    );
    expect(deactivateCalls).toHaveLength(0);
    expect(newKeyCreated).toBe(true); // new key was created but old key stays valid
  });

  it("rejects concurrent rotation (NX lock already held)", async () => {
    mockKv.set.mockImplementation((key: string) => {
      if (key.startsWith("rotation")) return Promise.resolve(null); // NX fails
      return Promise.resolve("OK");
    });

    await expect(rotateApiKey(ADDR)).rejects.toThrow("already in progress");
  });

  it("releases the rotation lock in the finally block on success", async () => {
    await rotateApiKey(ADDR);
    const delCalls = mockKv.del.mock.calls.map(([k]) => k as string);
    expect(delCalls.some(k => k.startsWith("rotation_pending:"))).toBe(true);
  });

  it("releases the rotation lock in the finally block on failure", async () => {
    mockKv.set.mockImplementation((key: string) => {
      if (key.startsWith("rotation")) return Promise.resolve("OK");
      if (key.startsWith("sub:"))     return Promise.reject(new Error("fail"));
      return Promise.resolve("OK");
    });

    await expect(rotateApiKey(ADDR)).rejects.toThrow();

    const delCalls = mockKv.del.mock.calls.map(([k]) => k as string);
    expect(delCalls.some(k => k.startsWith("rotation_pending:"))).toBe(true);
  });
});
