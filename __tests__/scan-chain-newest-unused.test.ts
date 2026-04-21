import { describe, it, expect } from "vitest";
import { selectBestUnusedCandidate, type ScanCandidate } from "@/app/lib/blockchain";

// Builder so each test can override only the fields it cares about.
const mk = (over: Partial<ScanCandidate>): ScanCandidate => ({
  txHash:      "0xa",
  blockNumber: 1,
  amountUSD:   29,
  token:       "USDC",
  chain:       "BNB Chain",
  from:        "0xuser",
  ...over,
});

describe("selectBestUnusedCandidate", () => {
  it("returns null when there are no candidates", async () => {
    expect(await selectBestUnusedCandidate([], async () => false)).toBeNull();
  });

  it("returns the only candidate when it is unused", async () => {
    const cand = mk({ txHash: "0xa1" });
    expect(await selectBestUnusedCandidate([cand], async () => false)).toEqual(cand);
  });

  it("returns null when the only candidate is already used", async () => {
    expect(await selectBestUnusedCandidate([mk({})], async () => true)).toBeNull();
  });

  it("picks the largest amount among unused candidates", async () => {
    const small = mk({ txHash: "0xSMALL", amountUSD: 29,  blockNumber: 100 });
    const big   = mk({ txHash: "0xBIG",   amountUSD: 89,  blockNumber:  50 });
    const winner = await selectBestUnusedCandidate([small, big], async () => false);
    expect(winner?.txHash).toBe("0xBIG");
  });

  it("ignores a used candidate even when it would be the largest", async () => {
    const usedBig    = mk({ txHash: "0xUSED",    amountUSD: 89, blockNumber:  50 });
    const unusedSmall = mk({ txHash: "0xUNUSED", amountUSD: 29, blockNumber: 100 });
    const used = new Set(["0xUSED"]);
    const winner = await selectBestUnusedCandidate(
      [usedBig, unusedSmall],
      async (h) => used.has(h),
    );
    expect(winner?.txHash).toBe("0xUNUSED");
  });

  it("breaks amount ties by picking the newest blockNumber", async () => {
    const older = mk({ txHash: "0xOLD", amountUSD: 29, blockNumber:  50 });
    const newer = mk({ txHash: "0xNEW", amountUSD: 29, blockNumber: 100 });
    const winner = await selectBestUnusedCandidate([older, newer], async () => false);
    expect(winner?.txHash).toBe("0xNEW");
  });

  // ── Regression: the actual incident that motivated this code ──────────────
  // Same wallet pays $29, gets activated, then pays $29 again (e.g. after
  // refund + redo). The pre-fix scanner picked the FIRST $29 it iterated over
  // — chronologically the older, already-consumed hash — and the activate
  // route then 402'd with "This transaction has already been used".
  it("REGRESSION: 2x $29 from same wallet — first used, second wins", async () => {
    const oldUsed    = mk({ txHash: "0xOLD", amountUSD: 29, blockNumber: 1000 });
    const newPayment = mk({ txHash: "0xNEW", amountUSD: 29, blockNumber: 2000 });
    const used = new Set(["0xOLD"]);
    const winner = await selectBestUnusedCandidate(
      [oldUsed, newPayment],
      async (h) => used.has(h),
    );
    expect(winner?.txHash).toBe("0xNEW");
  });

  it("REGRESSION: 3x $29 — first two used, newest wins", async () => {
    const tx1 = mk({ txHash: "0x1", amountUSD: 29, blockNumber: 1000 });
    const tx2 = mk({ txHash: "0x2", amountUSD: 29, blockNumber: 2000 });
    const tx3 = mk({ txHash: "0x3", amountUSD: 29, blockNumber: 3000 });
    const used = new Set(["0x1", "0x2"]);
    const winner = await selectBestUnusedCandidate(
      [tx1, tx2, tx3],
      async (h) => used.has(h),
    );
    expect(winner?.txHash).toBe("0x3");
  });

  it("scans tokens of mixed amounts; largest-unused still wins regardless of order", async () => {
    // Iteration order: USDT(29 used), USDC(89 unused), USDT(89 unused-newer)
    // Expected winner: the USDT 89, since amount ties go to the newer block.
    const usdtUsed = mk({ txHash: "0xA", token: "USDT", amountUSD: 29, blockNumber: 100 });
    const usdcWin  = mk({ txHash: "0xB", token: "USDC", amountUSD: 89, blockNumber: 200 });
    const usdtWin  = mk({ txHash: "0xC", token: "USDT", amountUSD: 89, blockNumber: 300 });
    const used = new Set(["0xA"]);
    const winner = await selectBestUnusedCandidate(
      [usdtUsed, usdcWin, usdtWin],
      async (h) => used.has(h),
    );
    expect(winner?.txHash).toBe("0xC");
    expect(winner?.token).toBe("USDT");
  });
});
