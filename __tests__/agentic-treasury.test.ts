/**
 * agentic-treasury.test.ts — Q402 Memory aggregation regression guards.
 *
 * Pins the correctness rules the multi-agent audit surfaced (2026-07-07): USD
 * totals count USD stablecoins only ($Q and stake/unstake/yield asset moves are
 * excluded), sandbox/test relay rows never pollute real spend, and vendor
 * history is scoped to the requested Agent Wallet.
 *
 * The three read functions call getRelayedTxs + the list stores; we mock those
 * at the module boundary so the test drives a controlled RelayedTx set and
 * asserts the pure aggregation behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const relayed: Record<string, unknown>[] = [];

vi.mock("@/app/lib/db", () => ({
  getRelayedTxs: vi.fn(async () => relayed),
  recentMonths: (n: number) => ["2026-07", "2026-06", "2026-05"].slice(0, Math.max(1, n)),
}));
vi.mock("@/app/lib/agentic-wallet-recurring", () => ({
  listRecurringRules: vi.fn(async () => []),
}));
vi.mock("@/app/lib/payment-request", () => ({
  listPaymentRequestsPage: vi.fn(async () => ({ records: [] })),
}));
vi.mock("@/app/lib/escrow", () => ({
  listEscrowsPage: vi.fn(async () => ({ records: [] })),
}));
vi.mock("@/app/lib/agentic-wallet", () => ({
  listAgenticWallets: vi.fn(async () => [
    { address: "0xWALLET1", label: "Research", dailyLimitUsd: 500, perTxMaxUsd: 100 },
  ]),
}));

import { treasurySummary, vendorHistory, agentSpendReport } from "@/app/lib/agentic-treasury";

const OWNER = "0xowner";
const W1 = "0xwallet1";
const W2 = "0xwallet2";

function tx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiKey: "q402_live_real", address: OWNER, chain: "bnb",
    fromUser: W1, toUser: "0xvendora", tokenAmount: 100, tokenSymbol: "USDC",
    gasCostNative: 0, relayTxHash: "0x", relayedAt: "2026-07-01T00:00:00.000Z",
    source: "send", ...over,
  };
}

beforeEach(() => { relayed.length = 0; });

describe("Q402 Memory aggregation (agentic-treasury)", () => {
  it("excludes $Q and any non-stablecoin token from USD spend totals", async () => {
    relayed.push(tx({ tokenSymbol: "USDC", tokenAmount: 100 }));
    relayed.push(tx({ tokenSymbol: "Q", tokenAmount: 10_000 })); // must NOT read as $10,000
    const s = await treasurySummary(OWNER, undefined, "all");
    expect(s.totalOutUsd).toBe(100);
    expect(s.txCount).toBe(1);
    expect(s.excludedNonSpend).toBe(1);
  });

  it("excludes stake / unstake / yield asset moves from spend", async () => {
    relayed.push(tx({ source: "send", tokenAmount: 100 }));
    relayed.push(tx({ source: "stake", tokenAmount: 500 }));
    relayed.push(tx({ source: "yield_withdraw", tokenAmount: 300 }));
    relayed.push(tx({ source: "yield_deposit", tokenAmount: 200 }));
    const s = await treasurySummary(OWNER, undefined, "all");
    expect(s.totalOutUsd).toBe(100);
    expect(s.txCount).toBe(1);
  });

  it("excludes sandbox and test relay rows from real spend", async () => {
    relayed.push(tx({ tokenAmount: 100, apiKey: "q402_live_real" }));
    relayed.push(tx({ tokenAmount: 50, apiKey: "q402_sandbox_test" }));
    relayed.push(tx({ tokenAmount: 25, apiKey: "q402_test_xyz" }));
    const s = await treasurySummary(OWNER, undefined, "all");
    expect(s.totalOutUsd).toBe(100);
    expect(s.txCount).toBe(1);
  });

  it("scopes vendorHistory to the requested Agent Wallet", async () => {
    relayed.push(tx({ fromUser: W1, toUser: "0xvendora", tokenAmount: 100 }));
    relayed.push(tx({ fromUser: W2, toUser: "0xvendora", tokenAmount: 999 })); // other wallet
    const v = await vendorHistory(OWNER, W1, "0xvendora", "all");
    expect(v.totalPaidUsd).toBe(100);
    expect(v.txCount).toBe(1);
  });

  it("agentSpendReport sums USD-stable spend per wallet (Q excluded)", async () => {
    relayed.push(tx({ fromUser: W1, tokenSymbol: "USDC", tokenAmount: 100 }));
    relayed.push(tx({ fromUser: W1, tokenSymbol: "Q", tokenAmount: 10_000 })); // excluded
    const r = await agentSpendReport(OWNER, "all");
    const w1 = r.agents.find((a) => a.walletId === W1.toLowerCase());
    expect(w1?.spentUsd).toBe(100);
  });
});
