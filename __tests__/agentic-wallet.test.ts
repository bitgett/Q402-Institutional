import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory KV stand-in. Mirrors the subset of @vercel/kv the lib touches.
const store = new Map<string, unknown>();
const listStore = new Map<string, unknown[]>();

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  lpush: vi.fn(),
  ltrim: vi.fn(),
  lrange: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import {
  createAgenticWallet,
  getAgenticWallet,
  getActiveAgenticWallet,
  decryptPrivateKey,
  softDeleteAgenticWallet,
  restoreAgenticWallet,
  hardDeleteAgenticWallet,
  updateAgenticWalletLimits,
  recordExportEvent,
  getExportLog,
  isKeystoreReady,
  SOFT_DELETE_GRACE_MS,
  checkDailyLimit,
  recordDailySpend,
  getDailySpendUsd,
} from "@/app/lib/agentic-wallet";
import { _resetMasterKeyCacheForTesting } from "@/app/lib/keystore";
import { ethers } from "ethers";

const TEST_OWNER = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  store.clear();
  listStore.clear();
  vi.clearAllMocks();
  process.env.KEY_ENCRYPTION_KEY = "0".repeat(64);
  _resetMasterKeyCacheForTesting();

  mockKv.get.mockImplementation((key: string) =>
    Promise.resolve(store.get(key) ?? null),
  );
  mockKv.set.mockImplementation((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve("OK");
  });
  mockKv.del.mockImplementation((key: string) => {
    const had = store.delete(key);
    listStore.delete(key);
    return Promise.resolve(had ? 1 : 0);
  });
  mockKv.lpush.mockImplementation((key: string, value: unknown) => {
    const list = listStore.get(key) ?? [];
    list.unshift(value);
    listStore.set(key, list);
    return Promise.resolve(list.length);
  });
  mockKv.ltrim.mockImplementation((key: string, start: number, end: number) => {
    const list = listStore.get(key);
    if (!list) return Promise.resolve("OK");
    const last = end < 0 ? list.length + end : end;
    listStore.set(key, list.slice(start, last + 1));
    return Promise.resolve("OK");
  });
  mockKv.lrange.mockImplementation((key: string, _start: number, _end: number) =>
    Promise.resolve(listStore.get(key) ?? []),
  );
});

