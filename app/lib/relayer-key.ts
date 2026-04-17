/**
 * Server-only helper that loads RELAYER_PRIVATE_KEY from env, derives its
 * address, and ASSERTS the derived address matches RELAYER_ADDRESS from
 * `app/lib/wallets.ts`.
 *
 * This catches the operational failure mode where:
 *   - UI / docs / alerts reference RELAYER_ADDRESS (the constant)
 *   - …but the deployed env actually has a key for a DIFFERENT wallet
 *
 * Without this guard, a wrong env would silently sign relays from address B
 * while dashboards & Telegram alerts still pointed at address A — operator
 * tops up the wrong wallet, relays fail, debugging takes hours.
 *
 * Used by every call site that touches the relayer key:
 *   - app/lib/relayer.ts (settlePayment, settlePaymentXLayerEIP7702, …)
 *   - app/api/relay/info/route.ts (returns facilitator address to SDK)
 *   - app/api/gas-tank/withdraw/route.ts (record-only, but reads RELAYER for sanity)
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { RELAYER_ADDRESS_LC } from "./wallets";

export type RelayerKeyOk = {
  ok: true;
  privateKey: Hex;
  address: `0x${string}`;
};

export type RelayerKeyErr = {
  ok: false;
  /** "missing": env not set / placeholder. "mismatch": derived addr ≠ RELAYER_ADDRESS. */
  reason: "missing" | "mismatch";
  /** Operator-facing diagnostic — never returned to clients verbatim. */
  detail: string;
};

export type RelayerKeyResult = RelayerKeyOk | RelayerKeyErr;

let cached: RelayerKeyResult | null = null;

/**
 * Loads + validates the relayer key. Result is cached for the lifetime of the
 * serverless instance — avoids re-deriving the address on every request.
 *
 * Pure: no network, no I/O. Safe to call from any server route handler.
 */
export function loadRelayerKey(): RelayerKeyResult {
  if (cached) return cached;

  const pkRaw = process.env.RELAYER_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "your_private_key_here") {
    cached = { ok: false, reason: "missing", detail: "RELAYER_PRIVATE_KEY not set" };
    return cached;
  }

  const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
  let derived: `0x${string}`;
  try {
    derived = privateKeyToAccount(pk).address;
  } catch (e) {
    cached = {
      ok: false,
      reason: "missing",
      detail: `RELAYER_PRIVATE_KEY is not a valid hex private key: ${e instanceof Error ? e.message : "parse error"}`,
    };
    return cached;
  }

  if (derived.toLowerCase() !== RELAYER_ADDRESS_LC) {
    // Loud failure — log to stderr so it appears in Vercel logs immediately.
    console.error(
      `[FATAL] RELAYER_PRIVATE_KEY derives to ${derived} but app/lib/wallets.ts ` +
      `RELAYER_ADDRESS expects ${RELAYER_ADDRESS_LC}. Refusing to relay. ` +
      `Either rotate the env var to the correct key or update wallets.ts.`
    );
    cached = {
      ok: false,
      reason: "mismatch",
      detail: `derived ${derived.toLowerCase()} ≠ expected ${RELAYER_ADDRESS_LC}`,
    };
    return cached;
  }

  cached = { ok: true, privateKey: pk, address: derived };
  return cached;
}

/** Test-only — clear the module-level cache. */
export function _resetRelayerKeyCacheForTesting(): void {
  cached = null;
}
