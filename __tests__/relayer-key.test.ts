/**
 * relayer-key.test.ts
 *
 * Guards the operational invariant: RELAYER_PRIVATE_KEY env var MUST derive
 * to the address listed as RELAYER_ADDRESS in app/lib/wallets.ts.
 *
 * If this test ever fails in CI, do NOT bypass it. Either:
 *   1. Rotate the env var to the correct key (the right wallet for ops), OR
 *   2. Update wallets.ts (and dashboard / docs / Telegram alerts) to point at
 *      the new wallet.
 *
 * Silently mismatched env → /api/relay signs from wallet B while /api/gas-tank
 * dashboard, alerts, and docs all reference wallet A. Topping up B is an
 * operational accident waiting to happen.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { RELAYER_ADDRESS_LC } from "../app/lib/wallets";
import { loadRelayerKey, _resetRelayerKeyCacheForTesting } from "../app/lib/relayer-key";

describe("loadRelayerKey() — RELAYER_PRIVATE_KEY ↔ wallets.ts invariant", () => {
  const originalEnv = process.env.RELAYER_PRIVATE_KEY;

  beforeEach(() => {
    _resetRelayerKeyCacheForTesting();
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.RELAYER_PRIVATE_KEY;
    else process.env.RELAYER_PRIVATE_KEY = originalEnv;
  });

  it("returns ok when env key derives to RELAYER_ADDRESS (production env)", () => {
    if (!originalEnv || originalEnv === "your_private_key_here") {
      // Skip in dev / CI without secrets — this assertion only meaningful when
      // a real production key is loaded.
      return;
    }
    const result = loadRelayerKey();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.toLowerCase()).toBe(RELAYER_ADDRESS_LC);
    }
  });

  it("returns reason='missing' when env is unset", () => {
    delete process.env.RELAYER_PRIVATE_KEY;
    _resetRelayerKeyCacheForTesting();
    const result = loadRelayerKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("returns reason='missing' for placeholder string", () => {
    process.env.RELAYER_PRIVATE_KEY = "your_private_key_here";
    _resetRelayerKeyCacheForTesting();
    const result = loadRelayerKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("returns reason='missing' for malformed hex", () => {
    process.env.RELAYER_PRIVATE_KEY = "not_a_real_key";
    _resetRelayerKeyCacheForTesting();
    const result = loadRelayerKey();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("returns reason='mismatch' when env key derives to a different address", () => {
    // Generate a random key that almost certainly does NOT match RELAYER_ADDRESS
    const wrongPk = generatePrivateKey();
    const wrongAddr = privateKeyToAccount(wrongPk).address.toLowerCase();
    expect(wrongAddr).not.toBe(RELAYER_ADDRESS_LC); // sanity

    process.env.RELAYER_PRIVATE_KEY = wrongPk;
    _resetRelayerKeyCacheForTesting();
    const result = loadRelayerKey();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("mismatch");
      expect(result.detail).toContain(wrongAddr);
      expect(result.detail).toContain(RELAYER_ADDRESS_LC);
    }
  });

  it("caches the result so subsequent calls don't re-derive", () => {
    process.env.RELAYER_PRIVATE_KEY = "your_private_key_here";
    _resetRelayerKeyCacheForTesting();
    const r1 = loadRelayerKey();
    // Even if env changes, cached result is returned until reset
    process.env.RELAYER_PRIVATE_KEY = generatePrivateKey();
    const r2 = loadRelayerKey();
    expect(r2).toBe(r1); // strict object identity → cache hit
  });
});
