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
  incrbyfloat: vi.fn(),
  incrby: vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import {
  createAgenticWallet,
  getAgenticWallet,
  getActiveAgenticWallet,
  listAgenticWallets,
  countAgenticWallets,
  getDefaultAgenticWallet,
  resolveWallet,
  decryptPrivateKey,
  softDeleteAgenticWallet,
  restoreAgenticWallet,
  hardDeleteAgenticWallet,
  updateAgenticWalletLimits,
  recordExportEvent,
  getExportLog,
  isKeystoreReady,
  SOFT_DELETE_GRACE_MS,
  MAX_WALLETS_PER_OWNER,
  TRIAL_WALLET_CAP,
  checkDailyLimit,
  recordDailySpend,
  getDailySpendUsd,
  chargeAgainstDailyLimit,
  refundDailySpend,
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
  mockKv.set.mockImplementation((key: string, value: unknown, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(key)) return Promise.resolve(null);
    store.set(key, value);
    return Promise.resolve("OK");
  });
  mockKv.incrbyfloat.mockImplementation((key: string, delta: number) => {
    const current = typeof store.get(key) === "number" ? (store.get(key) as number) : 0;
    const next = current + delta;
    store.set(key, next);
    return Promise.resolve(next);
  });
  // Daily-spend now uses INCRBY against integer cents (no float drift).
  mockKv.incrby.mockImplementation((key: string, delta: number) => {
    const current = typeof store.get(key) === "number" ? (store.get(key) as number) : 0;
    const next = current + delta;
    store.set(key, next);
    return Promise.resolve(next);
  });
  mockKv.expire.mockImplementation(() => Promise.resolve(1));
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

// ── Helpers ─────────────────────────────────────────────────────────────

