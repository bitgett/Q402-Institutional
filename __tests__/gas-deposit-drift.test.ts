import { beforeEach, describe, expect, it, vi } from "vitest";

const listStore = new Map<string, unknown[]>();
const setStore = new Map<string, Set<string>>();

const mockKv = vi.hoisted(() => ({
  sadd: vi.fn(async (key: string, value: string) => {
    const set = setStore.get(key) ?? new Set<string>();
    const existed = set.has(value);
    set.add(value);
    setStore.set(key, set);
    return existed ? 0 : 1;
  }),
  expire: vi.fn(async () => 1),
  rpush: vi.fn(async (key: string, value: unknown) => {
    const list = listStore.get(key) ?? [];
    list.push(value);
    listStore.set(key, list);
    return list.length;
  }),
  lrange: vi.fn(async (key: string) => listStore.get(key) ?? []),
  get: vi.fn(async () => null),
  hgetall: vi.fn(async () => null),
  hincrbyfloat: vi.fn(async () => 0),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import { addGasDeposit, getGasBalance, recordRelayedTx } from "@/app/lib/db";

// Placeholder fixtures — never use real owner/customer addresses in tests so
// the suite reads as anonymized data and grep-for-real-EOAs across tracked
// source returns nothing.
const ADDR = "0x000000000000000000000000000000000000beef";
const TX = "0x" + "ab".repeat(32);

beforeEach(() => {
  listStore.clear();
  setStore.clear();
  vi.clearAllMocks();
});

describe("addGasDeposit dedup/list drift repair", () => {
  it("repairs a txHash that is deduped but missing from the deposit ledger", async () => {
    const dedupKey = `gasdep_hashes:${ADDR}`;
    setStore.set(dedupKey, new Set([TX]));

    const repaired = await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });

    expect(repaired).toBe(true);
    await expect(getGasBalance(ADDR)).resolves.toMatchObject({ bnb: 0.0001 });
  });

  it("does not duplicate a deposit that already exists in the ledger", async () => {
    await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });
    const duplicate = await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });

    expect(duplicate).toBe(false);
    await expect(getGasBalance(ADDR)).resolves.toMatchObject({ bnb: 0.0001 });
  });

  it("never calls kv.expire on the dedup SET (no TTL — money-loss bug if evicted)", async () => {
    // Earlier versions set a 90d TTL on gasdep_hashes:{addr}. After expiry,
    // re-verifying the same historical txHash would SADD=1 and RPUSH a
    // duplicate credit. The fix removes the TTL — KV cost is negligible
    // vs. the cost of erroneously double-crediting a wallet's gas tank.
    await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });
    expect(mockKv.expire).not.toHaveBeenCalled();
  });

  it("does not double-credit even if the dedup SET was previously evicted (drift guard)", async () => {
    // Simulate the post-eviction state: SET empty but the deposit list
    // still carries the txHash. A naive impl would SADD=1, RPUSH the
    // dup. With the belt-and-suspenders list scan, we catch it and
    // return false instead.
    listStore.set(`gasdep:${ADDR}`, [{
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    }]);
    // setStore intentionally empty — simulates expired/evicted dedup SET.

    const result = await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });

    expect(result).toBe(false);
    // Balance unchanged — single 0.0001 BNB credit, NOT doubled.
    await expect(getGasBalance(ADDR)).resolves.toMatchObject({ bnb: 0.0001 });
  });

  it("does not deduct sandbox relay gas from the available gas balance", async () => {
    await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });

    await recordRelayedTx(ADDR, {
      apiKey: "q402_sandbox_test",
      address: ADDR,
      chain: "bnb",
      fromUser: ADDR,
      toUser: "0x0000000000000000000000000000000000000001",
      tokenAmount: "1",
      tokenSymbol: "USDT",
      gasCostNative: 0.0001,
      relayTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      relayedAt: new Date().toISOString(),
    });

    await expect(getGasBalance(ADDR)).resolves.toMatchObject({ bnb: 0.0001 });
  });

  it("does not deduct legacy q402_test relay gas from the available gas balance", async () => {
    await addGasDeposit(ADDR, {
      chain: "bnb",
      token: "BNB",
      amount: 0.0001,
      txHash: TX,
      depositedAt: "2026-05-07T00:00:00.000Z",
    });

    await recordRelayedTx(ADDR, {
      apiKey: "q402_test_legacy",
      address: ADDR,
      chain: "bnb",
      fromUser: ADDR,
      toUser: "0x0000000000000000000000000000000000000001",
      tokenAmount: "1",
      tokenSymbol: "USDT",
      gasCostNative: 0.00042,
      relayTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      relayedAt: new Date().toISOString(),
    });

    await expect(getGasBalance(ADDR)).resolves.toMatchObject({ bnb: 0.0001 });
  });
});
