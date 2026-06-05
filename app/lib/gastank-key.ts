/**
 * Server-only helper that loads GASTANK_PRIVATE_KEY from env, derives its
 * address, and ASSERTS the derived address matches GASTANK_ADDRESS from
 * `app/lib/wallets.ts`.
 *
 * GASTANK_ADDRESS is where user deposits land (relay credits, LINK Gas
 * Tank balances). The key gates the only on-chain action paths that
 * spend FROM that wallet — currently the treasury-rebalance cron that
 * sweeps native + LINK from GASTANK to the Sender contracts + the
 * relayer hot wallet.
 *
 * Mirrors `loadRelayerKey` exactly:
 *   - missing env → { ok: false, reason: "missing", … }
 *   - derived address ≠ GASTANK_ADDRESS → { ok: false, reason: "mismatch", … }
 *     plus a console.error fan-out so the misconfig shows up in Vercel
 *     logs immediately rather than only being noticed downstream.
 *   - happy path → { ok: true, privateKey, address }
 *
 * Caching: result is memoised for the lifetime of the serverless
 * instance. Pure (no network, no I/O) so safe to call from any handler.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { GASTANK_ADDRESS_LC } from "./wallets";

export type GasTankKeyOk = {
  ok: true;
  privateKey: Hex;
  address: `0x${string}`;
};

export type GasTankKeyErr = {
  ok: false;
  reason: "missing" | "mismatch";
  detail: string;
};

export type GasTankKeyResult = GasTankKeyOk | GasTankKeyErr;

let cached: GasTankKeyResult | null = null;

/**
 * Loads + validates the GASTANK signing key. Result is cached for the
 * lifetime of the serverless instance — avoids re-deriving the address
 * on every cron tick.
 */
export function loadGasTankKey(): GasTankKeyResult {
  if (cached) return cached;

  const pkRaw = process.env.GASTANK_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "0x_paste_64_hex_here" || pkRaw === "your_private_key_here") {
    cached = { ok: false, reason: "missing", detail: "GASTANK_PRIVATE_KEY not set" };
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
      detail: `GASTANK_PRIVATE_KEY is not a valid hex private key: ${e instanceof Error ? e.message : "parse error"}`,
    };
    return cached;
  }

  if (derived.toLowerCase() !== GASTANK_ADDRESS_LC) {
    // Loud failure — log to stderr so it appears in Vercel logs immediately.
    // We never want a misconfigured key to silently sweep funds to a wrong
    // hot wallet, so the cron refuses to act on any mismatch.
    console.error(
      `[FATAL] GASTANK_PRIVATE_KEY derives to ${derived} but app/lib/wallets.ts ` +
      `GASTANK_ADDRESS expects ${GASTANK_ADDRESS_LC}. Refusing to sweep. ` +
      `Either rotate the env var to the correct key or update wallets.ts.`,
    );
    cached = {
      ok: false,
      reason: "mismatch",
      detail: `derived=${derived} ≠ expected=${GASTANK_ADDRESS_LC}`,
    };
    return cached;
  }

  cached = { ok: true, privateKey: pk, address: derived };
  return cached;
}
