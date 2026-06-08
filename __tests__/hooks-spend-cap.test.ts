/**
 * hooks-spend-cap.test.ts
 *
 * SpendCapPolicy — beforeAuthorize. allowlist (deny), time window (deny),
 * soft per-call cap (require_approval). Mocks per-wallet config; time
 * window tests control the clock via a fixed Date.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({ getWalletHookConfig: vi.fn() }));
vi.mock("@/app/lib/hooks/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks/config")>();
  return { ...actual, getWalletHookConfig: mockConfig.getWalletHookConfig };
});

import { spendCapPolicy } from "@/app/lib/hooks/spend-cap";
import type { HookContext, WalletHookConfig } from "@/app/lib/hooks/types";

const ALLOWED = "0x" + "a".repeat(40);
const OTHER = "0x" + "b".repeat(40);

function ctx(over: Partial<HookContext> = {}): HookContext {
  return {
    lifecycle: "beforeAuthorize",
    owner: "0xowner",
    walletId: "0xwallet",
    chain: "bnb",
    token: "USDC",
    recipient: ALLOWED,
    amount: "5",
    amountUsd: 5,
    source: "send",
    ...over,
  };
}

function enable(sc: NonNullable<WalletHookConfig["spendCap"]>) {
  mockConfig.getWalletHookConfig.mockResolvedValue({ spendCap: sc });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("SpendCapPolicy.shouldRun", () => {
  it("false when not enabled", async () => {
    mockConfig.getWalletHookConfig.mockResolvedValue(null);
    expect(await spendCapPolicy.shouldRun(ctx())).toBe(false);
  });
  it("true when enabled", async () => {
    enable({ enabled: true });
    expect(await spendCapPolicy.shouldRun(ctx())).toBe(true);
  });
});

describe("SpendCapPolicy — allowedRecipients", () => {
  it("allows a whitelisted recipient", async () => {
    enable({ enabled: true, allowedRecipients: [ALLOWED] });
    expect((await spendCapPolicy.run(ctx())).action).toBe("allow");
  });
  it("denies RECIPIENT_NOT_ALLOWED for an unlisted recipient", async () => {
    enable({ enabled: true, allowedRecipients: [OTHER] });
    const r = await spendCapPolicy.run(ctx({ recipient: ALLOWED }));
    expect(r).toMatchObject({ action: "deny", code: "RECIPIENT_NOT_ALLOWED" });
  });
  it("case-insensitive match", async () => {
    enable({ enabled: true, allowedRecipients: [ALLOWED.toUpperCase()] });
    expect((await spendCapPolicy.run(ctx({ recipient: ALLOWED.toLowerCase() }))).action).toBe("allow");
  });
});

describe("SpendCapPolicy — allowedWindowsUtc", () => {
  it("allows inside the window", async () => {
    vi.setSystemTime(new Date("2026-06-08T10:00:00Z")); // hour 10
    enable({ enabled: true, allowedWindowsUtc: [{ startHour: 9, endHour: 17 }] });
    expect((await spendCapPolicy.run(ctx())).action).toBe("allow");
  });
  it("denies OUTSIDE_ALLOWED_WINDOW outside the window", async () => {
    vi.setSystemTime(new Date("2026-06-08T03:00:00Z")); // hour 3
    enable({ enabled: true, allowedWindowsUtc: [{ startHour: 9, endHour: 17 }] });
    const r = await spendCapPolicy.run(ctx());
    expect(r).toMatchObject({ action: "deny", code: "OUTSIDE_ALLOWED_WINDOW" });
  });
  it("endHour is exclusive (hour 17 with window 9..17 is OUT)", async () => {
    vi.setSystemTime(new Date("2026-06-08T17:00:00Z"));
    enable({ enabled: true, allowedWindowsUtc: [{ startHour: 9, endHour: 17 }] });
    expect((await spendCapPolicy.run(ctx())).action).toBe("deny");
  });
});

describe("SpendCapPolicy — perCallApprovalUsd (soft cap)", () => {
  it("allows below the threshold", async () => {
    enable({ enabled: true, perCallApprovalUsd: 100 });
    expect((await spendCapPolicy.run(ctx({ amountUsd: 50 }))).action).toBe("allow");
  });
  it("require_approval at/above the threshold", async () => {
    enable({ enabled: true, perCallApprovalUsd: 100 });
    const r = await spendCapPolicy.run(ctx({ amountUsd: 100 }));
    expect(r).toMatchObject({ action: "require_approval", code: "APPROVAL_REQUIRED_OVER_CAP", status: 202 });
  });
  it("require_approval strictly above", async () => {
    enable({ enabled: true, perCallApprovalUsd: 100 });
    expect((await spendCapPolicy.run(ctx({ amountUsd: 250 }))).action).toBe("require_approval");
  });
});

describe("SpendCapPolicy — precedence within the policy", () => {
  it("deny (allowlist) beats require_approval (soft cap)", async () => {
    // Unlisted recipient AND over the soft cap → the hard deny wins.
    enable({ enabled: true, allowedRecipients: [OTHER], perCallApprovalUsd: 1 });
    const r = await spendCapPolicy.run(ctx({ recipient: ALLOWED, amountUsd: 1000 }));
    expect(r).toMatchObject({ action: "deny", code: "RECIPIENT_NOT_ALLOWED" });
  });
  it("allowed recipient but over cap → require_approval", async () => {
    enable({ enabled: true, allowedRecipients: [ALLOWED], perCallApprovalUsd: 100 });
    const r = await spendCapPolicy.run(ctx({ recipient: ALLOWED, amountUsd: 500 }));
    expect(r).toMatchObject({ action: "require_approval" });
  });
});
