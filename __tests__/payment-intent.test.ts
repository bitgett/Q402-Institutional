/**
 * payment-intent.test.ts
 *
 * Covers the per-intentId storage layout in app/lib/payment-intent.ts:
 *
 *  - `getPaymentIntent(addr, intentId)` resolves the id-keyed record directly,
 *    letting concurrent tabs activate without overwriting each other.
 *  - `getPaymentIntent(addr)` without an id follows the latest pointer.
 *  - Legacy address-keyed records are still readable during migration.
 *  - `clearPaymentIntent` removes id/legacy keys and clears the pointer
 *    only when it still points at the same intent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("@vercel/kv", () => ({
  kv: {
    get: vi.fn(async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  },
}));

import {
  getPaymentIntent,
  clearPaymentIntent,
  intentByIdKey,
  intentLatestKey,
  intentKey,
  type PaymentIntent,
} from "@/app/lib/payment-intent";

function makeIntent(addr: string, intentId: string, expectedUSD = 149): PaymentIntent {
  return {
    intentId,
    chain:         "bnb",
    expectedUSD,
    token:         null,
    address:       addr.toLowerCase(),
    createdAt:     new Date().toISOString(),
    planChain:     "bnb",
    quotedPlan:    "pro",
    quotedCredits: 10_000,
  };
}

beforeEach(() => {
  store.clear();
});

describe("getPaymentIntent — multi-tab concurrent intents", () => {
  const addr = "0xabc0000000000000000000000000000000000001";

  it("returns the id-keyed record when intentId is supplied", async () => {
    const a = makeIntent(addr, "aaaaaaaa");
    const b = makeIntent(addr, "bbbbbbbb", 199);
    store.set(intentByIdKey(a.intentId), a);
    store.set(intentByIdKey(b.intentId), b);
    store.set(intentLatestKey(addr), b.intentId);

    // Tab A activates with its own intentId even though the latest pointer
    // has moved to Tab B — must still resolve Tab A's quote.
    expect(await getPaymentIntent(addr, a.intentId)).toEqual(a);
    expect(await getPaymentIntent(addr, b.intentId)).toEqual(b);
  });

  it("follows the latest pointer when no intentId is supplied", async () => {
    const a = makeIntent(addr, "aaaaaaaa");
    const b = makeIntent(addr, "bbbbbbbb", 199);
    store.set(intentByIdKey(a.intentId), a);
    store.set(intentByIdKey(b.intentId), b);
    store.set(intentLatestKey(addr), b.intentId);

    expect(await getPaymentIntent(addr)).toEqual(b);
  });

  it("returns null when the requested intentId has expired", async () => {
    expect(await getPaymentIntent(addr, "ghostid")).toBeNull();
  });
});

describe("getPaymentIntent — legacy address-keyed fallback", () => {
  const addr = "0xabc0000000000000000000000000000000000002";

  it("reads legacy record when no id-keyed record or pointer exists", async () => {
    const legacy = makeIntent(addr, "legacy01");
    store.set(intentKey(addr), legacy);

    expect(await getPaymentIntent(addr)).toEqual(legacy);
  });

  it("falls back to legacy record when id-keyed lookup misses", async () => {
    const legacy = makeIntent(addr, "legacy02");
    store.set(intentKey(addr), legacy);

    // Client sends an intentId that was never stored under the new layout —
    // fall through to the legacy row so in-flight intents survive migration.
    expect(await getPaymentIntent(addr, "legacy02")).toEqual(legacy);
  });
});

describe("clearPaymentIntent", () => {
  const addr = "0xabc0000000000000000000000000000000000003";

  it("removes the id-keyed record and the legacy record", async () => {
    const intent = makeIntent(addr, "deadbeef");
    store.set(intentByIdKey(intent.intentId), intent);
    store.set(intentKey(addr), intent);
    store.set(intentLatestKey(addr), intent.intentId);

    await clearPaymentIntent(addr, intent.intentId);

    expect(store.has(intentByIdKey(intent.intentId))).toBe(false);
    expect(store.has(intentKey(addr))).toBe(false);
    expect(store.has(intentLatestKey(addr))).toBe(false);
  });

  it("preserves latest pointer when it has moved to a newer intent", async () => {
    const older = makeIntent(addr, "olderone");
    const newer = makeIntent(addr, "newerone", 199);
    store.set(intentByIdKey(older.intentId), older);
    store.set(intentByIdKey(newer.intentId), newer);
    store.set(intentLatestKey(addr), newer.intentId);

    // Activating the older intent must not wipe the pointer to the newer one.
    await clearPaymentIntent(addr, older.intentId);

    expect(store.has(intentByIdKey(older.intentId))).toBe(false);
    expect(store.has(intentByIdKey(newer.intentId))).toBe(true);
    expect(store.get(intentLatestKey(addr))).toBe(newer.intentId);
  });
});
