/**
 * auth.ts — server-side nonce-based authentication
 *
 * Flow:
 *   1. Client calls GET /api/auth/nonce?address=0x...  → server stores nonce in KV (8h TTL)
 *   2. Client signs:  "Q402 Auth\nAddress: {addr}\nNonce: {nonce}"
 *   3. Client sends { address, nonce, signature } with every protected request
 *   4. Server calls verifyNonceSignature() — validates nonce exists AND signature matches
 *
 * The same nonce is reused within its 8-hour window (good UX: one wallet popup per session).
 * Nonces expire automatically — stolen signatures become useless after ≤8 hours.
 * Call invalidateNonce() on sensitive operations (key rotation) to force re-sign.
 */

import { ethers } from "ethers";
import { kv } from "@vercel/kv";

// Nonce lives 8 hours in KV.  Client-side cache is set to 7.5h so it
// refreshes slightly before the server-side key expires.
const NONCE_TTL_SEC = 8 * 60 * 60;

function nonceKvKey(addr: string) {
  return `auth_nonce:${addr.toLowerCase()}`;
}

/** Message the client must sign.  Must be kept in sync with auth-client.ts. */
export function buildAuthMessage(addr: string, nonce: string): string {
  return `Q402 Auth\nAddress: ${addr.toLowerCase()}\nNonce: ${nonce}`;
}

/**
 * Returns the current nonce for `addr`, creating one if none exists.
 * Idempotent: returns the same nonce on repeated calls within the TTL window.
 */
export async function createOrGetNonce(
  addr: string,
): Promise<{ nonce: string; ttlSec: number }> {
  const key = nonceKvKey(addr);

  try {
    const existing = await kv.get<string>(key);
    if (existing) {
      const ttl = await kv.ttl(key);
      return { nonce: existing, ttlSec: ttl > 0 ? ttl : NONCE_TTL_SEC };
    }

    const { randomBytes } = await import("crypto");
    const nonce = randomBytes(16).toString("hex");
    await kv.set(key, nonce, { ex: NONCE_TTL_SEC });
    return { nonce, ttlSec: NONCE_TTL_SEC };
  } catch {
    // KV unavailable — fail closed so callers know auth is not possible
    throw new Error("Auth service unavailable. Please try again shortly.");
  }
}

/**
 * Verify that:
 *  1. `nonce` matches what's stored in KV for `addr`
 *  2. `signature` is a valid EIP-191 sig of buildAuthMessage(addr, nonce)
 *
 * Returns:
 *  { ok: true }                       — valid
 *  { ok: false, code: "NONCE_EXPIRED" }  — nonce not in KV (expired / never issued)
 *  { ok: false, code: "SIG_MISMATCH"  }  — nonce found but sig doesn't match
 */
export async function verifyNonceSignature(
  addr: string,
  nonce: string,
  signature: string,
): Promise<{ ok: true } | { ok: false; code: "NONCE_EXPIRED" | "SIG_MISMATCH" }> {
  const key = nonceKvKey(addr);

  let storedNonce: string | null;
  try {
    storedNonce = await kv.get<string>(key);
  } catch {
    // KV unavailable — fail closed
    return { ok: false, code: "NONCE_EXPIRED" };
  }

  if (!storedNonce || storedNonce !== nonce) {
    return { ok: false, code: "NONCE_EXPIRED" };
  }

  try {
    const msg = buildAuthMessage(addr.toLowerCase(), nonce);
    const recovered = ethers.verifyMessage(msg, signature);
    if (recovered.toLowerCase() !== addr.toLowerCase()) {
      return { ok: false, code: "SIG_MISMATCH" };
    }
  } catch {
    return { ok: false, code: "SIG_MISMATCH" };
  }

  return { ok: true };
}

/**
 * Invalidate the current nonce for `addr`, forcing the client to re-sign
 * on the next request.  Call after key rotation for extra security.
 */
export async function invalidateNonce(addr: string): Promise<void> {
  try {
    await kv.del(nonceKvKey(addr));
  } catch { /* best-effort */ }
}

/**
 * Shared helper used by all protected route handlers.
 * Extracts { address, nonce, signature } from body or query params,
 * verifies, and returns the lowercase address or a NextResponse error.
 *
 * Usage:
 *   const result = await requireAuth(req, body);
 *   if (result instanceof NextResponse) return result;
 *   const addr = result; // verified lowercase address
 */
export async function requireAuth(
  rawAddress: string | undefined | null,
  rawNonce: string | undefined | null,
  rawSignature: string | undefined | null,
): Promise<string | { error: string; code?: string; status: number }> {
  if (!rawAddress || !rawNonce || !rawSignature) {
    return { error: "address, nonce, and signature are required", status: 400 };
  }

  const addr = rawAddress.toLowerCase();
  const result = await verifyNonceSignature(addr, rawNonce, rawSignature);

  if (!result.ok) {
    if (result.code === "NONCE_EXPIRED") {
      return {
        error: "Nonce expired or invalid. Please re-authenticate.",
        code: "NONCE_EXPIRED",
        status: 401,
      };
    }
    return {
      error: "Signature does not match address",
      code: "SIG_MISMATCH",
      status: 401,
    };
  }

  return addr;
}
