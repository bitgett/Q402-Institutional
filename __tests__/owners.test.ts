/**
 * owners.test.ts — paywall-bypass list parser + lookup.
 *
 * Locks in three regressions a reviewer flagged after the OPSEC pass that
 * moved the owner list out of tracked source:
 *
 *  1. The list must NEVER reach the client bundle. We can't directly assert
 *     that here, but we can pin that the only export is the `isOwnerWallet`
 *     boolean lookup + the parser helper — there's no `OWNER_LIST` array
 *     export that a client could import.
 *
 *  2. Lookup must be true runtime: changing process.env.OWNER_WALLETS
 *     between calls must change subsequent isOwnerWallet() results, with no
 *     module reload. A build-time-only read would fail this.
 *
 *  3. Invalid env entries must be surfaced (not silently dropped). A typo
 *     in Vercel settings should produce a log line that ops can grep for,
 *     not look like a working config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseOwnerList, isOwnerWallet } from "@/app/lib/owners";

const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";
const NOT_OWNER = "0x9999999999999999999999999999999999999999";
const RELAYER_HOT = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const originalEnv = process.env.OWNER_WALLETS;

beforeEach(() => {
  delete process.env.OWNER_WALLETS;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.OWNER_WALLETS;
  else process.env.OWNER_WALLETS = originalEnv;
});

// ── parseOwnerList ───────────────────────────────────────────────────────────

describe("parseOwnerList — validation", () => {
  it("accepts valid lowercase entries", () => {
    expect(parseOwnerList(`${OWNER_A},${OWNER_B}`, () => {}))
      .toEqual([OWNER_A, OWNER_B]);
  });

  it("lowercases mixed-case input", () => {
    const mixed = "0xAbCdEfABCDEFabcdefABCDEFabcdefABCDEFabcd";
    expect(parseOwnerList(mixed, () => {})).toEqual([mixed.toLowerCase()]);
  });

  it("trims whitespace around entries", () => {
    expect(parseOwnerList(`  ${OWNER_A}  ,\t${OWNER_B}\n`, () => {}))
      .toEqual([OWNER_A, OWNER_B]);
  });

  it("ignores empty / whitespace-only entries", () => {
    expect(parseOwnerList(`${OWNER_A},,  ,${OWNER_B}`, () => {}))
      .toEqual([OWNER_A, OWNER_B]);
  });

  it("returns empty for empty / whitespace input", () => {
    expect(parseOwnerList("", () => {})).toEqual([]);
    expect(parseOwnerList("   ", () => {})).toEqual([]);
  });

  it("drops malformed entries (too short / wrong prefix / non-hex)", () => {
    const warn = vi.fn();
    const out = parseOwnerList(
      `${OWNER_A},0xabc,not-an-address,0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ,${OWNER_B}`,
      warn,
    );
    expect(out).toEqual([OWNER_A, OWNER_B]);
    expect(warn).toHaveBeenCalledTimes(3);
    // Each warning should reference the offending entry literally so ops can
    // grep for it in Vercel function logs.
    expect(warn.mock.calls[0]![0]).toContain('"0xabc"');
    expect(warn.mock.calls[1]![0]).toContain('"not-an-address"');
    expect(warn.mock.calls[2]![0]).toContain("0xZZZZ");
  });
});

// ── isOwnerWallet (runtime semantics) ────────────────────────────────────────

describe("isOwnerWallet — runtime env reads", () => {
  it("returns false for empty/null/undefined", () => {
    expect(isOwnerWallet(null)).toBe(false);
    expect(isOwnerWallet(undefined)).toBe(false);
    expect(isOwnerWallet("")).toBe(false);
  });

  it("always recognizes the relayer hot wallet (no env required)", () => {
    expect(isOwnerWallet(RELAYER_HOT)).toBe(true);
    expect(isOwnerWallet(RELAYER_HOT.toUpperCase())).toBe(true);
  });

  it("returns false when OWNER_WALLETS is unset and address is not relayer", () => {
    expect(isOwnerWallet(OWNER_A)).toBe(false);
  });

  it("recognizes addresses listed in OWNER_WALLETS", () => {
    process.env.OWNER_WALLETS = `${OWNER_A},${OWNER_B}`;
    expect(isOwnerWallet(OWNER_A)).toBe(true);
    expect(isOwnerWallet(OWNER_B)).toBe(true);
    expect(isOwnerWallet(NOT_OWNER)).toBe(false);
  });

  it("is case-insensitive on lookup", () => {
    process.env.OWNER_WALLETS = OWNER_A.toUpperCase();
    expect(isOwnerWallet(OWNER_A)).toBe(true);
    expect(isOwnerWallet(OWNER_A.toUpperCase())).toBe(true);
  });

  it("picks up env changes between calls (true runtime, not build-time)", () => {
    process.env.OWNER_WALLETS = OWNER_A;
    expect(isOwnerWallet(OWNER_A)).toBe(true);
    expect(isOwnerWallet(OWNER_B)).toBe(false);

    // Operator updates the env in Vercel — next request should see new list
    process.env.OWNER_WALLETS = OWNER_B;
    expect(isOwnerWallet(OWNER_A)).toBe(false);
    expect(isOwnerWallet(OWNER_B)).toBe(true);

    // Operator clears the env entirely
    delete process.env.OWNER_WALLETS;
    expect(isOwnerWallet(OWNER_A)).toBe(false);
    expect(isOwnerWallet(OWNER_B)).toBe(false);
    // Relayer hot wallet still recognized — that's the inline floor
    expect(isOwnerWallet(RELAYER_HOT)).toBe(true);
  });
});

// ── Module surface — guard against accidental client export ──────────────────

describe("module surface", () => {
  it("only exports the parser + the boolean lookup (no list export)", async () => {
    const mod = await import("@/app/lib/owners");
    const exported = Object.keys(mod).sort();
    expect(exported).toEqual(["isOwnerWallet", "parseOwnerList"]);
  });
});
