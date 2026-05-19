/**
 * multichain-scope.test.ts
 *
 * Regression cover for the three-axis subscription model:
 *
 *   money   — amountUSD / paidAt
 *   access  — hasMultichainScope()
 *   balance — quota:paid:{addr} scoped read
 *
 * Prior to this split, both the dashboard's "Multichain Locked vs unlocked"
 * gate and the trial-activate ALREADY_PAID guard checked the cash signal
 * `amountUSD > 0`. That conflation meant:
 *
 *   1. Operational grants (admin-grant.mjs leaves amountUSD === 0 by
 *      design so the books stay honest) rendered as "Locked" on the
 *      Multichain card — credits intact in KV but UI showed 0.
 *
 *   2. A grant recipient who then hit /event was waved past the
 *      ALREADY_PAID guard and the trial-activate path overwrote their
 *      paid sub fields (plan, paidAt, amountUSD, txHash) with trial
 *      defaults, eliminating the grant trace from the audit trail.
 *
 *   3. Even after a v1 fix that recognized paidQuotaBonus > 0, any paid
 *      customer who drained their pool would silently revert to "Locked"
 *      the moment their balance hit 0 — credits are balance, not access.
 *
 * hasMultichainScope() encodes the access axis: scope is conferred once
 * (real cash, grant timestamp, mirror slot existence, or admin-grant
 * txHash) and persists regardless of current balance. isCashPaidSubscription()
 * isolates the cash axis for paid-expiry math.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const scanClobberSource = readFileSync(
  resolve(REPO_ROOT, "scripts", "scan-clobbered-grants.mjs"),
  "utf8",
);
const grantSponsoredSource = readFileSync(
  resolve(REPO_ROOT, "scripts", "grant-sponsored-credits.mjs"),
  "utf8",
);
const transferSponsoredSource = readFileSync(
  resolve(REPO_ROOT, "scripts", "transfer-sponsored.mjs"),
  "utf8",
);
const transferSponsoredV2Source = readFileSync(
  resolve(REPO_ROOT, "scripts", "transfer-sponsored-v2.mjs"),
  "utf8",
);
const adminGrantSource = readFileSync(
  resolve(REPO_ROOT, "scripts", "admin-grant.mjs"),
  "utf8",
);
const connectModalSource = readFileSync(
  resolve(REPO_ROOT, "app", "components", "ConnectModal.tsx"),
  "utf8",
);

// ── In-memory KV (shared shape with credit-pool-isolation.test.ts) ───────────
const store = new Map<string, unknown>();

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
  smembers: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hgetall: vi.fn(),
  hincrbyfloat: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));
vi.mock("@/app/lib/ops-alerts", () => ({
  sendOpsAlert: vi.fn(() => Promise.resolve()),
}));

import {
  hasMultichainScope,
  isCashPaidSubscription,
  type Subscription,
} from "@/app/lib/db";

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  mockKv.get.mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null));
  mockKv.set.mockImplementation((key: string, value: unknown, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(key)) return Promise.resolve(null);
    store.set(key, value);
    return Promise.resolve("OK");
  });
  mockKv.incrby.mockImplementation((key: string, n: number) => {
    const cur = (store.get(key) as number | undefined) ?? 0;
    const next = cur + n;
    store.set(key, next);
    return Promise.resolve(next);
  });
  mockKv.decrby.mockImplementation((key: string, n: number) => {
    const cur = (store.get(key) as number | undefined) ?? 0;
    const next = cur - n;
    store.set(key, next);
    return Promise.resolve(next);
  });
});

// Factory — returns a fully-populated Subscription record so tests can
// vary the one or two fields under inspection without re-typing the rest.
function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    apiKey: "q402_live_abcdef000000000000000000000000000000000000000000",
    sandboxApiKey: "q402_test_abcdef000000000000000000000000000000000000000000",
    plan: "starter",
    paidAt: "2026-05-19T17:12:12.000Z",
    amountUSD: 29,
    txHash: "0x" + "a".repeat(64),
    paidQuotaBonus: 500,
    trialQuotaBonus: 0,
    quotaBonus: 500,
    ...overrides,
  };
}

// ── hasMultichainScope — access axis ─────────────────────────────────────────

describe("hasMultichainScope — access axis predicate", () => {
  it("admin-grant: amountUSD=0 + paidQuotaBonus mirror + apiKey → true", () => {
    const sub = makeSub({
      amountUSD: 0,
      paidQuotaBonus: 50000,
      txHash: "admin_grant:1747671132478",
    });
    expect(hasMultichainScope(sub)).toBe(true);
  });

  it("admin-grant after credits drained: paidQuotaBonus=0 but apiKey + admin_grant txHash → still true", () => {
    // Critical case the v1 fix (`paidQuotaBonus > 0`) would have failed:
    // the wallet legitimately holds Multichain access but burned through
    // the granted credits. Dashboard should show "0 credits, top up
    // needed" — not regress to Locked.
    const sub = makeSub({
      amountUSD: 0,
      paidQuotaBonus: 0,
      txHash: "admin_grant:1747671132478",
    });
    expect(hasMultichainScope(sub)).toBe(true);
  });

  it("legacy trial-in-apiKey-slot: plan='trial' + apiKey set → false", () => {
    // Pre-Phase-1 trial activations wrote the trial key into the apiKey
    // slot. The plan === "trial" short-circuit keeps them from being
    // misclassified as paid even though every other signal is benign.
    const sub = makeSub({
      plan: "trial",
      amountUSD: 0,
      paidAt: "",
      paidQuotaBonus: undefined,
      trialExpiresAt: "2026-06-18T00:00:00.000Z",
    });
    expect(hasMultichainScope(sub)).toBe(false);
  });

  it("cash-paid customer mid-window: amountUSD>0 + paidAt + paidQuotaBonus set → true", () => {
    expect(hasMultichainScope(makeSub())).toBe(true);
  });

  it("cash-paid customer with drained pool: paidQuotaBonus=0 + apiKey + amountUSD>0 → still true", () => {
    const sub = makeSub({ paidQuotaBonus: 0, quotaBonus: 0 });
    expect(hasMultichainScope(sub)).toBe(true);
  });

  it("null sub (brand-new wallet) → false", () => {
    expect(hasMultichainScope(null)).toBe(false);
    expect(hasMultichainScope(undefined)).toBe(false);
  });

  it("sub without apiKey (half-provisioned stub) → false", () => {
    const sub = makeSub({ apiKey: "" });
    expect(hasMultichainScope(sub)).toBe(false);
  });

  it("trial-only sub with no paid signals → false", () => {
    const sub: Subscription = {
      apiKey: "",
      plan: "trial",
      paidAt: "2026-05-19T17:14:23.134Z",
      amountUSD: 0,
      txHash: "trial",
      trialApiKey: "q402_live_71f63415d826239c69902a6441bcb99a1ebea6df2d126413",
      trialSandboxApiKey: "q402_test_535468012b77ed22346876778450ad211df5183b72af2a1e",
      trialQuotaBonus: 2000,
      paidQuotaBonus: undefined,
      quotaBonus: 2000,
      trialExpiresAt: "2026-06-18T17:14:23.134Z",
    };
    expect(hasMultichainScope(sub)).toBe(false);
  });

  it("legacy sponsored shape: plan='sponsored' + apiKey, amountUSD=0, paidAt='' → true", () => {
    // Mirror of the production sponsored orphan (0xfe7b…) BEFORE its
    // manual amountUSD=1 nudge. seedFromLegacy admits this as a paid
    // signal; hasMultichainScope must agree or the dashboard renders
    // the Multichain card as Locked while reads succeed — the exact
    // conflation the access/money split is meant to eliminate.
    const sub: Subscription = {
      apiKey: "q402_live_sponsoredkey",
      sandboxApiKey: "q402_test_sponsoredsbox",
      plan: "sponsored",
      paidAt: "",
      amountUSD: 0,
      txHash: "provisioned",
      quotaBonus: 50000,
    };
    expect(hasMultichainScope(sub)).toBe(true);
    // The cash predicate stays strict — sponsored is access, not cash.
    expect(isCashPaidSubscription(sub)).toBe(false);
  });

  it("sponsored without apiKey → false (malformed sub stays locked)", () => {
    const sub: Subscription = {
      apiKey: "",
      plan: "sponsored",
      paidAt: "",
      amountUSD: 0,
      txHash: "",
    };
    expect(hasMultichainScope(sub)).toBe(false);
  });
});

// ── isCashPaidSubscription — money axis ──────────────────────────────────────

describe("isCashPaidSubscription — money axis predicate", () => {
  it("real payment (amountUSD>0 + paidAt) → true", () => {
    expect(isCashPaidSubscription(makeSub())).toBe(true);
  });

  it("admin-grant (amountUSD=0) → false even with paidAt + Multichain scope", () => {
    // Defines the invariant that admin-grants are NOT subject to the
    // paid-expiry 30-day window — that policy lives in relay/route.ts
    // and keys/verify/route.ts via this predicate.
    const sub = makeSub({
      amountUSD: 0,
      txHash: "admin_grant:1747671132478",
    });
    expect(isCashPaidSubscription(sub)).toBe(false);
    // And the same sub still has Multichain access:
    expect(hasMultichainScope(sub)).toBe(true);
  });

  it("missing paidAt → false even with amountUSD>0", () => {
    const sub = makeSub({ paidAt: "" });
    expect(isCashPaidSubscription(sub)).toBe(false);
  });

  it("null sub → false", () => {
    expect(isCashPaidSubscription(null)).toBe(false);
    expect(isCashPaidSubscription(undefined)).toBe(false);
  });
});

// ── Trial-activate sequence regression ───────────────────────────────────────
//
// These exercise the two guards in app/api/trial/activate/route.ts that were
// upgraded to use hasMultichainScope:
//
//   - the ALREADY_PAID guard near the top, which must reject admin-granted
//     wallets so the path below never runs against them
//
//   - the preserve-path inside setSubscription, defense-in-depth that
//     ensures even if the guard is bypassed the paid-side fields are not
//     clobbered
//
// We do not call the route handler directly (too much auth ceremony for
// this test surface); we exercise the helpers and the conditional shape
// the route implements. Real end-to-end coverage lives in the relay/
// activate integration tests.

describe("trial-activate guard + preserve-path semantics", () => {
  it("hasMultichainScope flags admin-granted wallet → ALREADY_PAID guard fires", () => {
    // Sub shape after admin-grant.mjs against a brand-new wallet:
    const sub = makeSub({
      amountUSD: 0,
      paidQuotaBonus: 50000,
      paidAt: "2026-05-19T17:12:12.478Z",
      txHash: "admin_grant:1747671132478",
    });
    expect(hasMultichainScope(sub)).toBe(true);
    // Translation: route.ts returns 409 with code "ALREADY_PAID".
  });

  it("preserve-path: write conditional keeps paid-side fields verbatim", () => {
    // Simulate the spread that trial/activate route.ts performs when the
    // guard is bypassed (race condition, refactor regression).
    const existing = makeSub({
      amountUSD: 0,
      paidQuotaBonus: 50000,
      paidAt: "2026-05-19T17:12:12.478Z",
      txHash: "admin_grant:1747671132478",
      apiKey: "q402_live_grant1",
      sandboxApiKey: "q402_test_grant1",
    });

    const preserveScope = hasMultichainScope(existing);
    expect(preserveScope).toBe(true);

    // Reproduce the conditional from route.ts:
    const next: Partial<Subscription> = preserveScope
      ? {
          apiKey:        existing.apiKey,
          sandboxApiKey: existing.sandboxApiKey,
          plan:          existing.plan,
          paidAt:        existing.paidAt,
          amountUSD:     existing.amountUSD ?? 0,
          txHash:        existing.txHash || "admin_grant:unknown",
        }
      : {
          plan:      "trial",
          paidAt:    new Date().toISOString(),
          amountUSD: 0,
          txHash:    "trial",
        };

    expect(next.apiKey).toBe("q402_live_grant1");
    expect(next.sandboxApiKey).toBe("q402_test_grant1");
    expect(next.plan).toBe("starter");
    expect(next.paidAt).toBe("2026-05-19T17:12:12.478Z");
    expect(next.amountUSD).toBe(0);
    expect(next.txHash).toBe("admin_grant:1747671132478");
  });

  it("preserve-path: brand-new sub falls through to trial defaults", () => {
    const existing: Subscription | null = null;
    const preserveScope = hasMultichainScope(existing);
    expect(preserveScope).toBe(false);

    const next: Partial<Subscription> = preserveScope
      ? { /* unreachable */ }
      : {
          plan:      "trial",
          paidAt:    "2026-05-19T17:14:23.134Z",
          amountUSD: 0,
          txHash:    "trial",
        };

    expect(next.plan).toBe("trial");
    expect(next.txHash).toBe("trial");
    expect(next.amountUSD).toBe(0);
  });
});