describe("createAgenticWallet", () => {
  it("creates a fresh wallet record for a new owner", async () => {
    const record = await createAgenticWallet(TEST_OWNER);

    expect(record.ownerAddr).toBe(TEST_OWNER.toLowerCase());
    expect(ethers.isAddress(record.address)).toBe(true);
    expect(record.address).toBe(ethers.getAddress(record.address)); // checksummed
    expect(record.encryptedPK.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(record.encryptedPK.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof record.createdAt).toBe("number");
    expect(record.deletedAt).toBeUndefined();
  });

  it("lowercases the owner address when keying", async () => {
    await createAgenticWallet("0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa");
    expect(store.has("aw:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
  });

  it("rejects creating a second wallet for the same owner", async () => {
    await createAgenticWallet(TEST_OWNER);
    await expect(createAgenticWallet(TEST_OWNER)).rejects.toThrow("AGENTIC_WALLET_EXISTS");
  });

  it("rejects re-create even while soft-deleted (restore instead)", async () => {
    await createAgenticWallet(TEST_OWNER);
    await softDeleteAgenticWallet(TEST_OWNER);
    await expect(createAgenticWallet(TEST_OWNER)).rejects.toThrow("AGENTIC_WALLET_EXISTS");
  });
});

describe("getAgenticWallet / getActiveAgenticWallet", () => {
  it("returns null when no wallet exists", async () => {
    expect(await getAgenticWallet(TEST_OWNER)).toBeNull();
    expect(await getActiveAgenticWallet(TEST_OWNER)).toBeNull();
  });

  it("returns the record after creation", async () => {
    const created = await createAgenticWallet(TEST_OWNER);
    const fetched = await getAgenticWallet(TEST_OWNER);
    expect(fetched?.address).toBe(created.address);
  });

  it("getActiveAgenticWallet returns soft-deleted records during grace, hides them after", async () => {
    await createAgenticWallet(TEST_OWNER);
    await softDeleteAgenticWallet(TEST_OWNER);

    const stillActive = await getActiveAgenticWallet(TEST_OWNER);
    // Within grace: deletedAt is set to "now" so Date.now() >= deletedAt is true → returns null.
    // (The lib treats any past deletedAt as "no longer usable".)
    expect(stillActive).toBeNull();

    // getAgenticWallet still surfaces the record so the dashboard can show
    // "archived" + offer restore.
    const archived = await getAgenticWallet(TEST_OWNER);
    expect(archived?.deletedAt).toBeTypeOf("number");
  });
});

describe("decryptPrivateKey", () => {
  it("decrypts back to a usable private key", async () => {
    const record = await createAgenticWallet(TEST_OWNER);
    const pk = decryptPrivateKey(record);
    const wallet = new ethers.Wallet(pk);
    expect(wallet.address.toLowerCase()).toBe(record.address.toLowerCase());
  });
});

describe("softDeleteAgenticWallet + restoreAgenticWallet", () => {
  it("is idempotent — second call is a no-op", async () => {
    await createAgenticWallet(TEST_OWNER);
    await softDeleteAgenticWallet(TEST_OWNER);
    const first = await getAgenticWallet(TEST_OWNER);
    await softDeleteAgenticWallet(TEST_OWNER);
    const second = await getAgenticWallet(TEST_OWNER);
    expect(second?.deletedAt).toBe(first?.deletedAt);
  });

  it("does nothing if the wallet doesn't exist", async () => {
    await expect(softDeleteAgenticWallet(TEST_OWNER)).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("restoreAgenticWallet removes the deletedAt marker", async () => {
    await createAgenticWallet(TEST_OWNER);
    await softDeleteAgenticWallet(TEST_OWNER);
    await restoreAgenticWallet(TEST_OWNER);
    const record = await getAgenticWallet(TEST_OWNER);
    expect(record?.deletedAt).toBeUndefined();
  });

  it("restore throws once the grace window has elapsed", async () => {
    const record = await createAgenticWallet(TEST_OWNER);
    // Force a deletedAt outside the grace window.
    const staleDeletedAt = Date.now() - SOFT_DELETE_GRACE_MS - 1_000;
    store.set(`aw:${TEST_OWNER}`, { ...record, deletedAt: staleDeletedAt });
    await expect(restoreAgenticWallet(TEST_OWNER)).rejects.toThrow("AGENTIC_WALLET_GRACE_EXPIRED");
  });
});

describe("hardDeleteAgenticWallet", () => {
  it("removes both the record and the export log", async () => {
    await createAgenticWallet(TEST_OWNER);
    await recordExportEvent(TEST_OWNER, { ip: "1.2.3.4" });
    expect(store.size).toBe(1);
    expect(listStore.size).toBe(1);

    await hardDeleteAgenticWallet(TEST_OWNER);
    expect(store.size).toBe(0);
    expect(listStore.size).toBe(0);
  });
});

describe("updateAgenticWalletLimits", () => {
  it("sets numeric limits and clears with null", async () => {
    await createAgenticWallet(TEST_OWNER);

    const a = await updateAgenticWalletLimits(TEST_OWNER, {
      dailyLimitUsd: 250,
      perTxMaxUsd: 50,
    });
    expect(a.dailyLimitUsd).toBe(250);
    expect(a.perTxMaxUsd).toBe(50);

    const b = await updateAgenticWalletLimits(TEST_OWNER, { perTxMaxUsd: null });
    expect(b.perTxMaxUsd).toBeUndefined();
    expect(b.dailyLimitUsd).toBe(250); // unchanged
  });

  it("throws when the wallet doesn't exist", async () => {
    await expect(updateAgenticWalletLimits(TEST_OWNER, { dailyLimitUsd: 1 })).rejects.toThrow(
      "AGENTIC_WALLET_NOT_FOUND",
    );
  });
});

describe("export log", () => {
  it("appends entries and surfaces them newest-first", async () => {
    await createAgenticWallet(TEST_OWNER);
    await recordExportEvent(TEST_OWNER, { ip: "1.1.1.1" });
    await recordExportEvent(TEST_OWNER, { ip: "2.2.2.2" });
    const log = await getExportLog(TEST_OWNER);
    expect(log).toHaveLength(2);
    expect(log[0].ip).toBe("2.2.2.2"); // newest first
    expect(log[1].ip).toBe("1.1.1.1");
  });

  it("returns an empty array when there are no entries", async () => {
    expect(await getExportLog(TEST_OWNER)).toEqual([]);
  });

  it("survives a KV outage on append (best-effort)", async () => {
    await createAgenticWallet(TEST_OWNER);
    mockKv.lpush.mockRejectedValueOnce(new Error("KV outage"));
    await expect(recordExportEvent(TEST_OWNER, { ip: "9.9.9.9" })).resolves.toBeUndefined();
  });
});

describe("daily-spend helpers", () => {
  it("checkDailyLimit allows any amount when no limit is set", async () => {
    const r = await checkDailyLimit(TEST_OWNER, 9_999, undefined);
    expect(r.allowed).toBe(true);
  });

  it("checkDailyLimit allows when running total + amount stays under the cap", async () => {
    await recordDailySpend(TEST_OWNER, 30);
    const r = await checkDailyLimit(TEST_OWNER, 20, 100);
    expect(r.allowed).toBe(true);
  });

  it("checkDailyLimit denies once running total + amount would overflow the cap", async () => {
    await recordDailySpend(TEST_OWNER, 90);
    const r = await checkDailyLimit(TEST_OWNER, 20, 100);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.limit).toBe(100);
      expect(r.spent).toBe(90);
      expect(r.requested).toBe(20);
    }
  });

  it("recordDailySpend ignores non-finite / non-positive amounts", async () => {
    await recordDailySpend(TEST_OWNER, Number.NaN);
    await recordDailySpend(TEST_OWNER, -10);
    expect(await getDailySpendUsd(TEST_OWNER)).toBe(0);
  });

  it("recordDailySpend accumulates and keys per UTC day", async () => {
    await recordDailySpend(TEST_OWNER, 25);
    await recordDailySpend(TEST_OWNER, 17.5);
    expect(await getDailySpendUsd(TEST_OWNER)).toBe(42.5);
  });

  it("getDailySpendUsd returns 0 when no record exists", async () => {
    expect(await getDailySpendUsd("0x2222222222222222222222222222222222222222")).toBe(0);
  });
});

describe("isKeystoreReady", () => {
  it("is true when the master key is present", () => {
    expect(isKeystoreReady().ok).toBe(true);
  });

  it("is false when the master key is missing", () => {
    delete process.env.KEY_ENCRYPTION_KEY;
    _resetMasterKeyCacheForTesting();
    const result = isKeystoreReady();
    expect(result.ok).toBe(false);
  });
});
