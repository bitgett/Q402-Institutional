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
