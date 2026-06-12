import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bounded-walker regression suite for scanNativeDeposits.
 *
 * The cron deposit-scan was 504ing because a single owner walked the FULL
 * block window of every chain in one invocation (Monad's 6000-block
 * window alone is 300 sequential RPC batches). The fix caps blocks-per-
 * call via `maxBlocks` and supports resuming a forward walk via
 * `fromBlock`. These tests pin the two load-bearing invariants:
 *
 *   1. The cap NEVER skips blocks in the middle of a window — direction
 *      depends on whether the caller is resuming (oldest slice forward)
 *      or scanning fresh (most-recent slice).
 *   2. The default (verify) path is unchanged: full `tip - blockWindow`.
 *
 * We intercept the JSON-RPC tip query (eth_blockNumber via ethers'
 * getBlockNumber) and the batched eth_getBlockByNumber POST, capturing
 * exactly which block numbers were requested.
 */

// Stub ethers' JsonRpcProvider so getBlockNumber returns a fixed tip
// without a real network call. Everything else (formatEther etc.) stays
// real via importActual.
const TIP = 100_000;
vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: class {
        async getBlockNumber() {
          return TIP;
        }
      },
    },
  };
});

import { scanNativeDeposits, DEPOSIT_CHAINS } from "@/app/lib/deposit-scanner";
import { GASTANK_ADDRESS_LC } from "@/app/lib/wallets";

const MONAD = DEPOSIT_CHAINS.find((c) => c.key === "monad")!;
const ETH = DEPOSIT_CHAINS.find((c) => c.key === "eth")!;

let requestedBlocks: number[];
let originalFetch: typeof fetch;

