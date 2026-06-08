/**
 * hooks-compliance.test.ts
 *
 * ComplianceGate (#1) — beforeAuthorize, GLOBAL, fail-closed. Mocks the
 * KV set ops (sismember / sadd / scard) + meta + ops-alert.
 *
 * Load-bearing assertions:
 *   - sanctioned recipient → deny COMPLIANCE_BLOCKED (451)
 *   - clean recipient → allow
 *   - KV sismember THROWS → propagates (dispatcher fail-closes)
 *   - empty snapshot → applySanctionedSnapshot refuses (protects the
 *     good set from a bad fetch)
 *   - stale list (default) → alert, NOT block
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockKv = vi.hoisted(() => ({
  sismember: vi.fn(),
  sadd: vi.fn(),
  scard: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
const mockAlerts = vi.hoisted(() => ({ sendOpsAlert: vi.fn(() => Promise.resolve()) }));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));
vi.mock("@/app/lib/ops-alerts", () => mockAlerts);

import {
  complianceGate,
  isSanctioned,
  applySanctionedSnapshot,
} from "@/app/lib/hooks/compliance";
import type { HookContext } from "@/app/lib/hooks/types";

const SANCTIONED = "0x" + "1".repeat(40);
const CLEAN = "0x" + "2".repeat(40);

function ctx(recipient: string): HookContext {
  return {
    lifecycle: "beforeAuthorize",
    owner: "0xowner",
    walletId: "0xwallet",
    chain: "bnb",
    token: "USDC",
    recipient,
    amount: "1.5",
    amountUsd: 1.5,
    source: "send",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: fresh meta so staleness check is a no-op unless overridden.
  mockKv.get.mockResolvedValue({ lastRefresh: Date.now(), count: 100, source: "test" });
  mockKv.set.mockResolvedValue("OK");
  delete process.env.OFAC_STALE_BEHAVIOR;
});

describe("ComplianceGate.shouldRun", () => {
  it("always true (compliance is not opt-in)", () => {
    expect(complianceGate.shouldRun(ctx(CLEAN))).toBe(true);
  });
});

describe("ComplianceGate.run", () => {
  it("denies COMPLIANCE_BLOCKED (451) for a sanctioned recipient", async () => {
    mockKv.sismember.mockResolvedValue(1);
    const r = await complianceGate.run(ctx(SANCTIONED));
    expect(r).toMatchObject({ action: "deny", code: "COMPLIANCE_BLOCKED", status: 451 });
  });

  it("allows a clean recipient", async () => {
    mockKv.sismember.mockResolvedValue(0);
    const r = await complianceGate.run(ctx(CLEAN));
    expect(r.action).toBe("allow");
  });

  it("propagates a KV read error (dispatcher fail-closes)", async () => {
    mockKv.sismember.mockRejectedValue(new Error("kv down"));
    await expect(complianceGate.run(ctx(CLEAN))).rejects.toThrow(/kv down/);
  });

  it("lowercases the recipient before the membership check", async () => {
    mockKv.sismember.mockResolvedValue(0);
    await complianceGate.run(ctx("0x" + "A".repeat(40)));
    expect(mockKv.sismember).toHaveBeenCalledWith("ofac:sanctioned", "0x" + "a".repeat(40));
  });
});

describe("ComplianceGate.run — staleness", () => {
  it("stale list (default behavior) → alert but ALLOW", async () => {
    mockKv.sismember.mockResolvedValue(0);
    mockKv.get.mockResolvedValue({ lastRefresh: Date.now() - 49 * 3600 * 1000, count: 100, source: "test" });
    mockKv.set.mockResolvedValue("OK"); // dedup claim succeeds
    const r = await complianceGate.run(ctx(CLEAN));
    expect(r.action).toBe("allow");
    expect(mockAlerts.sendOpsAlert).toHaveBeenCalled();
  });

  it("stale list + OFAC_STALE_BEHAVIOR=block → throws (dispatcher denies)", async () => {
    mockKv.sismember.mockResolvedValue(0);
    mockKv.get.mockResolvedValue({ lastRefresh: Date.now() - 49 * 3600 * 1000, count: 100, source: "test" });
    process.env.OFAC_STALE_BEHAVIOR = "block";
    await expect(complianceGate.run(ctx(CLEAN))).rejects.toThrow(/stale/i);
  });

  it("fresh list → no alert", async () => {
    mockKv.sismember.mockResolvedValue(0);
    await complianceGate.run(ctx(CLEAN));
    expect(mockAlerts.sendOpsAlert).not.toHaveBeenCalled();
  });
});

describe("isSanctioned", () => {
  it("returns true on member", async () => {
    mockKv.sismember.mockResolvedValue(1);
    expect(await isSanctioned(SANCTIONED)).toBe(true);
  });
  it("returns false on non-member", async () => {
    mockKv.sismember.mockResolvedValue(0);
    expect(await isSanctioned(CLEAN)).toBe(false);
  });
});

describe("applySanctionedSnapshot", () => {
  it("refuses an empty snapshot (protects the good set)", async () => {
    await expect(applySanctionedSnapshot([], "test")).rejects.toThrow(/empty/);
  });

  it("refuses a snapshot with no valid addresses", async () => {
    await expect(applySanctionedSnapshot(["garbage", "not-an-addr"], "test")).rejects.toThrow(/no valid/);
  });

  it("adds valid lowercased addresses + writes meta", async () => {
    mockKv.sadd.mockResolvedValue(2);
    mockKv.scard.mockResolvedValue(2);
    const r = await applySanctionedSnapshot(
      ["0x" + "A".repeat(40), "0x" + "B".repeat(40), "garbage"],
      "test-source",
    );
    expect(r.total).toBe(2);
    expect(mockKv.sadd).toHaveBeenCalledWith(
      "ofac:sanctioned",
      "0x" + "a".repeat(40),
      "0x" + "b".repeat(40),
    );
    expect(mockKv.set).toHaveBeenCalledWith(
      "ofac:meta",
      expect.objectContaining({ count: 2, source: "test-source" }),
    );
  });
});
