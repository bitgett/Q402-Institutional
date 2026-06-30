/**
 * referral.test.ts — referral counting integrity.
 *
 * No rewards ride on the count, but it still has to be HONEST: deterministic
 * per-owner code, no self-referral, and exactly-once per referee even if the
 * claim runs twice (re-create, retry). The SET NX on ref:claimed is the
 * exactly-once guarantee; these tests pin it against an in-memory kv.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory @vercel/kv stand-in covering the ops referral.ts uses.
const store = new Map<string, unknown>();
function norm(arr: unknown[], start: number, end: number): unknown[] {
  const n = arr.length;
  const s = start < 0 ? Math.max(n + start, 0) : start;
  const e = end < 0 ? n + end : end;
  return arr.slice(s, e + 1);
}
vi.mock("@vercel/kv", () => ({
  kv: {
    set: async (key: string, value: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => (store.has(key) ? store.get(key) : null),
    incr: async (key: string) => {
      const n = ((store.get(key) as number) ?? 0) + 1;
      store.set(key, n);
      return n;
    },
    rpush: async (key: string, ...vals: unknown[]) => {
      const arr = (store.get(key) as unknown[]) ?? [];
      arr.push(...vals);
      store.set(key, arr);
      return arr.length;
    },
    lrange: async (key: string, start: number, end: number) =>
      norm(((store.get(key) as unknown[]) ?? []), start, end),
    ltrim: async (key: string, start: number, end: number) => {
      store.set(key, norm(((store.get(key) as unknown[]) ?? []), start, end));
      return "OK";
    },
    zincrby: async (key: string, inc: number, member: string) => {
      const z = (store.get(key) as Record<string, number>) ?? {};
      z[member] = (z[member] ?? 0) + inc;
      store.set(key, z);
      return z[member];
    },
    zrevrank: async (key: string, member: string) => {
      const z = (store.get(key) as Record<string, number>) ?? {};
      if (!(member in z)) return null;
      const sorted = Object.entries(z).sort((a, b) => b[1] - a[1]).map(([m]) => m);
      return sorted.indexOf(member);
    },
    zcard: async (key: string) => Object.keys((store.get(key) as Record<string, number>) ?? {}).length,
    zrange: async (key: string, start: number, stop: number, opts?: { rev?: boolean; withScores?: boolean }) => {
      const z = (store.get(key) as Record<string, number>) ?? {};
      let e = Object.entries(z).sort((a, b) => (opts?.rev ? b[1] - a[1] : a[1] - b[1]));
      e = e.slice(start, stop + 1);
      return opts?.withScores ? e.flatMap(([m, s]) => [m, s]) : e.map(([m]) => m);
    },
  },
}));

import {
  referralCodeFor,
  getOrCreateReferralCode,
  claimReferral,
  getReferralStats,
} from "@/app/lib/referral";

const A = "0xAAaA0000000000000000000000000000000000A1"; // referrer
const B = "0xBbBB0000000000000000000000000000000000b2"; // referee
const C = "0xCccC0000000000000000000000000000000000c3"; // another referee

beforeEach(() => store.clear());

describe("referral code", () => {
  it("is deterministic per owner and case-insensitive", () => {
    expect(referralCodeFor(A)).toBe(referralCodeFor(A.toLowerCase()));
    expect(referralCodeFor(A)).not.toBe(referralCodeFor(B));
  });
  it("is short + URL-safe (base36)", () => {
    const code = referralCodeFor(A);
    expect(code).toMatch(/^[0-9a-z]+$/);
    expect(code.length).toBeLessThanOrEqual(12);
  });
});

describe("claimReferral", () => {
  it("ignores an unknown code", async () => {
    const r = await claimReferral(B, "nope-not-a-code");
    expect(r.counted).toBe(false);
    expect(r.reason).toBe("unknown_code");
  });

  it("blocks self-referral", async () => {
    const code = await getOrCreateReferralCode(A);
    const r = await claimReferral(A, code);
    expect(r.counted).toBe(false);
    expect(r.reason).toBe("self");
    expect((await getReferralStats(A)).count).toBe(0);
  });

  it("counts a valid new referee exactly once", async () => {
    const code = await getOrCreateReferralCode(A);

    const first = await claimReferral(B, code);
    expect(first.counted).toBe(true);

    const stats = await getReferralStats(A);
    expect(stats.count).toBe(1);
    expect(stats.referees.map((r) => r.address)).toContain(B.toLowerCase());

    // Re-claim for the SAME referee (re-create / retry) must NOT double-count.
    const again = await claimReferral(B, code);
    expect(again.counted).toBe(false);
    expect(again.reason).toBe("already_claimed");
    expect((await getReferralStats(A)).count).toBe(1);
  });

  it("counts distinct referees", async () => {
    const code = await getOrCreateReferralCode(A);
    await claimReferral(B, code);
    await claimReferral(C, code);
    expect((await getReferralStats(A)).count).toBe(2);
  });

  it("ranks inviters on the leaderboard by count", async () => {
    const D = "0xDddD0000000000000000000000000000000000d4"; // second referrer
    const F = "0xEeeE0000000000000000000000000000000000e5"; // D's referee
    const codeA = await getOrCreateReferralCode(A);
    const codeD = await getOrCreateReferralCode(D);
    // A refers two (B, C); D refers one (F) → A is #1, D is #2, 2 inviters total.
    await claimReferral(B, codeA);
    await claimReferral(C, codeA);
    await claimReferral(F, codeD);

    const a = await getReferralStats(A);
    const d = await getReferralStats(D);
    expect(a.rank).toBe(1);
    expect(d.rank).toBe(2);
    expect(a.totalInviters).toBe(2);
    // Leaderboard: highest count first (A:2, D:1).
    expect(a.leaderboard.map((l) => l.address)).toEqual([A.toLowerCase(), D.toLowerCase()]);
    expect(a.leaderboard[0].count).toBe(2);
  });

  it("rank is null with no referrals", async () => {
    const stats = await getReferralStats(A);
    expect(stats.rank).toBeNull();
    expect(stats.totalInviters).toBe(0);
  });
});
