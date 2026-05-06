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

const ADDR = "0x8266d8e3b231dfd16fa21e40cc3b99f38bc4b6c2";
const TX = "0xfae8d5e441643fd2f1fff3e2403be47eb359c7627c34f0de3d6b3b2a1f073f17";

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
