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

describe("enforceYieldPolicy — protocol allowlist (Aave-only build)", () => {
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