async function makeWallet(owner: string = TEST_OWNER) {
  return await createAgenticWallet(owner);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("createAgenticWallet (multi-wallet v2)", () => {
  it("creates a fresh wallet record for a new owner", async () => {
    const record = await makeWallet();

    expect(record.ownerAddr).toBe(TEST_OWNER.toLowerCase());
    expect(ethers.isAddress(record.address)).toBe(true);
    expect(record.address).toBe(ethers.getAddress(record.address));
    expect(record.encryptedPK.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(record.encryptedPK.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof record.createdAt).toBe("number");
    expect(record.deletedAt).toBeUndefined();
  });

  it("writes under aw:{owner}:{walletId}, not legacy aw:{owner}", async () => {
    const record = await makeWallet();
    const walletId = record.address.toLowerCase();
    expect(store.has(`aw:${TEST_OWNER.toLowerCase()}:${walletId}`)).toBe(true);
    // Legacy single-wallet key should NOT be written by new code.
    expect(store.has(`aw:${TEST_OWNER.toLowerCase()}`)).toBe(false);
  });

  it("registers the wallet in the owner's list + default index", async () => {
    const record = await makeWallet();
    const walletId = record.address.toLowerCase();
    const list = store.get(`aw:list:${TEST_OWNER.toLowerCase()}`) as string[];
    expect(list).toEqual([walletId]);
    expect(store.get(`aw:default:${TEST_OWNER.toLowerCase()}`)).toBe(walletId);
  });

  it("allows up to MAX_WALLETS_PER_OWNER", async () => {
    for (let i = 0; i < MAX_WALLETS_PER_OWNER; i++) {
      await makeWallet();
    }
    expect(await countAgenticWallets(TEST_OWNER)).toBe(MAX_WALLETS_PER_OWNER);
    await expect(makeWallet()).rejects.toThrow("AGENTIC_WALLET_CAP_REACHED");
  });

  it("respects the trial cap when supplied", async () => {
    await createAgenticWallet(TEST_OWNER, { cap: TRIAL_WALLET_CAP });
    await expect(
      createAgenticWallet(TEST_OWNER, { cap: TRIAL_WALLET_CAP }),
    ).rejects.toThrow("AGENTIC_WALLET_CAP_REACHED");
  });

  it("attaches an optional label", async () => {
    const record = await createAgenticWallet(TEST_OWNER, { label: "Trading bot" });
    expect(record.label).toBe("Trading bot");
  });

  it("uses a SET NX create-lock so concurrent creates serialise (no orphans, no cap-bypass)", async () => {
    // Simulate a slow critical section — the second create lands while
    // the first holds the lock. The lock model must reject the racer
    // with AGENTIC_WALLET_CREATE_LOCKED rather than letting both
    // create-paths run interleaved (the old behaviour).
    //
    // The in-memory KV mock honours `nx: true`; the lock is just a
    // SET NX on `aw:create-lock:{owner}`, so calling createAgenticWallet
    // while the lock key is already set must throw.
    const owner = TEST_OWNER.toLowerCase();
    // Seed the lock as if another in-flight call holds it.
    store.set(`aw:create-lock:${owner}`, "1");
    await expect(createAgenticWallet(TEST_OWNER)).rejects.toThrow("AGENTIC_WALLET_CREATE_LOCKED");
    // Cleanup — release the simulated lock and confirm a subsequent
    // create now succeeds, verifying the lock isn't sticky.
    store.delete(`aw:create-lock:${owner}`);
    const ok = await createAgenticWallet(TEST_OWNER);
    expect(ok.address).toBeTruthy();
  });

  it("releases the create-lock after a normal create completes", async () => {
    const owner = TEST_OWNER.toLowerCase();
    await createAgenticWallet(TEST_OWNER);
    // Lock key must not survive past the finally{} branch — a sticky
    // lock would prevent the owner from ever creating a second wallet
    // until the 10s TTL expired.
    expect(store.has(`aw:create-lock:${owner}`)).toBe(false);
  });
});

describe("listAgenticWallets / countAgenticWallets / getDefaultAgenticWallet", () => {
  it("returns empty list for a brand new owner", async () => {
    expect(await listAgenticWallets(TEST_OWNER)).toEqual([]);
    expect(await countAgenticWallets(TEST_OWNER)).toBe(0);
    expect(await getDefaultAgenticWallet(TEST_OWNER)).toBeNull();
  });

  it("lists wallets in creation order", async () => {
    const a = await makeWallet();
    const b = await makeWallet();
    const c = await makeWallet();
    const list = await listAgenticWallets(TEST_OWNER);
    expect(list.map((w) => w.address)).toEqual([a.address, b.address, c.address]);
  });

  it("default resolves to the first wallet", async () => {
    const a = await makeWallet();
    await makeWallet();
    const def = await getDefaultAgenticWallet(TEST_OWNER);
    expect(def?.address).toBe(a.address);
  });

  it("default skips soft-deleted wallet and falls through to the next active", async () => {
    const a = await makeWallet();
    const b = await makeWallet();
    await softDeleteAgenticWallet(TEST_OWNER, a.address);
    const def = await getDefaultAgenticWallet(TEST_OWNER);
    expect(def?.address).toBe(b.address);
  });
});

describe("lazy migration from v1 → v2 schema", () => {
  it("promotes a pre-existing legacy record to v2 on first listAgenticWallets call", async () => {
    // Seed legacy single-wallet record.
    const legacyAddr = ethers.getAddress("0x" + "ab".repeat(20));
    const legacyOwner = TEST_OWNER.toLowerCase();
    const legacyRecord = {
      ownerAddr: legacyOwner,
      address: legacyAddr,
      encryptedPK: { ciphertext: "deadbeef", nonce: "f".repeat(24), tag: "0".repeat(32), version: 1 },
      createdAt: 1_700_000_000_000,
    };
    store.set(`aw:${legacyOwner}`, legacyRecord);

    const list = await listAgenticWallets(TEST_OWNER);
    expect(list).toHaveLength(1);
    expect(list[0].address).toBe(legacyAddr);

    // After migration, the new keys should exist.
    expect(store.has(`aw:${legacyOwner}:${legacyAddr.toLowerCase()}`)).toBe(true);
    expect(store.get(`aw:list:${legacyOwner}`)).toEqual([legacyAddr.toLowerCase()]);
    expect(store.get(`aw:default:${legacyOwner}`)).toBe(legacyAddr.toLowerCase());
  });

  it("doesn't migrate if no legacy record exists", async () => {
    const list = await listAgenticWallets(TEST_OWNER);
    expect(list).toEqual([]);
    expect(store.size).toBe(0);
  });
});

describe("getAgenticWallet / getActiveAgenticWallet", () => {
  it("returns null when no wallet exists", async () => {
    expect(
      await getAgenticWallet(TEST_OWNER, "0x" + "0".repeat(40)),
    ).toBeNull();
  });

  it("refuses cross-owner reads — walletId not in list returns null", async () => {
    const a = await makeWallet("0xAAAA000000000000000000000000000000000001");
    // Different owner tries to load wallet A.
    const stolen = await getAgenticWallet(TEST_OWNER, a.address);
    expect(stolen).toBeNull();
  });

  it("returns the record after creation", async () => {
    const created = await makeWallet();
    const fetched = await getAgenticWallet(TEST_OWNER, created.address);
    expect(fetched?.address).toBe(created.address);
  });

  it("getActiveAgenticWallet hides soft-deleted (deletedAt <= now)", async () => {
    const created = await makeWallet();
    await softDeleteAgenticWallet(TEST_OWNER, created.address);

    expect(await getActiveAgenticWallet(TEST_OWNER, created.address)).toBeNull();
    // Plain getAgenticWallet still surfaces the record so the dashboard
    // can render "archived" + offer restore.
    const archived = await getAgenticWallet(TEST_OWNER, created.address);
    expect(archived?.deletedAt).toBeTypeOf("number");
  });
});

describe("decryptPrivateKey", () => {
  it("decrypts back to a usable private key", async () => {
    const record = await makeWallet();
    const pk = decryptPrivateKey(record);
    const wallet = new ethers.Wallet(pk);
    expect(wallet.address.toLowerCase()).toBe(record.address.toLowerCase());
  });
});

describe("softDeleteAgenticWallet + restoreAgenticWallet", () => {
  it("is idempotent — second call is a no-op", async () => {
    const created = await makeWallet();
    await softDeleteAgenticWallet(TEST_OWNER, created.address);
    const first = await getAgenticWallet(TEST_OWNER, created.address);
    await softDeleteAgenticWallet(TEST_OWNER, created.address);
    const second = await getAgenticWallet(TEST_OWNER, created.address);
    expect(second?.deletedAt).toBe(first?.deletedAt);
  });

  it("does nothing if the wallet doesn't exist", async () => {
    await expect(
      softDeleteAgenticWallet(TEST_OWNER, "0x" + "0".repeat(40)),
    ).resolves.toBeUndefined();
  });

  it("restoreAgenticWallet removes the deletedAt marker", async () => {
    const created = await makeWallet();
    await softDeleteAgenticWallet(TEST_OWNER, created.address);
    await restoreAgenticWallet(TEST_OWNER, created.address);
    const record = await getAgenticWallet(TEST_OWNER, created.address);
    expect(record?.deletedAt).toBeUndefined();
  });

  it("restore throws once the grace window has elapsed", async () => {
    const created = await makeWallet();
    const walletKey = `aw:${TEST_OWNER.toLowerCase()}:${created.address.toLowerCase()}`;
    const stale = Date.now() - SOFT_DELETE_GRACE_MS - 1_000;
    store.set(walletKey, { ...created, deletedAt: stale });
    await expect(
      restoreAgenticWallet(TEST_OWNER, created.address),
    ).rejects.toThrow("AGENTIC_WALLET_GRACE_EXPIRED");
  });
});

describe("hardDeleteAgenticWallet", () => {
  it("removes record, export log, and updates list + default", async () => {
    const a = await makeWallet();
    const b = await makeWallet();
    await recordExportEvent(TEST_OWNER, a.address, { ip: "1.2.3.4" });

    await hardDeleteAgenticWallet(TEST_OWNER, a.address);

    // Wallet record + audit log gone.
    expect(
      store.has(`aw:${TEST_OWNER.toLowerCase()}:${a.address.toLowerCase()}`),
    ).toBe(false);
    expect(
      listStore.has(`aw:export-log:${TEST_OWNER.toLowerCase()}:${a.address.toLowerCase()}`),
    ).toBe(false);
    // List updated and default re-elected to surviving wallet.
    expect(store.get(`aw:list:${TEST_OWNER.toLowerCase()}`)).toEqual([
      b.address.toLowerCase(),
    ]);
    expect(store.get(`aw:default:${TEST_OWNER.toLowerCase()}`)).toBe(
      b.address.toLowerCase(),
    );
  });

  it("clears the default + list keys when the last wallet is removed", async () => {
    const a = await makeWallet();
    await hardDeleteAgenticWallet(TEST_OWNER, a.address);
    expect(store.has(`aw:list:${TEST_OWNER.toLowerCase()}`)).toBe(false);
    expect(store.has(`aw:default:${TEST_OWNER.toLowerCase()}`)).toBe(false);
  });
});

describe("updateAgenticWalletLimits", () => {
  it("sets numeric limits and clears with null", async () => {
    const w = await makeWallet();

    const a = await updateAgenticWalletLimits(TEST_OWNER, w.address, {
      dailyLimitUsd: 250,
      perTxMaxUsd: 50,
    });
    expect(a.dailyLimitUsd).toBe(250);
    expect(a.perTxMaxUsd).toBe(50);

    const b = await updateAgenticWalletLimits(TEST_OWNER, w.address, { perTxMaxUsd: null });
    expect(b.perTxMaxUsd).toBeUndefined();
    expect(b.dailyLimitUsd).toBe(250);
  });

  it("updates the label", async () => {
    const w = await makeWallet();
    const next = await updateAgenticWalletLimits(TEST_OWNER, w.address, { label: "Renamed" });
    expect(next.label).toBe("Renamed");
    const cleared = await updateAgenticWalletLimits(TEST_OWNER, w.address, { label: null });
    expect(cleared.label).toBeUndefined();
  });

  it("throws when the wallet doesn't exist", async () => {
    await expect(
      updateAgenticWalletLimits(TEST_OWNER, "0x" + "0".repeat(40), { dailyLimitUsd: 1 }),
    ).rejects.toThrow("AGENTIC_WALLET_NOT_FOUND");
  });
});

describe("export log (per-wallet)", () => {
  it("appends entries and surfaces them newest-first", async () => {
    const w = await makeWallet();
    await recordExportEvent(TEST_OWNER, w.address, { ip: "1.1.1.1" });
    await recordExportEvent(TEST_OWNER, w.address, { ip: "2.2.2.2" });
    const log = await getExportLog(TEST_OWNER, w.address);
    expect(log).toHaveLength(2);
    expect(log[0].ip).toBe("2.2.2.2");
    expect(log[1].ip).toBe("1.1.1.1");
  });

  it("returns an empty array when there are no entries", async () => {
    const w = await makeWallet();
    expect(await getExportLog(TEST_OWNER, w.address)).toEqual([]);
  });

  it("recordExportEvent rethrows on KV failure (audit P1 #5)", async () => {
    const w = await makeWallet();
    mockKv.lpush.mockRejectedValueOnce(new Error("KV outage"));
    await expect(
      recordExportEvent(TEST_OWNER, w.address, { ip: "9.9.9.9" }),
    ).rejects.toThrow("KV outage");
  });

  it("logs from wallet A are not visible to wallet B", async () => {
    const a = await makeWallet();
    const b = await makeWallet();
    await recordExportEvent(TEST_OWNER, a.address, { ip: "1.1.1.1" });
    expect(await getExportLog(TEST_OWNER, b.address)).toEqual([]);
    expect(await getExportLog(TEST_OWNER, a.address)).toHaveLength(1);
  });
});

describe("chargeAgainstDailyLimit (atomic, per-wallet)", () => {
  it("allows any amount when no limit is set", async () => {
    const w = await makeWallet();
    const r = await chargeAgainstDailyLimit(TEST_OWNER, w.address, 9_999, undefined);
    expect(r.allowed).toBe(true);
  });

  it("allows when running total + amount stays under the cap", async () => {
    const w = await makeWallet();
    await chargeAgainstDailyLimit(TEST_OWNER, w.address, 30, 100);
    const r = await chargeAgainstDailyLimit(TEST_OWNER, w.address, 20, 100);
    expect(r.allowed).toBe(true);
    expect(await getDailySpendUsd(TEST_OWNER, w.address)).toBe(50);
  });

  it("rolls back when the cap would overflow", async () => {
    const w = await makeWallet();
    await chargeAgainstDailyLimit(TEST_OWNER, w.address, 90, 100);
    const r = await chargeAgainstDailyLimit(TEST_OWNER, w.address, 20, 100);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.limit).toBe(100);
      expect(r.spent).toBe(90);
      expect(r.requested).toBe(20);
    }
    expect(await getDailySpendUsd(TEST_OWNER, w.address)).toBe(90);
  });

  it("daily spend on wallet A doesn't affect wallet B", async () => {
    const a = await makeWallet();
    const b = await makeWallet();
    await chargeAgainstDailyLimit(TEST_OWNER, a.address, 50, 100);
    expect(await getDailySpendUsd(TEST_OWNER, a.address)).toBe(50);
    expect(await getDailySpendUsd(TEST_OWNER, b.address)).toBe(0);
  });

  it("ignores non-finite / non-positive amounts", async () => {
    const w = await makeWallet();
    const a = await chargeAgainstDailyLimit(TEST_OWNER, w.address, Number.NaN, 100);
    const b = await chargeAgainstDailyLimit(TEST_OWNER, w.address, -10, 100);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(await getDailySpendUsd(TEST_OWNER, w.address)).toBe(0);
  });
});

