/**
 * yield-policy.test.ts
 *
 * enforceYieldPolicy — deposit guardrails enforced server-side before any
 * Aave deposit. Covers: hard USDC/USDT floor, withdraw always-allowed,
 * asset allowlist, protocol allowlist, maxAllocationPct deny/allow, and
 * FAIL-CLOSED on a balance read error.
 *
 * Mocks the per-wallet hook config, the liquid-balance RPC read (via
 * viem's createPublicClient), and listAllPositions for the current yield
 * position.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────
const mockConfig = vi.hoisted(() => ({ getWalletHookConfig: vi.fn() }));
vi.mock("@/app/lib/hooks/config", () => ({
  getWalletHookConfig: mockConfig.getWalletHookConfig,
}));

const mockYield = vi.hoisted(() => ({ aaveTotalPositionValueStrict: vi.fn() }));
vi.mock("@/app/lib/yield/aave", () => ({
  aaveTotalPositionValueStrict: mockYield.aaveTotalPositionValueStrict,
}));

// In-memory KV stand-in for the FIX-2 daily-op-cap + FIX-3 lock tests.
// policy.ts itself never touches kv (RPC + hook-config mocks above cover it),
// but yield/relay.ts and agentic-wallet.ts do.
const kvNumStore = vi.hoisted(() => new Map<string, number>());
const kvStrStore = vi.hoisted(() => new Map<string, unknown>());
const mockKv = vi.hoisted(() => ({
  incr: vi.fn(async (key: string) => {
    const v = (kvNumStore.get(key) ?? 0) + 1;
    kvNumStore.set(key, v);
    return v;
  }),
  decr: vi.fn(async (key: string) => {
    const v = (kvNumStore.get(key) ?? 0) - 1;
    kvNumStore.set(key, v);
    return v;
  }),
  expire: vi.fn(async () => 1),
  // SET NX semantics for the wallet-chain lock.
  set: vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean }) => {
    if (opts?.nx && kvStrStore.has(key)) return null;
    kvStrStore.set(key, value);
    return "OK";
  }),
  del: vi.fn(async (key: string) => {
    kvStrStore.delete(key);
    return 1;
  }),
  get: vi.fn(async (key: string) => kvStrStore.get(key) ?? null),
  // Lua compare-and-delete used by releaseWalletChainLock — only deletes when
  // the stored token matches ARGV[1] (the caller's lease).
  eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
    if (kvStrStore.get(keys[0]) === args[0]) {
      kvStrStore.delete(keys[0]);
      return 1;
    }
    return 0;
  }),
}));
vi.mock("@vercel/kv", () => ({ kv: mockKv }));

// viem: only createPublicClient().readContract (balanceOf) and formatUnits
// are exercised by policy.ts. Keep formatUnits real for correct math.
const mockReadContract = vi.hoisted(() => vi.fn());
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract: mockReadContract }),
    http: () => ({}),
  };
});

import { enforceYieldPolicy, type YieldPolicyInput } from "@/app/lib/yield/policy";
import { chargeYieldOpBudget, refundYieldOpBudget } from "@/app/lib/yield/relay";
import { acquireWalletChainLock, releaseWalletChainLock } from "@/app/lib/agentic-wallet";

const WALLET = "0x" + "a".repeat(40);

function input(over: Partial<YieldPolicyInput> = {}): YieldPolicyInput {
  return {
    owner: "0x" + "b".repeat(40),
    walletId: WALLET,
    chain: "bnb",
    asset: "USDC",
    action: "supply",
    amount: "100",
    ...over,
  };
}

// BNB stables are 18-dec. Helper to express a human amount as raw bigint.
function raw18(human: number): bigint {
  return BigInt(Math.round(human * 1e6)) * 10n ** 12n;
}

beforeEach(() => {
  vi.clearAllMocks();
  kvNumStore.clear();
  kvStrStore.clear();
  delete process.env.YIELD_DAILY_OP_CAP;
  mockConfig.getWalletHookConfig.mockResolvedValue(null);
  mockYield.aaveTotalPositionValueStrict.mockResolvedValue(0);
  mockReadContract.mockResolvedValue(0n);
});

describe("enforceYieldPolicy — hard floor", () => {
  it("denies a non-stablecoin asset", async () => {
    const r = await enforceYieldPolicy(input({ asset: "DAI" as YieldPolicyInput["asset"] }));
    expect(r.allow).toBe(false);
    expect(r.code).toBe("ASSET_NOT_ALLOWED");
  });

  it("allows supply when no policy configured", async () => {
    const r = await enforceYieldPolicy(input());
    expect(r.allow).toBe(true);
  });

  it("allows supply when policy present but disabled", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({ yieldPolicy: { enabled: false, maxAllocationPct: 0 } });
    const r = await enforceYieldPolicy(input());
    expect(r.allow).toBe(true);
  });
});

describe("enforceYieldPolicy — withdraw is never gated", () => {
  it("allows withdraw even with a restrictive policy", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedAssets: ["USDT"], maxAllocationPct: 0 },
    });
    const r = await enforceYieldPolicy(input({ action: "withdraw", asset: "USDC" }));
    expect(r.allow).toBe(true);
    // Must not even read balances for a withdraw.
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockYield.aaveTotalPositionValueStrict).not.toHaveBeenCalled();
  });
});

describe("enforceYieldPolicy — asset allowlist", () => {
  it("denies an asset not in allowedAssets", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedAssets: ["USDT"] },
    });
    const r = await enforceYieldPolicy(input({ asset: "USDC" }));
    expect(r.allow).toBe(false);
    expect(r.code).toBe("ASSET_NOT_ALLOWED");
  });

  it("allows an asset that is in allowedAssets", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedAssets: ["USDC", "USDT"] },
    });
    const r = await enforceYieldPolicy(input({ asset: "USDC" }));
    expect(r.allow).toBe(true);
  });
});

describe("enforceYieldPolicy — protocol allowlist (Aave/Lista/Morpho venues)", () => {
  it("denies when allowedProtocols excludes aave", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedProtocols: ["morpho"] },
    });
    const r = await enforceYieldPolicy(input());
    expect(r.allow).toBe(false);
    expect(r.code).toBe("PROTOCOL_NOT_ALLOWED");
  });

  it("allows when allowedProtocols includes aave", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedProtocols: ["aave", "morpho"] },
    });
    const r = await enforceYieldPolicy(input());
    expect(r.allow).toBe(true);
  });
});

describe("enforceYieldPolicy — maxAllocationPct", () => {
  it("denies when the deposit pushes yield share over the cap", async () => {
    // liquid 100, position 0, deposit 100 → 100/200 = 50% > 40% cap.
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, maxAllocationPct: 40 },
    });
    mockReadContract.mockResolvedValue(raw18(100)); // each balanceOf call → 100
    mockYield.aaveTotalPositionValueStrict.mockResolvedValue(0);
    const r = await enforceYieldPolicy(input({ amount: "100" }));
    expect(r.allow).toBe(false);
    expect(r.code).toBe("MAX_ALLOCATION_EXCEEDED");
  });

  it("allows when the deposit stays at/under the cap", async () => {
    // Only USDC has a balance (USDT 0). liquid 1000, deposit 100 → 100/1000 = 10% <= 50%.
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, maxAllocationPct: 50 },
    });
    mockReadContract.mockResolvedValueOnce(raw18(1000)).mockResolvedValue(0n);
    mockYield.aaveTotalPositionValueStrict.mockResolvedValue(0);
    const r = await enforceYieldPolicy(input({ amount: "100" }));
    expect(r.allow).toBe(true);
  });

  it("counts the existing position in the numerator", async () => {
    // liquid 100, position 60, deposit 50 → (60+50)/(100+60)=110/160=68.75% > 60%.
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, maxAllocationPct: 60 },
    });
    mockReadContract.mockResolvedValueOnce(raw18(100)).mockResolvedValue(0n);
    mockYield.aaveTotalPositionValueStrict.mockResolvedValue(60);
    const r = await enforceYieldPolicy(input({ amount: "50" }));
    expect(r.allow).toBe(false);
    expect(r.code).toBe("MAX_ALLOCATION_EXCEEDED");
  });
});

describe("enforceYieldPolicy — FAIL CLOSED on balance read error", () => {
  it("denies (BALANCE_READ_FAILED) when the liquid-balance RPC throws", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, maxAllocationPct: 50 },
    });
    mockReadContract.mockRejectedValue(new Error("RPC down"));
    const r = await enforceYieldPolicy(input());
    expect(r.allow).toBe(false);
    expect(r.code).toBe("BALANCE_READ_FAILED");
  });

  it("denies when the position read throws", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, maxAllocationPct: 50 },
    });
    mockReadContract.mockResolvedValue(raw18(100));
    mockYield.aaveTotalPositionValueStrict.mockRejectedValue(new Error("RPC down"));
    const r = await enforceYieldPolicy(input());
    expect(r.allow).toBe(false);
    expect(r.code).toBe("BALANCE_READ_FAILED");
  });
});

describe("enforceYieldPolicy — config read error propagates (not swallowed into allow)", () => {
  it("lets a KV throw from getWalletHookConfig propagate", async () => {
    mockConfig.getWalletHookConfig.mockRejectedValue(new Error("KV connection failed"));
    await expect(enforceYieldPolicy(input())).rejects.toThrow("KV connection failed");
  });
});

// ── FIX 2 — per-owner daily yield-op cap (relayer gas-abuse rail) ──────────
describe("chargeYieldOpBudget — daily yield-op cap", () => {
  const OWNER = "0x" + "c".repeat(40);

  it("allows ops up to the cap then denies", async () => {
    process.env.YIELD_DAILY_OP_CAP = "3";
    const r1 = await chargeYieldOpBudget(OWNER);
    const r2 = await chargeYieldOpBudget(OWNER);
    const r3 = await chargeYieldOpBudget(OWNER);
    const r4 = await chargeYieldOpBudget(OWNER);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r4.allowed).toBe(false);
    expect(r4.cap).toBe(3);
    // The over-cap reservation must be rolled back (count stays AT the cap),
    // so a refund of an earlier op frees exactly one slot.
    expect(r4.count).toBe(3);
  });

  it("rolls back the over-cap INCR so the counter never exceeds the cap", async () => {
    process.env.YIELD_DAILY_OP_CAP = "1";
    await chargeYieldOpBudget(OWNER);       // count = 1 (allowed)
    await chargeYieldOpBudget(OWNER);       // would be 2 → denied + rolled back
    // A refund now should bring it to 0 and re-open a slot.
    await refundYieldOpBudget(OWNER);
    const again = await chargeYieldOpBudget(OWNER);
    expect(again.allowed).toBe(true);
  });

  it("refund releases a reserved slot so an honest retry isn't capped out", async () => {
    process.env.YIELD_DAILY_OP_CAP = "1";
    const first = await chargeYieldOpBudget(OWNER);
    expect(first.allowed).toBe(true);
    // Simulate a pre-broadcast failure refunding the slot.
    await refundYieldOpBudget(OWNER);
    const retry = await chargeYieldOpBudget(OWNER);
    expect(retry.allowed).toBe(true);
  });

  it("sets a TTL on the first write of the day (self-flushing counter)", async () => {
    await chargeYieldOpBudget(OWNER);
    expect(mockKv.expire).toHaveBeenCalledTimes(1);
  });

  it("fails OPEN when KV.incr throws (gas rail must not block honest users)", async () => {
    mockKv.incr.mockRejectedValueOnce(new Error("KV down"));
    const r = await chargeYieldOpBudget(OWNER);
    expect(r.allowed).toBe(true);
  });

  it("defaults the cap to 50 when YIELD_DAILY_OP_CAP is unset/invalid", async () => {
    const r = await chargeYieldOpBudget(OWNER);
    expect(r.cap).toBe(50);
  });
});

// ── FIX 3 — per-wallet+chain settle lock (cap-race + 7702 nonce-race) ──────
describe("acquireWalletChainLock — serialises one wallet+chain (safe-lease)", () => {
  const WALLET_A = "0x" + "d".repeat(40);
  const WALLET_B = "0x" + "e".repeat(40);

  it("grants a token once, then refuses a concurrent holder", async () => {
    const tok = await acquireWalletChainLock(WALLET_A, "bnb");
    expect(typeof tok).toBe("string");
    // Second acquire while held → null (SET NX miss).
    expect(await acquireWalletChainLock(WALLET_A, "bnb")).toBeNull();
  });

  it("re-grants after a token-matched release", async () => {
    const tok = await acquireWalletChainLock(WALLET_A, "bnb");
    expect(tok).not.toBeNull();
    await releaseWalletChainLock(WALLET_A, "bnb", tok);
    expect(await acquireWalletChainLock(WALLET_A, "bnb")).not.toBeNull();
  });

  it("ABA-safe: a stale token release does NOT drop the fresh holder's lock", async () => {
    // Holder A acquires, then (simulating TTL expiry) the key is cleared and
    // holder B takes a fresh lease. A's release with its OLD token must NOT
    // delete B's lock — compare-and-del refuses the mismatched token.
    const tokA = await acquireWalletChainLock(WALLET_A, "bnb");
    kvStrStore.delete("aw:wc-lock:" + WALLET_A.toLowerCase() + ":bnb"); // TTL expiry
    const tokB = await acquireWalletChainLock(WALLET_A, "bnb");
    expect(tokB).not.toBeNull();
    expect(tokB).not.toBe(tokA);
    await releaseWalletChainLock(WALLET_A, "bnb", tokA); // stale — must no-op
    // B's lock still held → a new acquire is refused.
    expect(await acquireWalletChainLock(WALLET_A, "bnb")).toBeNull();
  });

  it("is scoped per chain — same wallet, different chain, both lock", async () => {
    expect(await acquireWalletChainLock(WALLET_A, "bnb")).not.toBeNull();
    expect(await acquireWalletChainLock(WALLET_A, "eth")).not.toBeNull();
  });

  it("is scoped per wallet — different wallets don't contend", async () => {
    expect(await acquireWalletChainLock(WALLET_A, "bnb")).not.toBeNull();
    expect(await acquireWalletChainLock(WALLET_B, "bnb")).not.toBeNull();
  });
});

// Audit P1: the deposit venue is user-selectable, so the `allowedProtocols`
// guardrail MUST gate the CHOSEN venue, not the chain's default selector. In this
// test env LISTA_YIELD_ENABLED is off, so the default deposit venue on bnb is
// "aave" — these cases only pass if the gate honors the explicit `protocol`.
describe("enforceYieldPolicy — chosen deposit venue gates allowedProtocols", () => {
  it("denies when the user-chosen venue is NOT in allowedProtocols (even if the default IS)", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedProtocols: ["aave"] }, // default (aave) would pass
    });
    const r = await enforceYieldPolicy(input({ protocol: "lista" })); // but the user chose lista
    expect(r.allow).toBe(false);
    expect(r.code).toBe("PROTOCOL_NOT_ALLOWED");
  });

  it("allows when the user-chosen venue IS in allowedProtocols (even if the default is NOT)", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      yieldPolicy: { enabled: true, allowedProtocols: ["lista"] }, // default (aave) would be denied
    });
    const r = await enforceYieldPolicy(input({ protocol: "lista" })); // user chose lista → permitted
    expect(r.allow).toBe(true); // no maxAllocationPct → passes the protocol gate
  });
});
