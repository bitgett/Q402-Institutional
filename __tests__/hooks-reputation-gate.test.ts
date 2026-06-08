/**
 * hooks-reputation-gate.test.ts
 *
 * ReputationGate (#2) — beforeSettle. Mocks the per-wallet config read
 * and the two ERC-8004 reads (readAgent for the wallet-binding check,
 * readSummary for the score). Keeps parseAgentIdTag real (pure).
 *
 * The load-bearing assertions are the SECURITY ones: a high-rep agentId
 * attached to a payment going to a DIFFERENT address must hard-deny
 * (REPUTATION_RECIPIENT_MISMATCH), never silently apply the borrowed
 * reputation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({ getWalletHookConfig: vi.fn() }));
const mockErc8004 = vi.hoisted(() => ({ readAgent: vi.fn() }));
const mockRep = vi.hoisted(() => ({ readSummary: vi.fn() }));

vi.mock("@/app/lib/hooks/config", () => mockConfig);
vi.mock("@/app/lib/erc8004", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/erc8004")>();
  return { ...actual, readAgent: mockErc8004.readAgent };
});
vi.mock("@/app/lib/erc8004-reputation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/erc8004-reputation")>();
  return { ...actual, readSummary: mockRep.readSummary };
});

import { reputationGate } from "@/app/lib/hooks/reputation-gate";
import type { HookContext } from "@/app/lib/hooks/types";

const RECIPIENT = "0x" + "a".repeat(40);
const OTHER = "0x" + "b".repeat(40);

function ctx(over: Partial<HookContext> = {}): HookContext {
  return {
    lifecycle: "beforeSettle",
    owner: "0xowner",
    walletId: "0xwallet",
    chain: "bnb",
    token: "USDC",
    recipient: RECIPIENT,
    amount: "1.5",
    amountUsd: 1.5,
    source: "send",
    params: { recipientAgentId: "bsc:42" },
    ...over,
  };
}

function enableGate(minScore: number, onUnknown: "allow" | "deny" = "deny") {
  mockConfig.getWalletHookConfig.mockResolvedValue({
    reputationGate: { enabled: true, minScore, onUnknown },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReputationGate.shouldRun", () => {
  it("false when no config", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue(null);
    expect(await reputationGate.shouldRun(ctx())).toBe(false);
  });
  it("false when gate disabled", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue({
      reputationGate: { enabled: false, minScore: 5, onUnknown: "deny" },
    });
    expect(await reputationGate.shouldRun(ctx())).toBe(false);
  });
  it("true when gate enabled", async () => {
    enableGate(5);
    expect(await reputationGate.shouldRun(ctx())).toBe(true);
  });
});

describe("ReputationGate.run — happy path", () => {
  it("allows when bound wallet matches recipient AND score >= minScore", async () => {
    enableGate(5);
    mockErc8004.readAgent.mockResolvedValue({ owner: OTHER, agentURI: "", wallet: RECIPIENT });
    mockRep.readSummary.mockResolvedValue({ count: 10n, value: 800n, decimals: 2 }); // 8.0
    const r = await reputationGate.run(ctx());
    expect(r.action).toBe("allow");
  });

  it("denies REPUTATION_TOO_LOW when score below minScore", async () => {
    enableGate(5);
    mockErc8004.readAgent.mockResolvedValue({ owner: OTHER, agentURI: "", wallet: RECIPIENT });
    mockRep.readSummary.mockResolvedValue({ count: 3n, value: 200n, decimals: 2 }); // 2.0
    const r = await reputationGate.run(ctx());
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_TOO_LOW" });
  });
});

describe("ReputationGate.run — security (the load-bearing tests)", () => {
  it("HARD denies when claimed agentId's bound wallet != recipient (spoofing)", async () => {
    enableGate(5);
    // Agent #42 is bound to OTHER, but the payment goes to RECIPIENT.
    mockErc8004.readAgent.mockResolvedValue({ owner: OTHER, agentURI: "", wallet: OTHER });
    mockRep.readSummary.mockResolvedValue({ count: 999n, value: 99900n, decimals: 2 }); // huge rep
    const r = await reputationGate.run(ctx());
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_RECIPIENT_MISMATCH" });
    // The high reputation must NOT have been borrowed — score read is irrelevant once mismatch hits.
  });

  it("mismatch deny fires even before reading the score", async () => {
    enableGate(5);
    mockErc8004.readAgent.mockResolvedValue({ owner: OTHER, agentURI: "", wallet: OTHER });
    const r = await reputationGate.run(ctx());
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_RECIPIENT_MISMATCH" });
    expect(mockRep.readSummary).not.toHaveBeenCalled();
  });
});

describe("ReputationGate.run — onUnknown policy", () => {
  it("no recipientAgentId + onUnknown=deny → deny REPUTATION_UNVERIFIED", async () => {
    enableGate(5, "deny");
    const r = await reputationGate.run(ctx({ params: {} }));
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_UNVERIFIED" });
  });

  it("no recipientAgentId + onUnknown=allow → allow", async () => {
    enableGate(5, "allow");
    const r = await reputationGate.run(ctx({ params: {} }));
    expect(r.action).toBe("allow");
  });

  it("agent has no bound wallet + onUnknown=deny → deny", async () => {
    enableGate(5, "deny");
    mockErc8004.readAgent.mockResolvedValue({ owner: OTHER, agentURI: "", wallet: null });
    const r = await reputationGate.run(ctx());
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_UNVERIFIED" });
  });

  it("readAgent RPC throws + onUnknown=allow → allow (policy applies to unverifiable)", async () => {
    enableGate(5, "allow");
    mockErc8004.readAgent.mockRejectedValue(new Error("rpc down"));
    const r = await reputationGate.run(ctx());
    expect(r.action).toBe("allow");
  });

  it("readSummary RPC throws + onUnknown=deny → deny", async () => {
    enableGate(5, "deny");
    mockErc8004.readAgent.mockResolvedValue({ owner: OTHER, agentURI: "", wallet: RECIPIENT });
    mockRep.readSummary.mockRejectedValue(new Error("rpc down"));
    const r = await reputationGate.run(ctx());
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_UNVERIFIED" });
  });

  it("invalid recipientAgentId tag + onUnknown=deny → deny", async () => {
    enableGate(5, "deny");
    const r = await reputationGate.run(ctx({ params: { recipientAgentId: "not-a-number" } }));
    expect(r).toMatchObject({ action: "deny", code: "REPUTATION_UNVERIFIED" });
    expect(mockErc8004.readAgent).not.toHaveBeenCalled();
  });
});
