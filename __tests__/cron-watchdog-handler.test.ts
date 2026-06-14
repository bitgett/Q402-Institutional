/**
 * cron-watchdog-handler.test.ts
 *
 * HANDLER-LEVEL integration test — invokes the actual GET handler of
 * /api/cron/cron-watchdog (not a source-grep). Starts closing the
 * "1352 tests but 0 exercise a route handler" gap flagged in DD.
 *
 * Load-bearing assertions:
 *   - a cron stale past its CRON_META.staleAfterMs → critical ops alert
 *   - a cron that has NEVER reported (getCronStatus → null) → alert
 *   - all crons fresh → NO alert
 *   - the watchdog records its own status every run
 *   - mocked-out auth denial short-circuits (401 path is exercised by the
 *     real requireCronAuth elsewhere; here we authorise and test the logic)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAlerts = vi.hoisted(() => ({ sendOpsAlert: vi.fn(() => Promise.resolve()) }));
const mockGetCronStatus = vi.hoisted(() => vi.fn());
const mockRecordCronStatus = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/app/lib/ops-alerts", () => mockAlerts);
vi.mock("@/app/lib/cron-auth", () => ({ requireCronAuth: vi.fn(() => null) }));
// Partial-mock cron-status: keep the REAL CRON_NAMES + CRON_META (the watchdog
// iterates CRON_META), swap only the I/O.
vi.mock("@/app/lib/cron-status", async (importActual) => {
  const actual = await importActual<typeof import("@/app/lib/cron-status")>();
  return { ...actual, getCronStatus: mockGetCronStatus, recordCronStatus: mockRecordCronStatus };
});

import { GET } from "@/app/api/cron/cron-watchdog/route";
import type { NextRequest } from "next/server";

const fakeReq = {} as unknown as NextRequest;

beforeEach(() => {
  mockAlerts.sendOpsAlert.mockClear();
  mockGetCronStatus.mockReset();
  mockRecordCronStatus.mockClear();
});

describe("cron-watchdog handler", () => {
  it("pages ops (critical) when a cron is stale past its window", async () => {
    // deposit-scan staleAfterMs is 15min; return a 60-min-old record for it,
    // fresh for everything else.
    mockGetCronStatus.mockImplementation(async (name: string) => ({
      name,
      lastFiredAt: name === "deposit-scan" ? Date.now() - 60 * 60_000 : Date.now() - 1_000,
      lastStatus: "success" as const,
    }));

    const res = await GET(fakeReq);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.staleCount).toBe(1);
    expect(body.stale.map((s: { name: string }) => s.name)).toContain("deposit-scan");
    expect(mockAlerts.sendOpsAlert).toHaveBeenCalledTimes(1);
    const [message, severity] = mockAlerts.sendOpsAlert.mock.calls[0] as unknown as [string, string];
    expect(severity).toBe("critical");
    expect(message).toContain("deposit-scan");
  });

  it("treats a NEVER-fired cron (null status) as stale and alerts", async () => {
    mockGetCronStatus.mockImplementation(async (name: string) =>
      name === "ccip-pending-fund-reconcile"
        ? null
        : { name, lastFiredAt: Date.now() - 1_000, lastStatus: "success" as const },
    );

    const res = await GET(fakeReq);
    const body = await res.json();

    expect(body.staleCount).toBe(1);
    expect(body.stale.map((s: { name: string; ageMs: number | null }) => s)).toContainEqual(
      expect.objectContaining({ name: "ccip-pending-fund-reconcile", ageMs: null }),
    );
    expect(mockAlerts.sendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("does NOT alert when every cron is fresh", async () => {
    mockGetCronStatus.mockImplementation(async (name: string) => ({
      name,
      lastFiredAt: Date.now() - 1_000,
      lastStatus: "success" as const,
    }));

    const res = await GET(fakeReq);
    const body = await res.json();

    expect(body.staleCount).toBe(0);
    expect(mockAlerts.sendOpsAlert).not.toHaveBeenCalled();
  });

  it("records its own cron status every run", async () => {
    mockGetCronStatus.mockResolvedValue({ name: "x", lastFiredAt: Date.now(), lastStatus: "success" as const });
    await GET(fakeReq);
    expect(mockRecordCronStatus).toHaveBeenCalledWith("cron-watchdog", expect.objectContaining({ lastStatus: "success" }));
  });
});
