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
