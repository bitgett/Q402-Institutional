/**
 * agentic-wallet.ts — server-side CRUD + key-handling for Agentic Wallets.
 *
 * An Agentic Wallet is a platform-generated EOA, one per user (MVP — schema
 * leaves a hook for N-per-user later). The private key is wrapped with the
 * keystore master key and stored in Vercel KV; the address is derived once
 * at creation and stored alongside the ciphertext.
 *
 * KV schema (1-per-user MVP):
 *   aw:{ownerAddr}            → AgenticWalletRecord
 *   aw:export-log:{ownerAddr} → list of { ts, ip } (audit, capped to 50)
 *
 * Owner address is always lowercased before keying so address-case drift
 * (some wallets emit checksum, others don't) can't fork the record.
 *
 * Read paths return the stored record; write paths only ever touch the
 * record for the calling owner — there is no admin-style "load any wallet
 * by address" in this module, by design.
 */

import { ethers } from "ethers";
import type { Hex } from "viem";
import { kv } from "@vercel/kv";
import { encrypt, decrypt, loadMasterKey, type EncryptedBlob } from "./keystore";

export interface AgenticWalletRecord {
  /** Lowercased owner EOA (the user's MetaMask / OKX address). */
  ownerAddr: string;
  /** Checksummed Agentic Wallet address (the EOA we generated). */
  address: string;
  /** AES-GCM ciphertext fields wrapping the private key. */
  encryptedPK: EncryptedBlob;
  /** ms-epoch creation timestamp. */
  createdAt: number;
  /** ms-epoch soft-delete timestamp. Hard-delete cron sweeps after grace. */
  deletedAt?: number;
  /** Per-wallet daily spending cap in USD-equivalent stablecoin. */
  dailyLimitUsd?: number;
  /** Per-transaction max in USD-equivalent stablecoin. */
  perTxMaxUsd?: number;
  /** ERC8004 agent id once registered (Phase 4). */
  erc8004AgentId?: string;
}

export interface ExportLogEntry {
  ts: number;
  ip: string;
}

const RECORD_KEY = (owner: string) => `aw:${owner.toLowerCase()}`;
const EXPORT_LOG_KEY = (owner: string) => `aw:export-log:${owner.toLowerCase()}`;
const DAILY_SPEND_KEY = (owner: string, dateUtc: string) =>
  `aw:daily-spend:${owner.toLowerCase()}:${dateUtc}`;
const EXPORT_LOG_CAP = 50;
const DAILY_SPEND_TTL_SEC = 48 * 60 * 60;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Number of days a soft-deleted wallet stays recoverable. */
export const SOFT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Create a fresh Agentic Wallet for `ownerAddr`. Throws if one already
 * exists (active or soft-deleted) — restore the soft-deleted one or wait
 * out the grace window instead of stacking records.
 */
export async function createAgenticWallet(ownerAddr: string): Promise<AgenticWalletRecord> {
  const owner = ownerAddr.toLowerCase();
  const existing = await kv.get<AgenticWalletRecord>(RECORD_KEY(owner));
  if (existing) {
    throw new Error("AGENTIC_WALLET_EXISTS");
  }

  const wallet = ethers.Wallet.createRandom();
  const encryptedPK = encrypt(wallet.privateKey);

  const record: AgenticWalletRecord = {
    ownerAddr: owner,
    address: ethers.getAddress(wallet.address),
    encryptedPK,
    createdAt: Date.now(),
  };

  await kv.set(RECORD_KEY(owner), record);
  return record;
}

/**
 * Return the wallet record for `ownerAddr`, or `null` if none exists.
 * Soft-deleted records are still returned — call sites that need to
 * exclude them should check `record.deletedAt`.
 */
export async function getAgenticWallet(
  ownerAddr: string,
): Promise<AgenticWalletRecord | null> {
  return await kv.get<AgenticWalletRecord>(RECORD_KEY(ownerAddr));
}

/**
 * Like `getAgenticWallet` but returns `null` for soft-deleted records.
 * Use in send / export / balance paths where a deleted wallet must not
 * be usable.
 */
export async function getActiveAgenticWallet(
  ownerAddr: string,
): Promise<AgenticWalletRecord | null> {
  const record = await getAgenticWallet(ownerAddr);
  if (!record) return null;
  if (record.deletedAt && Date.now() >= record.deletedAt) {
    // Grace window not yet swept by cron but caller treats it as gone.
    return null;
  }
  return record;
}

/**
 * Decrypt and return the wallet's private key as a `0x`-prefixed hex
 * string. Hand off immediately to the signer; do not log, persist, or
 * surface this value to the client.
 */
export function decryptPrivateKey(record: AgenticWalletRecord): Hex {
  const pk = decrypt(record.encryptedPK);
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
}

/**
 * Mark the wallet as soft-deleted (sets `deletedAt = now`). The hard
 * delete is performed by a separate cron after `SOFT_DELETE_GRACE_MS`.
 */
export async function softDeleteAgenticWallet(ownerAddr: string): Promise<void> {
  const record = await getAgenticWallet(ownerAddr);
  if (!record) return;
  if (record.deletedAt) return;
  await kv.set(RECORD_KEY(ownerAddr), { ...record, deletedAt: Date.now() });
}

