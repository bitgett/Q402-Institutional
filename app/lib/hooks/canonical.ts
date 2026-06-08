/**
 * Deterministic serialization of a WalletHookConfig for intent binding.
 *
 * The hook-config write endpoint binds the owner's signature to the EXACT
 * config being set (so a man-in-the-middle can't swap the policy after the
 * owner signs). Both the dashboard (signer) and the route (verifier) must
 * produce the same string for the same config — hence a canonical form
 * with recursively-sorted object keys.
 *
 * Client-safe: NO server-only imports (no @vercel/kv). The dashboard
 * imports this directly to build the message it signs.
 */

import type { WalletHookConfig } from "./types";

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = sortValue((v as Record<string, unknown>)[key]);
    }
    return out;
  }
  return v;
}

/**
 * Canonical JSON string for a hook config — recursively key-sorted,
 * no whitespace. Deterministic across client + server.
 */
export function canonicalHookConfig(config: WalletHookConfig): string {
  return JSON.stringify(sortValue(config));
}
