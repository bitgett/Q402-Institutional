/**
 * agentic-wallet-cron-schedule.test.ts
 *
 * Guarantee that the Agent Wallet hard-delete cron is registered in
 * vercel.json. The handler at /api/cron/agentic-wallet-gc has been in
 * the repo since Phase 3, but was missing from `crons[]` — meaning the
 * "7-day grace then hard-delete" promise made to users was materially
 * untrue in production: encrypted private keys lingered in KV forever.
 *
 * Adding the schedule entry is one-line in vercel.json; this test
 * keeps it from drifting back out.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const vercelJson = JSON.parse(
  readFileSync(resolve(__dirname, "..", "vercel.json"), "utf8"),
) as { crons?: Array<{ path: string; schedule: string }> };

describe("vercel.json — cron registration", () => {
  it("declares an array of crons", () => {
    expect(Array.isArray(vercelJson.crons)).toBe(true);
  });

  it("registers /api/cron/agentic-wallet-gc on a daily-or-more-frequent schedule", () => {
    const gc = vercelJson.crons?.find((c) => c.path === "/api/cron/agentic-wallet-gc");
    expect(gc, "agentic-wallet-gc cron must be registered").toBeDefined();
    // Daily cron pattern (`<min> <hour> * * *`). Reject anything that
    // omits the day-of-month wildcard, which would mean monthly+.
    expect(gc!.schedule).toMatch(/^[\d]+\s+[\d]+\s+\*\s+\*\s+\*$/);
  });

  it("keeps the other cron entries (gas-alert / usage-alert / receipt-backfill) intact", () => {
    const paths = vercelJson.crons?.map((c) => c.path) ?? [];
    expect(paths).toContain("/api/cron/gas-alert");
    expect(paths).toContain("/api/cron/usage-alert");
    expect(paths).toContain("/api/cron/receipt-backfill");
  });
});