describe("refundDailySpend (per-wallet)", () => {
  it("decrements the running total", async () => {
    const w = await makeWallet();
    await chargeAgainstDailyLimit(TEST_OWNER, w.address, 75, 100);
    await refundDailySpend(TEST_OWNER, w.address, 25);
    expect(await getDailySpendUsd(TEST_OWNER, w.address)).toBe(50);
  });

  it("ignores non-finite / non-positive refunds", async () => {
    const w = await makeWallet();
    await chargeAgainstDailyLimit(TEST_OWNER, w.address, 50, 100);
    await refundDailySpend(TEST_OWNER, w.address, Number.NaN);
    await refundDailySpend(TEST_OWNER, w.address, -10);
    expect(await getDailySpendUsd(TEST_OWNER, w.address)).toBe(50);
  });
});

describe("checkDailyLimit (read-only)", () => {
  it("allows any amount when no limit is set", async () => {
    const w = await makeWallet();
    const r = await checkDailyLimit(TEST_OWNER, w.address, 9_999, undefined);
    expect(r.allowed).toBe(true);
  });

  it("allows when running total + amount stays under the cap", async () => {
    const w = await makeWallet();
    await recordDailySpend(TEST_OWNER, w.address, 30);
    const r = await checkDailyLimit(TEST_OWNER, w.address, 20, 100);
    expect(r.allowed).toBe(true);
  });

  it("denies once running total + amount would overflow the cap", async () => {
    const w = await makeWallet();
    await recordDailySpend(TEST_OWNER, w.address, 90);
    const r = await checkDailyLimit(TEST_OWNER, w.address, 20, 100);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.limit).toBe(100);
      expect(r.spent).toBe(90);
      expect(r.requested).toBe(20);
    }
  });

  it("getDailySpendUsd returns 0 when no record exists", async () => {
    const w = await makeWallet();
    expect(await getDailySpendUsd(TEST_OWNER, w.address)).toBe(0);
  });
});

describe("resolveWallet", () => {
  it("returns the named wallet when walletId provided", async () => {
    const a = await makeWallet();
    const b = await makeWallet();
    const result = await resolveWallet(TEST_OWNER, b.address);
    expect(result?.address).toBe(b.address);
    expect(result?.address).not.toBe(a.address);
  });

  it("falls back to default when walletId is null/undefined", async () => {
    const a = await makeWallet();
    await makeWallet();
    expect((await resolveWallet(TEST_OWNER, null))?.address).toBe(a.address);
    expect((await resolveWallet(TEST_OWNER, undefined))?.address).toBe(a.address);
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