// ── scan-clobbered-grants predicate ──────────────────────────────────────────
//
// Mirrors `matchesClobberShape` in scripts/scan-clobbered-grants.mjs. The
// scan script's stage-1 filter must (a) catch every drained clobber whose
// paidQuotaBonus mirror has fallen to 0, and (b) avoid false positives on
// legitimate post-Phase-1 trial-only accounts that explicitly write
// paidQuotaBonus: 0 into the mirror. Stage-2 in the script does an extra
// apikey-record plan check; we cover that path narratively below since
// the stage-1 predicate is the bulk of the false-positive surface.
//
// IMPORTANT: if you change matchesClobberShape in the script, update the
// inlined copy in this test to match.

describe("scan-clobbered-grants predicate (mirror of scripts/scan-clobbered-grants.mjs)", () => {
  function matchesClobberShape(sub: Partial<Subscription> | null | undefined): boolean {
    if (!sub || typeof sub !== "object") return false;
    return (
      sub.plan === "trial" &&
      sub.txHash === "trial" &&
      typeof sub.apiKey === "string" &&
      sub.apiKey.length > 0 &&
      typeof sub.trialApiKey === "string" &&
      sub.trialApiKey.length > 0
    );
  }

  it("drained clobber (paidQuotaBonus=0, both keys set) → flagged", () => {
    // The case that escaped the previous `paidQuotaBonus > 0` filter:
    // admin-grant minted the paid keys + 50k credits, the user drained
    // the pool, then /event trial-activate ran and overwrote
    // plan/txHash/amountUSD. paidQuotaBonus mirror reflects the drained
    // pool (0). apiKey still holds the paid live key; trialApiKey was
    // added by trial-activate.
    const drainedClobber: Partial<Subscription> = {
      plan: "trial",
      txHash: "trial",
      amountUSD: 0,
      paidAt: "2026-05-15T06:58:23.970Z",
      apiKey: "q402_live_paidkey",
      sandboxApiKey: "q402_test_paidsbox",
      trialApiKey: "q402_live_trialkey",
      trialSandboxApiKey: "q402_test_trialsbox",
      paidQuotaBonus: 0,
      trialQuotaBonus: 2000,
      quotaBonus: 2000,
      trialExpiresAt: "2026-06-14T06:58:23.970Z",
    };
    expect(matchesClobberShape(drainedClobber)).toBe(true);
  });

  it("post-Phase-1 trial-only (apiKey='', paidQuotaBonus=0) → not flagged", () => {
    // The false-positive case to avoid: a wallet that signed up for the
    // trial via /event without any prior paid scope. trial-activate
    // writes paidQuotaBonus: 0 (from a paid-pool scoped read on an
    // account that never had paid scope) but leaves apiKey empty.
    const trialOnly: Partial<Subscription> = {
      plan: "trial",
      txHash: "trial",
      amountUSD: 0,
      paidAt: "2026-05-19T17:14:23.134Z",
      apiKey: "",
      sandboxApiKey: undefined,
      trialApiKey: "q402_live_trialkey",
      trialSandboxApiKey: "q402_test_trialsbox",
      paidQuotaBonus: 0,
      trialQuotaBonus: 2000,
      quotaBonus: 2000,
      trialExpiresAt: "2026-06-18T17:14:23.134Z",
    };
    expect(matchesClobberShape(trialOnly)).toBe(false);
  });

  it("legacy pre-Phase-1 trial-in-apiKey-slot → not flagged by stage-1", () => {
    // The other false-positive to consider: pre-Phase-1 trial subs
    // wrote the trial key into the apiKey slot with no trialApiKey.
    // The trialApiKey requirement filters them out at stage 1; the
    // stage-2 apikey-record plan check is a redundant guard.
    const legacyTrial: Partial<Subscription> = {
      plan: "trial",
      txHash: "trial",
      amountUSD: 0,
      paidAt: "2026-02-10T00:00:00.000Z",
      apiKey: "q402_live_legacytrial",
      sandboxApiKey: "q402_test_legacysbox",
      trialApiKey: undefined,
      trialSandboxApiKey: undefined,
      paidQuotaBonus: undefined,
      trialQuotaBonus: 1234,
      quotaBonus: 1234,
    };
    expect(matchesClobberShape(legacyTrial)).toBe(false);
  });

  it("fresh clobber with paidQuotaBonus>0 still flagged (regression for v1 scan)", () => {
    // Same sub shape as 0x8eae... before its hot-patch — both the
    // narrow (paidQuotaBonus > 0) and the tightened (apiKey +
    // trialApiKey both set) signatures must catch this.
    const freshClobber: Partial<Subscription> = {
      plan: "trial",
      txHash: "trial",
      amountUSD: 0,
      paidAt: "2026-05-19T17:14:23.134Z",
      apiKey: "q402_live_paidkey",
      trialApiKey: "q402_live_trialkey",
      paidQuotaBonus: 50000,
      trialQuotaBonus: 2000,
      quotaBonus: 52000,
    };
    expect(matchesClobberShape(freshClobber)).toBe(true);
  });

  it("paid customer mid-window → not flagged", () => {
    // Sanity check: a normal paying customer is not a clobber candidate.
    const paidCustomer: Partial<Subscription> = {
      plan: "starter",
      txHash: "0x" + "a".repeat(64),
      amountUSD: 29,
      paidAt: "2026-05-01T00:00:00.000Z",
      apiKey: "q402_live_paidkey",
      paidQuotaBonus: 500,
      trialQuotaBonus: 0,
      quotaBonus: 500,
    };
    expect(matchesClobberShape(paidCustomer)).toBe(false);
  });

  it("admin-grant pre-clobber (plan='starter') → not flagged", () => {
    // The state immediately after admin-grant.mjs runs, before any
    // /event activation. plan="starter" and txHash="admin_grant:..."
    // both differ from the clobber signature.
    const freshGrant: Partial<Subscription> = {
      plan: "starter",
      txHash: "admin_grant:1747671132478",
      amountUSD: 0,
      paidAt: "2026-05-19T17:12:12.478Z",
      apiKey: "q402_live_grantkey",
      paidQuotaBonus: 50000,
      trialQuotaBonus: 0,
      quotaBonus: 50000,
    };
    expect(matchesClobberShape(freshGrant)).toBe(false);
  });
});

