/**
 * hooks-canonical.test.ts
 *
 * canonicalHookConfig underpins the hook-config intent binding: the
 * dashboard signs keccak(canonical(config)) and the server re-derives
 * the same hash. If the two sides serialized differently, every save
 * would fail (or worse, a different config could share a hash). These
 * tests lock the determinism guarantee.
 */

import { describe, it, expect } from "vitest";
import { canonicalHookConfig } from "@/app/lib/hooks/canonical";
import type { WalletHookConfig } from "@/app/lib/hooks/types";

describe("canonicalHookConfig", () => {
  it("is invariant to top-level key order", () => {
    const a: WalletHookConfig = {
      reputationGate: { enabled: true, minScore: 5, onUnknown: "deny" },
      spendCap: { enabled: true, perCallApprovalUsd: 100 },
    };
    const b: WalletHookConfig = {
      spendCap: { enabled: true, perCallApprovalUsd: 100 },
      reputationGate: { enabled: true, minScore: 5, onUnknown: "deny" },
    };
    expect(canonicalHookConfig(a)).toBe(canonicalHookConfig(b));
  });

  it("is invariant to nested key order", () => {
    const a = { reputationGate: { enabled: true, minScore: 5, onUnknown: "deny" } } as WalletHookConfig;
    const b = { reputationGate: { onUnknown: "deny", minScore: 5, enabled: true } } as WalletHookConfig;
    expect(canonicalHookConfig(a)).toBe(canonicalHookConfig(b));
  });

  it("preserves array order (splits are order-significant)", () => {
    const a: WalletHookConfig = {
      multiPayeeSplit: { enabled: true, defaultSplits: [
        { recipient: "0x" + "a".repeat(40), bps: 7000 },
        { recipient: "0x" + "b".repeat(40), bps: 3000 },
      ] },
    };
    const b: WalletHookConfig = {
      multiPayeeSplit: { enabled: true, defaultSplits: [
        { recipient: "0x" + "b".repeat(40), bps: 3000 },
        { recipient: "0x" + "a".repeat(40), bps: 7000 },
      ] },
    };
    // Different leg order → different canonical string (the last leg
    // absorbs rounding dust, so order matters and must NOT be sorted away).
    expect(canonicalHookConfig(a)).not.toBe(canonicalHookConfig(b));
  });

  it("distinguishes different configs (no hash collision on value change)", () => {
    const a = { reputationGate: { enabled: true, minScore: 5, onUnknown: "deny" } } as WalletHookConfig;
    const b = { reputationGate: { enabled: true, minScore: 6, onUnknown: "deny" } } as WalletHookConfig;
    expect(canonicalHookConfig(a)).not.toBe(canonicalHookConfig(b));
  });

  it("empty config is stable", () => {
    expect(canonicalHookConfig({})).toBe("{}");
  });
});