beforeEach(() => {
  requestedBlocks = [];
  originalFetch = global.fetch;
  // Capture every block number asked for across all batched chunks, and
  // return empty blocks so no deposits are matched (we only care about
  // the requested range here).
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const batch = typeof init?.body === "string" ? JSON.parse(init.body) : [];
    for (const req of batch) {
      const hex = req.params[0] as string;
      requestedBlocks.push(parseInt(hex, 16));
    }
    const payload = batch.map((_: unknown, i: number) => ({
      id: i,
      result: { transactions: [] },
    }));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

const range = () => ({
  min: Math.min(...requestedBlocks),
  max: Math.max(...requestedBlocks),
  count: requestedBlocks.length,
});

describe("scanNativeDeposits — default (verify) path is unchanged", () => {
  it("walks the full tip-blockWindow window when no opts are passed", async () => {
    const scan = await scanNativeDeposits(ETH, "0xabc");
    const r = range();
    expect(r.min).toBe(TIP - ETH.blockWindow); // eth window = 50
    expect(r.max).toBe(TIP);
    expect(r.count).toBe(ETH.blockWindow + 1); // inclusive
    expect(scan.scannedFrom).toBe(TIP - ETH.blockWindow);
    expect(scan.scannedTo).toBe(TIP);
    expect(scan.tip).toBe(TIP);
  });
});

describe("scanNativeDeposits — maxBlocks cap (fresh scan, no fromBlock)", () => {
  it("keeps the MOST-RECENT maxBlocks ending at the tip", async () => {
    // Monad window is 6000; cap to 1000 → expect [tip-999 .. tip].
    const scan = await scanNativeDeposits(MONAD, "0xabc", { maxBlocks: 1000 });
    const r = range();
    expect(r.max).toBe(TIP);
    expect(r.min).toBe(TIP - 999);
    expect(r.count).toBe(1000);
    expect(scan.scannedFrom).toBe(TIP - 999);
    expect(scan.scannedTo).toBe(TIP);
    // The full window was wider than the cap — newest slice taken.
    expect(TIP - 999).toBeGreaterThan(TIP - MONAD.blockWindow);
  });

  it("does not cap when the window already fits under maxBlocks", async () => {
    // eth window = 50, cap = 1000 → full window, untouched.
    const scan = await scanNativeDeposits(ETH, "0xabc", { maxBlocks: 1000 });
    expect(scan.scannedFrom).toBe(TIP - ETH.blockWindow);
    expect(scan.scannedTo).toBe(TIP);
  });
});

describe("scanNativeDeposits — resuming forward walk (fromBlock + maxBlocks)", () => {
  it("CRITICAL: keeps the OLDEST slice [fromBlock .. fromBlock+cap-1] — no mid-window skip", async () => {
    // Resume from an old block far below the tip. A naive 'most-recent'
    // cap would jump to [tip-cap+1 .. tip] and SKIP every block between
    // fromBlock and tip-cap. The forward-walk cap must NOT do that.
    const from = TIP - 5000;
    const scan = await scanNativeDeposits(MONAD, "0xabc", {
      fromBlock: from,
      maxBlocks: 1000,
    });
    const r = range();
    expect(r.min).toBe(from); // started exactly where we resumed
    expect(r.max).toBe(from + 999); // advanced forward by the cap
    expect(r.count).toBe(1000);
    expect(scan.scannedFrom).toBe(from);
    expect(scan.scannedTo).toBe(from + 999);
    // Did NOT jump to the recent slice.
    expect(scan.scannedTo).toBeLessThan(TIP);
  });

  it("when the resume range fits under the cap, walks straight to the tip (caught up)", async () => {
    const from = TIP - 100;
    const scan = await scanNativeDeposits(MONAD, "0xabc", {
      fromBlock: from,
      maxBlocks: 1000,
    });
    expect(scan.scannedFrom).toBe(from);
    expect(scan.scannedTo).toBe(TIP); // reached the head
    expect(scan.scannedTo).toBe(scan.tip);
  });

  it("clamps a resume point already at/ahead of the tip to a single block (no negative range)", async () => {
    const scan = await scanNativeDeposits(MONAD, "0xabc", {
      fromBlock: TIP + 500,
      maxBlocks: 1000,
    });
    expect(scan.scannedFrom).toBe(TIP);
    expect(scan.scannedTo).toBe(TIP);
    expect(range().count).toBe(1); // exactly the tip block, nothing older
  });
});

describe("scanNativeDeposits — deadline guard (cron timeout safety)", () => {
  it("launches ZERO batches when the deadline has already passed", async () => {
    // Mirrors a slow chain (Injective ~3.9s/batch) having already eaten
    // the function's budget: the walker must bail before any RPC batch
    // rather than grinding ~50 sequential batches into a 60s Vercel kill.
    // This is the same branch that fires mid-walk once the deadline lands
    // between batches — the cron passes `startedAt + SCAN_DEADLINE_MS`.
    const scan = await scanNativeDeposits(MONAD, "0xabc", {
      maxBlocks: 1000,
      deadline: Date.now() - 1,
    });
    expect(requestedBlocks.length).toBe(0); // no RPC batch launched
    expect(scan.deposits).toEqual([]);
    expect(scan.chunkTotal).toBe(0);
    // Empty range — nothing walked (scannedTo < scannedFrom).
    expect(scan.scannedTo).toBeLessThan(scan.scannedFrom);
  });

  it("is inert when the deadline is far in the future — full walk, no regression", async () => {
    // The instant mock never lets a 60s deadline elapse mid-walk, so the
    // window is walked in full. Proves the guard doesn't touch the
    // healthy-RPC / verify path that passes no (or a distant) deadline.
    const scan = await scanNativeDeposits(ETH, "0xabc", {
      deadline: Date.now() + 60_000,
    });
    expect(requestedBlocks.length).toBe(ETH.blockWindow + 1); // full 51-block walk
    expect(scan.scannedFrom).toBe(TIP - ETH.blockWindow);
    expect(scan.scannedTo).toBe(TIP);
  });
});

describe("scanNativeDeposits — sender collection (per-chain cron sweep)", () => {
  const ALICE = "0xaaaa000000000000000000000000000000000001";
  const BOB = "0xbbbb000000000000000000000000000000000002";
  const NOT_GAS_TANK = "0xcccc000000000000000000000000000000000003";

  // Override the default empty-tx mock: the most-recent block carries two
  // gas-tank deposits (alice 1 ETH, bob 2 ETH) plus one transfer to a
  // different address (must be ignored).
  function mockGasTankTxs() {
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const batch = typeof init?.body === "string" ? JSON.parse(init.body) : [];
      const payload = batch.map((req: { params: string[] }, i: number) => {
        const blockNum = parseInt(req.params[0], 16);
        const transactions =
          blockNum === TIP
            ? [
                { from: ALICE, to: GASTANK_ADDRESS_LC, value: "0xde0b6b3a7640000", hash: "0xtxAlice" }, // 1 ETH
                { from: BOB, to: GASTANK_ADDRESS_LC, value: "0x1bc16d674ec80000", hash: "0xtxBob" }, // 2 ETH
                { from: ALICE, to: NOT_GAS_TANK, value: "0xde0b6b3a7640000", hash: "0xtxOther" }, // ignored
              ]
            : [];
        return { id: i, result: { transactions } };
      });
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("fromAddress=null collects EVERY sender's gas-tank deposit (cron sweep)", async () => {
    mockGasTankTxs();
    const scan = await scanNativeDeposits(ETH, null);
    expect(scan.deposits).toHaveLength(2); // alice + bob; the non-gas-tank tx is excluded
    const byFrom = Object.fromEntries(scan.deposits.map((d) => [d.fromAddress, d.amount]));
    expect(byFrom[ALICE]).toBe(1);
    expect(byFrom[BOB]).toBe(2);
  });

  it("fromAddress=ALICE filters to that one sender (verify-deposit path unchanged)", async () => {
    mockGasTankTxs();
    const scan = await scanNativeDeposits(ETH, ALICE);
    expect(scan.deposits).toHaveLength(1);
    expect(scan.deposits[0].fromAddress).toBe(ALICE);
    expect(scan.deposits[0].amount).toBe(1);
  });
});