// ── source-grep guards on the operational scripts ────────────────────────────
//
// The inlined predicate above covers stage-1 behavior; the script's stage-2
// (read apikey:{sub.apiKey} and reject when the record's plan === "trial")
// is the second half of the false-positive defence. Source-grep makes both
// halves load-bearing: removing the kv.get or the plan filter trips a test.
// Likewise, the deprecated sponsored entry points must stay aborting before
// any kv.set runs — drop the exit guard and we silently regress to creating
// legacy single-pool subs again.

describe("scan-clobbered-grants source guards", () => {
  it("stage-1 filter requires plan='trial' AND txHash='trial' AND apiKey AND trialApiKey", () => {
    // matchesClobberShape function body — anchor on the function declaration
    // so we measure the actual filter, not a doc-block.
    const fnBlock = scanClobberSource.match(
      /function\s+matchesClobberShape\s*\(\s*sub\s*\)\s*\{[\s\S]+?\n\}/,
    );
    expect(fnBlock).toBeTruthy();
    const body = fnBlock![0];
    expect(body).toMatch(/sub\.plan\s*===\s*["']trial["']/);
    expect(body).toMatch(/sub\.txHash\s*===\s*["']trial["']/);
    expect(body).toMatch(/typeof\s+sub\.apiKey\s*===\s*["']string["']/);
    expect(body).toMatch(/typeof\s+sub\.trialApiKey\s*===\s*["']string["']/);
  });

  it("stage-2 reads apikey:{sub.apiKey} record and rejects when record.plan === 'trial'", () => {
    // The reviewer's specific lock-in: this stage is the unforgable check
    // (paid-side key in the apiKey slot) and must not be skippable.
    expect(scanClobberSource).toMatch(/kv\.get\(\s*`apikey:\$\{\s*sub\.apiKey\s*\}`\s*\)/);
    expect(scanClobberSource).toMatch(/keyRecord\.plan\s*===\s*["']trial["']/);
  });

  it("stage-2 check runs in BOTH the scan loop and the apply-restore loop", () => {
    // Both passes must filter — otherwise a candidate that passed stage-2
    // at scan time but had its apikey record rotated mid-script could be
    // restored as a paid sub with a stale apikey. Count occurrences:
    // we expect at least two kv.get calls against the apikey record.
    const matches = scanClobberSource.match(
      /kv\.get\(\s*`apikey:\$\{\s*sub\.apiKey\s*\}`\s*\)/g,
    );
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("admin-grant.mjs seed-first parity", () => {
  // The production helper app/lib/db.ts:addScopedCredits seeds the scoped
  // pool from any legacy quota:{addr} balance BEFORE adding the new
  // grant. Without parity in the script, an admin-grant against a
  // legacy sponsored wallet would silently drop the legacy 50k. These
  // guards lock the behaviour at source-grep level so a future
  // refactor cannot quietly remove the seed call.

  it("imports the legacy quota key helper", () => {
    // Inline mirror needs the legacyQuotaKey accessor to read the
    // legacy single-pool value before computing the seed amount.
    expect(adminGrantSource).toMatch(/legacyQuotaKey\s*=\s*\(addr\)\s*=>/);
    expect(adminGrantSource).toMatch(/`quota:\$\{addr\.toLowerCase\(\)\}`/);
  });

  it("defines inlineSeedFromLegacy with the sponsored paid signal", () => {
    // Sync requirement: matches the structured branches added to
    // app/lib/db.ts seedFromLegacy in this PR (cash-paid + sponsored).
    const fn = adminGrantSource.match(
      /async function inlineSeedFromLegacy\([\s\S]+?\n\}/,
    );
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/hasCashPaidSignal/);
    expect(body).toMatch(/hasSponsoredLegacyPaidSignal/);
    expect(body).toMatch(/sub\?\.plan\s*===\s*["']sponsored["']\s*&&\s*!!sub\?\.apiKey/);
  });

  it("calls inlineSeedFromLegacy before SET NX on the scoped key", () => {
    // The seed call must precede `kv.set(scopedQuotaKey(...), 0|seed, { nx: true })`
    // and feed its return value INTO that SET. Otherwise the SET NX
    // initialises with 0 and the legacy balance is lost.
    const seedCallIdx = adminGrantSource.indexOf("inlineSeedFromLegacy(ADDR");
    expect(seedCallIdx).toBeGreaterThan(-1);

    const seedNxBlock = adminGrantSource.match(
      /const\s+seed\s*=\s*await\s+inlineSeedFromLegacy\(ADDR[\s\S]+?kv\.set\(\s*scopedQuotaKey\(ADDR,\s*flags\.scope\),\s*seed,\s*\{\s*nx:\s*true\s*\}/,
    );
    expect(seedNxBlock).toBeTruthy();
  });

  it("syncs sub mirror fields from the actual scoped pools after INCRBY", () => {
    // After the legacy seed + INCRBY, the script's plan.newSub object
    // (built earlier with `flags.amount` only) under-reports the
    // post-grant balance whenever a non-zero legacy quota was seeded
    // in. Re-reading both scoped pools right before `kv.set(subKey,
    // plan.newSub)` and overwriting the three mirror fields keeps
    // mirror readers (usage-alert, topup, seedFromLegacy's final
    // fallback) aligned with the truth.
    const mirrorSyncBlock = adminGrantSource.match(
      /const\s+finalPaid[\s\S]+?const\s+finalTrial[\s\S]+?plan\.newSub\.paidQuotaBonus\s*=\s*finalPaid[\s\S]+?plan\.newSub\.trialQuotaBonus\s*=\s*finalTrial[\s\S]+?plan\.newSub\.quotaBonus\s*=\s*finalPaid\s*\+\s*finalTrial[\s\S]+?kv\.set\(\s*subKey\(ADDR\),\s*plan\.newSub\s*\)/,
    );
    expect(mirrorSyncBlock).toBeTruthy();
  });
});

describe("ConnectModal — responsive Google button width", () => {
  // The GIS rendered button takes a pixel-width API, so we can't just
  // make it `w-full`. On narrow mobile viewports the desktop-ideal
  // 392px width used to overflow the modal panel. ConnectModal now
  // measures the actual rendered rail and clamps the GIS button to
  // it via a ResizeObserver. These guards keep that wiring intact.

  it("uses a ResizeObserver to track the Google+Email rail width", () => {
    expect(connectModalSource).toMatch(/new\s+ResizeObserver/);
  });

  it("clamps the dynamic width between the GIS min and the desktop ideal", () => {
    expect(connectModalSource).toMatch(/GOOGLE_DESKTOP_WIDTH\s*=\s*392/);
    expect(connectModalSource).toMatch(/GOOGLE_MIN_WIDTH\s*=\s*200/);
    expect(connectModalSource).toMatch(/Math\.max\(GOOGLE_MIN_WIDTH/);
    expect(connectModalSource).toMatch(/Math\.min\(GOOGLE_DESKTOP_WIDTH/);
  });

  it("passes the measured width into GoogleSigninButton (no hard-coded 392)", () => {
    // The earlier hard-coded `width={392}` was the regression — the
    // rail size now flows through state.
    expect(connectModalSource).toMatch(/<GoogleSigninButton[\s\S]*?width=\{\s*googleWidth\s*\}/);
    expect(connectModalSource).not.toMatch(/<GoogleSigninButton[\s\S]*?width=\{\s*392\s*\}/);
  });
});

describe("legacy sponsored entry points stay blocked", () => {
  // The three scripts that historically wrote the legacy single-pool
  // sponsored shape. seedFromLegacy's plan === "sponsored" escape hatch
  // exists solely to keep the one production orphan operational; new
  // sponsored subs would each require their own per-account workaround.
  // Each script must abort before any kv.set with the DEPRECATED message
  // and a non-zero exit so cron-style runs do not silently mint state.

  it("grant-sponsored-credits.mjs aborts before any kv.set", () => {
    expect(grantSponsoredSource).toMatch(/DEPRECATED/);
    expect(grantSponsoredSource).toMatch(/process\.exit\(\s*2\s*\)/);
    // No kv.set in the live code path. The original implementation lives
    // in git history.
    expect(grantSponsoredSource).not.toMatch(/await\s+kv\.set\(/);
    expect(grantSponsoredSource).not.toMatch(/kv\.incrby\(/);
  });

  it("transfer-sponsored.mjs aborts before any kv.set", () => {
    expect(transferSponsoredSource).toMatch(/DEPRECATED/);
    expect(transferSponsoredSource).toMatch(/process\.exit\(\s*2\s*\)/);
    expect(transferSponsoredSource).not.toMatch(/await\s+kv\.set\(/);
    expect(transferSponsoredSource).not.toMatch(/kv\.incrby\(/);
  });

  it("transfer-sponsored-v2.mjs aborts before any kv.set", () => {
    expect(transferSponsoredV2Source).toMatch(/DEPRECATED/);
    expect(transferSponsoredV2Source).toMatch(/process\.exit\(\s*2\s*\)/);
    expect(transferSponsoredV2Source).not.toMatch(/await\s+kv\.set\(/);
    expect(transferSponsoredV2Source).not.toMatch(/kv\.incrby\(/);
  });
});
