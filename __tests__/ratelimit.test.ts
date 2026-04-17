import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — use vi.hoisted() so mockKv is available inside the factory
const mockKv = vi.hoisted(() => ({
  incr:   vi.fn(),
  decr:   vi.fn(),
  set:    vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import { rateLimit, refundRateLimit } from "@/app/lib/ratelimit";

// ── helpers ───────────────────────────────────────────────────────────────────

function currentBucket(windowSec: number) {
  return Math.floor(Date.now() / 1000 / windowSec);
}

function expectedKey(endpoint: string, identifier: string, windowSec: number) {
  return `rl:${endpoint}:${identifier}:${currentBucket(windowSec)}`;
}

// ── rateLimit ─────────────────────────────────────────────────────────────────

describe("rateLimit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when count is within limit", async () => {
    mockKv.incr.mockResolvedValue(3);
    const ok = await rateLimit("1.2.3.4", "relay", 10, 60);
    expect(ok).toBe(true);
    expect(mockKv.incr).toHaveBeenCalledWith(expectedKey("relay", "1.2.3.4", 60));
  });

  it("returns false when count exceeds limit", async () => {
    mockKv.incr.mockResolvedValue(11);
    const ok = await rateLimit("1.2.3.4", "relay", 10, 60);
    expect(ok).toBe(false);
  });

  it("sets TTL on first increment (count === 1)", async () => {
    mockKv.incr.mockResolvedValue(1);
    await rateLimit("addr", "test", 5, 60);
    expect(mockKv.expire).toHaveBeenCalledWith(expectedKey("test", "addr", 60), 120);
  });

  it("does not set TTL on subsequent increments", async () => {
    mockKv.incr.mockResolvedValue(2);
    await rateLimit("addr", "test", 5, 60);
    expect(mockKv.expire).not.toHaveBeenCalled();
  });

  it("returns true (fail-open) when KV throws and failOpen=true is opt-in", async () => {
    mockKv.incr.mockRejectedValue(new Error("KV down"));
    const ok = await rateLimit("addr", "relay", 10, 60, true);
    expect(ok).toBe(true);
  });

  it("returns false (fail-closed) when KV throws and failOpen=false", async () => {
    mockKv.incr.mockRejectedValue(new Error("KV down"));
    const ok = await rateLimit("addr", "relay", 10, 60, false);
    expect(ok).toBe(false);
  });

  it("default is fail-closed: KV error → false without explicit failOpen arg", async () => {
    mockKv.incr.mockRejectedValue(new Error("KV down"));
    const ok = await rateLimit("addr", "relay", 10, 60);
    expect(ok).toBe(false);
  });
});

// ── refundRateLimit ───────────────────────────────────────────────────────────

describe("refundRateLimit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("decrements the same key rateLimit would have incremented", async () => {
    mockKv.decr.mockResolvedValue(2);
    await refundRateLimit("0xabc", "daily", 86400);
    expect(mockKv.decr).toHaveBeenCalledWith(expectedKey("daily", "0xabc", 86400));
  });

  it("floors at 0 when decrement goes negative", async () => {
    mockKv.decr.mockResolvedValue(-1);
    await refundRateLimit("0xabc", "daily", 86400);
    expect(mockKv.set).toHaveBeenCalledWith(expectedKey("daily", "0xabc", 86400), 0);
  });

  it("does not call set when decrement result is 0 or positive", async () => {
    mockKv.decr.mockResolvedValue(0);
    await refundRateLimit("0xabc", "daily", 86400);
    expect(mockKv.set).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockKv.decr.mockResolvedValue(5);
    await refundRateLimit("0xabc", "daily", 86400);
    expect(mockKv.set).not.toHaveBeenCalled();
  });

  it("does not throw when KV is unavailable", async () => {
    mockKv.decr.mockRejectedValue(new Error("KV down"));
    await expect(refundRateLimit("0xabc", "daily", 86400)).resolves.toBeUndefined();
  });

  it("uses the same key structure as rateLimit (refund is always reversible)", async () => {
    // Simulate: rateLimit increments → refundRateLimit decrements → net = 0
    let counter = 0;
    mockKv.incr.mockImplementation(() => Promise.resolve(++counter));
    mockKv.decr.mockImplementation(() => Promise.resolve(--counter));

    await rateLimit("addr", "daily", 100, 86400);
    expect(counter).toBe(1);

    await refundRateLimit("addr", "daily", 86400);
    expect(counter).toBe(0);

    // Verify both called the same key
    expect(mockKv.incr).toHaveBeenCalledWith(mockKv.decr.mock.calls[0][0]);
  });
});
