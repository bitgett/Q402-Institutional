/**
 * keystore.ts — AES-256-GCM symmetric encryption for at-rest private keys.
 *
 * Used by the Agentic Wallet feature to wrap each user's wallet private key
 * before storing it in Vercel KV. The master key (`KEY_ENCRYPTION_KEY`) is
 * a 64-char hex string held in Vercel encrypted env; this module never
 * persists or logs it, and never returns the decrypted plaintext outside
 * the in-process Buffer.
 *
 * Wire format for a stored ciphertext:
 *   nonce (12 bytes) | ciphertext | authTag (16 bytes)
 * each surfaced as its own hex field on the persisted record so the KV
 * layer can read them back without re-parsing a packed blob.
 *
 * v2 upgrade path: swap the env-backed master key for a KMS / Vault wrap
 * by changing only `loadMasterKey()`. The wrap/unwrap surface stays.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedBlob {
  /** Hex-encoded 12-byte GCM nonce. */
  nonce: string;
  /** Hex-encoded ciphertext (no nonce, no tag — those are separate fields). */
  ciphertext: string;
  /** Hex-encoded 16-byte GCM auth tag. */
  tag: string;
}

export type KeystoreLoadOk = { ok: true; key: Buffer };
export type KeystoreLoadErr = { ok: false; reason: "missing" | "invalid"; detail: string };
export type KeystoreLoadResult = KeystoreLoadOk | KeystoreLoadErr;

let cachedMasterKey: KeystoreLoadResult | null = null;

/**
 * Load + validate the master encryption key. Result is cached for the
 * lifetime of the serverless instance — avoids re-decoding the hex on
 * every request. Pure: no network, no I/O.
 */
export function loadMasterKey(): KeystoreLoadResult {
  if (cachedMasterKey) return cachedMasterKey;

  const raw = process.env.KEY_ENCRYPTION_KEY;
  if (!raw || raw === "replace_with_random_hex_32" || raw === "your_key_here") {
    cachedMasterKey = { ok: false, reason: "missing", detail: "KEY_ENCRYPTION_KEY not set" };
    return cachedMasterKey;
  }

  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    cachedMasterKey = {
      ok: false,
      reason: "invalid",
      detail: "KEY_ENCRYPTION_KEY must be hex (with or without 0x prefix)",
    };
    return cachedMasterKey;
  }

  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) {
    cachedMasterKey = {
      ok: false,
      reason: "invalid",
      detail: `KEY_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    };
    return cachedMasterKey;
  }

  cachedMasterKey = { ok: true, key: buf };
  return cachedMasterKey;
}

/**
 * Encrypt `plaintext` under the loaded master key. Generates a fresh
 * random nonce per call — never reuse a nonce with the same key.
 *
 * Throws if the master key is unavailable. Callers in route handlers
 * should call `loadMasterKey()` first and surface a 503 cleanly; this
 * function assumes the env is configured.
 */
export function encrypt(plaintext: string): EncryptedBlob {
  const k = loadMasterKey();
  if (!k.ok) throw new Error(`keystore: master key unavailable (${k.reason}: ${k.detail})`);

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, k.key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    nonce: nonce.toString("hex"),
    ciphertext: encrypted.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/**
 * Decrypt an `EncryptedBlob`. Throws on tag mismatch (tampered
 * ciphertext) or any field-length anomaly. Never returns garbled bytes —
 * GCM authenticates, so a corrupt blob fails loud rather than silently
 * producing wrong plaintext.
 */
export function decrypt(blob: EncryptedBlob): string {
  const k = loadMasterKey();
  if (!k.ok) throw new Error(`keystore: master key unavailable (${k.reason}: ${k.detail})`);

  const nonce = Buffer.from(blob.nonce, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ciphertext = Buffer.from(blob.ciphertext, "hex");
  if (nonce.length !== NONCE_BYTES) throw new Error("keystore: bad nonce length");
  if (tag.length !== TAG_BYTES) throw new Error("keystore: bad auth-tag length");

  const decipher = createDecipheriv(ALGO, k.key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Constant-time equality for hex-encoded strings of equal length. Used
 * by audit-log lookups that compare wallet IDs without leaking timing
 * differences. Returns false for non-hex input — `Buffer.from(_, "hex")`
 * silently drops invalid chars, which would otherwise let two distinct
 * but both-invalid strings compare equal as empty buffers.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-fA-F]*$/.test(a) || !/^[0-9a-fA-F]*$/.test(b)) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Test-only — clear the module-level cache. */
export function _resetMasterKeyCacheForTesting(): void {
  cachedMasterKey = null;
}
