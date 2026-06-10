/**
 * hooks-config.test.ts
 *
 * Pure validation logic for the per-wallet hook config + the shared
 * split-sum invariant. No KV — exercises validateWalletHookConfig and
 * assertSplitsSumTo10000 directly.
 */

import { describe, it, expect } from "vitest";
import {
  validateWalletHookConfig,
  assertSplitsSumTo10000,
} from "@/app/lib/hooks/config";
import type { WalletHookConfig } from "@/app/lib/hooks/types";

describe("validateWalletHookConfig", () => {
  it("accepts an empty config", () => {
    expect(() => validateWalletHookConfig({})).not.toThrow();
  });

  it("accepts a valid reputationGate", () => {
    const c: WalletHookConfig = {
      reputationGate: { enabled: true, minScore: 5, onUnknown: "deny" },
    };
    expect(() => validateWalletHookConfig(c)).not.toThrow();
  });

  it("rejects non-boolean reputationGate.enabled", () => {
    const c = { reputationGate: { enabled: "yes", minScore: 5, onUnknown: "deny" } } as unknown as WalletHookConfig;
    expect(() => validateWalletHookConfig(c)).toThrow(/enabled must be boolean/);
  });

  it("rejects non-finite minScore", () => {
    const c: WalletHookConfig = {
      reputationGate: { enabled: true, minScore: Number.NaN, onUnknown: "deny" },
    };
    expect(() => validateWalletHookConfig(c)).toThrow(/minScore must be a finite number/);
  });

  it("rejects bad onUnknown", () => {
    const c = { reputationGate: { enabled: true, minScore: 5, onUnknown: "maybe" } } as unknown as WalletHookConfig;
    expect(() => validateWalletHookConfig(c)).toThrow(/onUnknown/);
  });

  it("validates multiPayeeSplit.defaultSplits via the sum invariant", () => {
    const good: WalletHookConfig = {
      multiPayeeSplit: {
        enabled: true,
        defaultSplits: [
          { recipient: "0x" + "a".repeat(40), bps: 7000 },
          { recipient: "0x" + "b".repeat(40), bps: 3000 },
        ],
      },
    };
    expect(() => validateWalletHookConfig(good)).not.toThrow();

    const bad: WalletHookConfig = {
      multiPayeeSplit: {
        enabled: true,
        defaultSplits: [
          { recipient: "0x" + "a".repeat(40), bps: 7000 },
          { recipient: "0x" + "b".repeat(40), bps: 2000 },
        ],
      },
    };
    expect(() => validateWalletHookConfig(bad)).toThrow(/sum to 10000/);
  });

  // ── BUG 11: strict shape — unknown/extra keys are rejected ──────────────
  describe("strict shape — unknown keys rejected", () => {
    it("rejects an unknown top-level key", () => {
      const c = { reputationGate: { enabled: false, minScore: 1, onUnknown: "allow" }, bogusHook: { enabled: true } } as unknown as WalletHookConfig;
      expect(() => validateWalletHookConfig(c)).toThrow(/unknown key: bogusHook/);
    });

    it("rejects an unknown key inside reputationGate", () => {
      const c = { reputationGate: { enabled: true, minScore: 5, onUnknown: "deny", extra: 1 } } as unknown as WalletHookConfig;
      expect(() => validateWalletHookConfig(c)).toThrow(/reputationGate has an unknown key: extra/);
    });

    it("rejects an unknown key inside spendCap", () => {
      const c = { spendCap: { enabled: true, perCallApprovalUsd: 100, sneaky: true } } as unknown as WalletHookConfig;
      expect(() => validateWalletHookConfig(c)).toThrow(/spendCap has an unknown key: sneaky/);
    });

    it("rejects an unknown key inside a spendCap window", () => {
      const c = { spendCap: { enabled: true, allowedWindowsUtc: [{ startHour: 9, endHour: 17, tz: "UTC" }] } } as unknown as WalletHookConfig;
      expect(() => validateWalletHookConfig(c)).toThrow(/window has an unknown key: tz/);
    });

    it("rejects an unknown key inside a multiPayeeSplit leg", () => {
      const c = { multiPayeeSplit: { enabled: true, defaultSplits: [{ recipient: "0x" + "a".repeat(40), bps: 10000, label: "x" }] } } as unknown as WalletHookConfig;
      expect(() => validateWalletHookConfig(c)).toThrow(/leg has an unknown key: label/);
    });
  });

  // ── BUG 11: reputationGate.minScore must be >= 0 ────────────────────────
  describe("reputationGate.minScore >= 0", () => {
    it("accepts minScore = 0", () => {
      const c: WalletHookConfig = { reputationGate: { enabled: true, minScore: 0, onUnknown: "deny" } };
      expect(() => validateWalletHookConfig(c)).not.toThrow();
    });
    it("rejects a negative minScore", () => {
      const c: WalletHookConfig = { reputationGate: { enabled: true, minScore: -1, onUnknown: "deny" } };
      expect(() => validateWalletHookConfig(c)).toThrow(/minScore must be >= 0/);
    });
  });

  // ── BUG 11: spendCap.enabled:true with no rules enforces nothing ────────
  describe("spendCap requires at least one rule when enabled", () => {
    it("rejects enabled:true with no allowedRecipients/windows/perCallApprovalUsd", () => {
      const c: WalletHookConfig = { spendCap: { enabled: true } };
      expect(() => validateWalletHookConfig(c)).toThrow(/no rule is set/);
    });
    it("accepts enabled:false with no rules (a disabled cap is fine)", () => {
      const c: WalletHookConfig = { spendCap: { enabled: false } };
      expect(() => validateWalletHookConfig(c)).not.toThrow();
    });
    it("accepts enabled:true with one rule (perCallApprovalUsd)", () => {
      const c: WalletHookConfig = { spendCap: { enabled: true, perCallApprovalUsd: 100 } };
      expect(() => validateWalletHookConfig(c)).not.toThrow();
    });
  });

  // ── BUG 11: empty allowedRecipients (allow-all footgun) rejected ────────
  describe("spendCap.allowedRecipients empty-when-present rejected", () => {
    it("rejects an empty allowedRecipients array", () => {
      const c: WalletHookConfig = { spendCap: { enabled: true, allowedRecipients: [] } };
      expect(() => validateWalletHookConfig(c)).toThrow(/must be non-empty when present/);
    });
    it("accepts a non-empty allowedRecipients array", () => {
      const c: WalletHookConfig = { spendCap: { enabled: true, allowedRecipients: ["0x" + "a".repeat(40)] } };
      expect(() => validateWalletHookConfig(c)).not.toThrow();
    });
    it("accepts an omitted allowedRecipients (no whitelist) when another rule is set", () => {
      const c: WalletHookConfig = { spendCap: { enabled: true, perCallApprovalUsd: 50 } };
      expect(() => validateWalletHookConfig(c)).not.toThrow();
    });
  });
});