/** Clear the soft-delete marker if still within the grace window. */
export async function restoreAgenticWallet(ownerAddr: string): Promise<void> {
  const record = await getAgenticWallet(ownerAddr);
  if (!record || !record.deletedAt) return;
  const elapsed = Date.now() - record.deletedAt;
  if (elapsed > SOFT_DELETE_GRACE_MS) {
    throw new Error("AGENTIC_WALLET_GRACE_EXPIRED");
  }
  const next: AgenticWalletRecord = { ...record };
  delete next.deletedAt;
  await kv.set(RECORD_KEY(ownerAddr), next);
}

/**
 * Permanent delete — only called by the hard-delete cron once the
 * grace window has elapsed. Removes both the wallet record and any
 * export-log entries.
 */
export async function hardDeleteAgenticWallet(ownerAddr: string): Promise<void> {
  await kv.del(RECORD_KEY(ownerAddr));
  await kv.del(EXPORT_LOG_KEY(ownerAddr));
}

export interface LimitPatch {
  dailyLimitUsd?: number | null;
  perTxMaxUsd?: number | null;
}

/**
 * Update the per-wallet spending limits. Pass `null` for a field to
 * clear it; omit the field to leave it as-is.
 */
export async function updateAgenticWalletLimits(
  ownerAddr: string,
  patch: LimitPatch,
): Promise<AgenticWalletRecord> {
  const record = await getAgenticWallet(ownerAddr);
  if (!record) throw new Error("AGENTIC_WALLET_NOT_FOUND");

  const next: AgenticWalletRecord = { ...record };
  if (Object.prototype.hasOwnProperty.call(patch, "dailyLimitUsd")) {
    if (patch.dailyLimitUsd === null) delete next.dailyLimitUsd;
    else if (typeof patch.dailyLimitUsd === "number") next.dailyLimitUsd = patch.dailyLimitUsd;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "perTxMaxUsd")) {
    if (patch.perTxMaxUsd === null) delete next.perTxMaxUsd;
    else if (typeof patch.perTxMaxUsd === "number") next.perTxMaxUsd = patch.perTxMaxUsd;
  }

  await kv.set(RECORD_KEY(ownerAddr), next);
  return next;
}

/** Append an export event to the audit log (capped at EXPORT_LOG_CAP). */
export async function recordExportEvent(
  ownerAddr: string,
  meta: { ip: string },
): Promise<void> {
  const key = EXPORT_LOG_KEY(ownerAddr);
  const entry: ExportLogEntry = { ts: Date.now(), ip: meta.ip };
  try {
    await kv.lpush(key, entry);
    await kv.ltrim(key, 0, EXPORT_LOG_CAP - 1);
  } catch {
    // Best-effort — if the audit log isn't writable, the export itself
    // still completes. The next read will reflect what KV could store.
  }
}

/** Return recent export events for `ownerAddr` (newest first). */
export async function getExportLog(ownerAddr: string): Promise<ExportLogEntry[]> {
  try {
    const rows = await kv.lrange<ExportLogEntry>(EXPORT_LOG_KEY(ownerAddr), 0, -1);
    return rows ?? [];
  } catch {
    return [];
  }
}

/**
 * Sum of USD-equivalent stablecoin sent today (UTC) from the caller's
 * Agentic Wallet. Returns 0 when no record exists or KV is unreachable.
 */
export async function getDailySpendUsd(ownerAddr: string): Promise<number> {
  try {
    const v = await kv.get<number>(DAILY_SPEND_KEY(ownerAddr, todayUtc()));
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * Enforces a per-wallet daily cap. Returns `allowed: true` when the
 * proposed amount fits under the limit OR no limit is set. Returns
 * `allowed: false` with the running total + limit so the caller can
 * surface a clean 403 to the client. Pure read — does NOT mutate KV;
 * call `recordDailySpend` only after the relay confirms.
 */
export async function checkDailyLimit(
  ownerAddr: string,
  amountUsd: number,
  limitUsd: number | undefined,
): Promise<{ allowed: true } | { allowed: false; spent: number; limit: number; requested: number }> {
  if (typeof limitUsd !== "number" || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    return { allowed: true };
  }
  const spent = await getDailySpendUsd(ownerAddr);
  if (spent + amountUsd > limitUsd) {
    return { allowed: false, spent, limit: limitUsd, requested: amountUsd };
  }
  return { allowed: true };
}

/**
 * Append `amountUsd` to today's running spend. Fire-and-forget at call
 * sites — failure here must not bubble back to the relay caller (the
 * TX already settled on-chain). The 48-hour TTL gives a 24-hour buffer
 * for late-night UTC rolls without leaving the key around forever.
 *
 * Race-window note: this is a read-then-write under HTTP load. Two
 * concurrent successful relays at the daily boundary can under-count by
 * one transaction. An atomic INCRBYFLOAT migration is a Phase-2 cleanup.
 */
export async function recordDailySpend(
  ownerAddr: string,
  amountUsd: number,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  const key = DAILY_SPEND_KEY(ownerAddr, todayUtc());
  try {
    const current = (await kv.get<number>(key)) ?? 0;
    const next = current + amountUsd;
    await kv.set(key, next, { ex: DAILY_SPEND_TTL_SEC });
  } catch {
    // Best-effort — the TX already settled. The next day's checks will
    // overcount slightly but no funds move incorrectly.
  }
}

/**
 * Cheap pre-flight that callers can use before touching the keystore —
 * surfaces a 503 when the master key is misconfigured instead of letting
 * encrypt/decrypt throw mid-route.
 */
export function isKeystoreReady(): { ok: true } | { ok: false; reason: string } {
  const k = loadMasterKey();
  if (k.ok) return { ok: true };
  return { ok: false, reason: `${k.reason}: ${k.detail}` };
}
