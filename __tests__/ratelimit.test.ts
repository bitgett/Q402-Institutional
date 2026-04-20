import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — use vi.hoisted() so mockKv is available inside the factory
const mockKv = vi.hoisted(() => ({
  incr:   vi.fn(),
  set:    vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import { rateLimit } from "@/app/lib/ratelimit";

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