describe("assertSplitsSumTo10000", () => {
  it("accepts a 2-way 70/30 split", () => {
    expect(() =>
      assertSplitsSumTo10000([
        { recipient: "0x" + "1".repeat(40), bps: 7000 },
        { recipient: "0x" + "2".repeat(40), bps: 3000 },
      ]),
    ).not.toThrow();
  });

  it("accepts a 3-way 70/25/5 split", () => {
    expect(() =>
      assertSplitsSumTo10000([
        { recipient: "0x" + "1".repeat(40), bps: 7000 },
        { recipient: "0x" + "2".repeat(40), bps: 2500 },
        { recipient: "0x" + "3".repeat(40), bps: 500 },
      ]),
    ).not.toThrow();
  });

  it("rejects an empty split", () => {
    expect(() => assertSplitsSumTo10000([])).toThrow(/non-empty/);
  });

  it("rejects under-100% (9999)", () => {
    expect(() =>
      assertSplitsSumTo10000([
        { recipient: "0x" + "1".repeat(40), bps: 5000 },
        { recipient: "0x" + "2".repeat(40), bps: 4999 },
      ]),
    ).toThrow(/sum to 10000/);
  });

  it("rejects too many legs (> MAX_SPLIT_LEGS) — sequential-relay DoS guard", () => {
    // 11 legs of ~909 bps; summing aside, the count cap must trip first.
    const legs = Array.from({ length: 11 }, (_, i) => ({
      recipient: "0x" + String(i).padStart(40, "0"),
      bps: 909,
    }));
    expect(() => assertSplitsSumTo10000(legs)).toThrow(/too many legs/);
  });

  it("rejects over-100% (10001)", () => {
    expect(() =>
      assertSplitsSumTo10000([
        { recipient: "0x" + "1".repeat(40), bps: 5000 },
        { recipient: "0x" + "2".repeat(40), bps: 5001 },
      ]),
    ).toThrow(/sum to 10000/);
  });

  it("rejects a malformed recipient address", () => {
    expect(() =>
      assertSplitsSumTo10000([{ recipient: "not-an-address", bps: 10000 }]),
    ).toThrow(/not a 0x address/);
  });

  it("rejects a zero / negative / non-integer bps", () => {
    expect(() =>
      assertSplitsSumTo10000([{ recipient: "0x" + "1".repeat(40), bps: 0 }]),
    ).toThrow(/positive integer/);
    expect(() =>
      assertSplitsSumTo10000([{ recipient: "0x" + "1".repeat(40), bps: -5 }]),
    ).toThrow(/positive integer/);
    expect(() =>
      assertSplitsSumTo10000([{ recipient: "0x" + "1".repeat(40), bps: 33.3 }]),
    ).toThrow(/positive integer/);
  });
});
