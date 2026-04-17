/**
 * auth.ts — server-side nonce-based authentication
 *
 * Two-tier auth model:
 *
 * SESSION NONCE (low-risk actions — read, webhook config, provision):
 *   1. Client calls GET /api/auth/nonce?address=0x...  → server stores nonce in KV (1h TTL)
 *   2. Client signs:  "Q402 Auth\nAddress: {addr}\nNonce: {nonce}"
 *   3. Same nonce+sig reused within 1-hour window (one wallet popup per session).
 *
 * FRESH CHALLENGE (high-risk actions — key rotate, payment activate):
 *   1. Client calls GET /api/auth/challenge?address=0x... → server stores one-time challenge (5m TTL)
 *   2. Client signs:  "Q402 Action\nAddress: {addr}\nChallenge: {challenge}"
 *   3. Server verifies AND deletes challenge (cannot be replayed).
 */

import { ethers } from "ethers";
import { kv } from "@vercel/kv";
import { timingSafeEqual } from "node:crypto";

// Session nonce lives 1 hour in KV.  Client-side cache is set to 55min.
const NONCE_TTL_SEC = 60 * 60;

// One-time challenge lives 5 minutes in KV.
const CHALLENGE_TTL_SEC = 5 * 60;

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

  if (
    !storedNonce ||
    storedNonce.length !== nonce.length ||
    !timingSafeEqual(Buffer.from(storedNonce), Buffer.from(nonce))
  ) {
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

// ── Fresh challenge (high-risk actions) ────────────────────────────────────

function challengeKvKey(addr: string) {
  return `auth_challenge:${addr.toLowerCase()}`;
}

/** Message the client must sign for high-risk actions.  Must stay in sync with auth-client.ts. */
export function buildChallengeMessage(addr: string, challenge: string): string {
  return `Q402 Action\nAddress: ${addr.toLowerCase()}\nChallenge: ${challenge}`;
}

/**
 * Issue a one-time challenge for `addr`.
 * Overwrites any existing challenge (only the latest is valid).
 */
export async function createFreshChallenge(
  addr: string,
): Promise<{ challenge: string; ttlSec: number }> {
  const key = challengeKvKey(addr);
  try {
    const { randomBytes } = await import("crypto");
    const challenge = randomBytes(16).toString("hex");
    await kv.set(key, challenge, { ex: CHALLENGE_TTL_SEC });
    return { challenge, ttlSec: CHALLENGE_TTL_SEC };
  } catch {
    throw new Error("Auth service unavailable. Please try again shortly.");
  }
}

/**
 * Verify a fresh challenge signature AND consume it (truly single-use).
 *
 * Atomicity guarantee:
 *   Step 1 — SET NX on a "consumed" marker (auth_challenge_consumed:{addr}:{challenge}).
 *            Redis SET NX is atomic: only the first concurrent caller wins; the rest see
 *            null immediately and are rejected before any signature work begins.
 *   Step 2 — Read the original challenge to confirm it exists and matches.
 *   Step 3 — Verify EIP-191 signature.
 *   Step 4 — Delete the original challenge key (best-effort; the consumed marker already
 *            blocks any future attempt even if the delete fails).
 *
 * Returns:
 *  { ok: true }                           — valid; challenge permanently consumed
 *  { ok: false, code: "NONCE_EXPIRED" }   — challenge expired/already used/concurrent claim lost
 *  { ok: false, code: "SIG_MISMATCH"  }   — challenge valid but signature wrong
 */
export async function verifyAndConsumeChallenge(
  addr: string,
  challenge: string,
  signature: string,
): Promise<{ ok: true } | { ok: false; code: "NONCE_EXPIRED" | "SIG_MISMATCH" }> {
  const key         = challengeKvKey(addr);
  // Consumed marker includes both addr and the challenge value so different challenges
  // don't interfere with each other.
  const consumedKey = `auth_challenge_consumed:${addr.toLowerCase()}:${challenge}`;

  // ── Step 1: Atomically claim this challenge ───────────────────────────────
  // SET NX returns "OK" (truthy) if the key was set (we own it), null if it already existed.
  // TTL matches the challenge window — consumed markers auto-expire with challenges.
  try {
    const claimed = await kv.set(consumedKey, "1", { nx: true, ex: CHALLENGE_TTL_SEC });
    if (!claimed) {
      // Another concurrent request already claimed this challenge.
      return { ok: false, code: "NONCE_EXPIRED" };
    }
  } catch {
    return { ok: false, code: "NONCE_EXPIRED" };
  }

  // ── Step 2: Confirm the challenge exists and matches ─────────────────────
  let storedChallenge: string | null;
  try {
    storedChallenge = await kv.get<string>(key);
  } catch {
    return { ok: false, code: "NONCE_EXPIRED" };
  }
  if (
    !storedChallenge ||
    storedChallenge.length !== challenge.length ||
    !timingSafeEqual(Buffer.from(storedChallenge), Buffer.from(challenge))
  ) {
    return { ok: false, code: "NONCE_EXPIRED" };
  }

  // ── Step 3: Verify EIP-191 signature ─────────────────────────────────────
  try {
    const msg = buildChallengeMessage(addr.toLowerCase(), challenge);
    const recovered = ethers.verifyMessage(msg, signature);
    if (recovered.toLowerCase() !== addr.toLowerCase()) {
      return { ok: false, code: "SIG_MISMATCH" };
    }
  } catch {
    return { ok: false, code: "SIG_MISMATCH" };
  }

  // ── Step 4: Delete original challenge (best-effort) ──────────────────────
  // The consumed marker already makes this key unreachable for any future attempt.
  kv.del(key).catch(() => { /* best-effort */ });

  return { ok: true };
}

/**
 * requireFreshAuth — same interface as requireAuth but verifies a one-time challenge.
 * Use for high-risk operations: key rotation, payment activation.
 */
export async function requireFreshAuth(
  rawAddress: string | undefined | null,
  rawChallenge: string | undefined | null,
  rawSignature: string | undefined | null,
): Promise<string | { error: string; code?: string; status: number }> {
  if (!rawAddress || !rawChallenge || !rawSignature) {
    return { error: "address, challenge, and signature are required", status: 400 };
  }

  const addr = rawAddress.toLowerCase();
  const result = await verifyAndConsumeChallenge(addr, rawChallenge, rawSignature);

  if (!result.ok) {
    if (result.code === "NONCE_EXPIRED") {
      return {
        error: "Challenge expired or invalid. Please re-authenticate.",
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
