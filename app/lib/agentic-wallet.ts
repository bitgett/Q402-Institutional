/**
 * agentic-wallet.ts — server-side CRUD + key-handling for Agentic Wallets.
 *
 * Multi-wallet schema (v2). Each owner EOA can hold up to N Agentic
 * Wallets (currently 10). The `walletId` is the lowercased Agentic Wallet
 * address — already unique, recognisable in the UI, and stable.
 *
 * KV schema:
 *   aw:{owner}:{walletId}                  → AgenticWalletRecord
 *   aw:list:{owner}                         → string[] of walletIds, creation order
 *   aw:default:{owner}                      → walletId of the owner's default wallet
 *   aw:export-log:{owner}:{walletId}        → list of { ts, ip } (cap 50)
 *   aw:daily-spend:{owner}:{walletId}:{D}   → number (USD-equivalent reservation)
 *
 * Legacy schema (v1, lazy-migrated on read):
 *   aw:{owner}                              → single AgenticWalletRecord
 *   aw:export-log:{owner}                   → audit list
 *   aw:daily-spend:{owner}:{D}              → number
 *
 * The first call into the new module for a legacy-schema owner promotes
 * the single record to {owner}:{walletId}, builds the list/default
 * indices, and migrates the audit log. Daily-spend is left to expire on
 * its 48h TTL since copying it adds no real safety.
 *
 * Owner + wallet addresses are always lowercased at the key boundary so
 * checksum-case drift can't fork a record.
 *
 * Read paths never cross owner boundaries. Caller passes owner; the
 * library refuses to load a wallet not in that owner's list.
 */

import { ethers } from "ethers";
import type { Hex } from "viem";
import { kv } from "@vercel/kv";
import { encrypt, decrypt, loadMasterKey, type EncryptedBlob } from "./keystore";
import {
  pauseRulesForArchive,
  resumeRulesForRestore,
  deleteRulesForHardDelete,
} from "./agentic-wallet-recurring";

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
  /** ERC8004 agent id once registered. Stored as `${network}:${id}`. */
  erc8004AgentId?: string;
  /** Optional user-facing label (e.g. "Trading bot", "Subscriptions"). */
  label?: string;
}

export interface ExportLogEntry {
  ts: number;
  ip: string;
}

/**
 * Maximum number of wallets a single owner can hold. Includes
 * soft-deleted records inside the grace window — they still consume a
 * slot until the cron hard-deletes them. Trial plans cap lower (see
 * `effectiveWalletCap` below).
 */
export const MAX_WALLETS_PER_OWNER = 10;

/** Trial-plan cap. Multichain-paid subscribers get the full MAX. */
export const TRIAL_WALLET_CAP = 1;

/** Number of days a soft-deleted wallet stays recoverable. */
export const SOFT_DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Safety defaults a new wallet ships with. */
export const DEFAULT_PER_TX_MAX_USD = 200;
export const DEFAULT_DAILY_LIMIT_USD = 500;

const EXPORT_LOG_CAP = 50;
const DAILY_SPEND_TTL_SEC = 48 * 60 * 60;

// ── Key helpers ──────────────────────────────────────────────────────────

function lower(addr: string): string {
  return addr.toLowerCase();
}

/**
 * AES-GCM Additional Authenticated Data binding a wallet's encrypted private
 * key to its identity (owner + wallet address). Encrypting and decrypting with
 * this AAD means a ciphertext blob can only be opened in the context of the
 * exact record it was written for — a blob copied into another owner's (or
 * another address's) record fails to authenticate. Defense-in-depth beneath
 * the post-decrypt owner-address assertion in the signing path. Versioned
 * prefix so the binding scheme can evolve without ambiguity. (F5)
 */
function walletKeyAad(ownerAddr: string, address: string): Buffer {
  return Buffer.from(`aw:kpk:v1:${lower(ownerAddr)}:${lower(address)}`, "utf8");
}

const recordKey = (owner: string, walletId: string) =>
  `aw:${lower(owner)}:${lower(walletId)}`;
const listKey = (owner: string) => `aw:list:${lower(owner)}`;
const defaultKey = (owner: string) => `aw:default:${lower(owner)}`;
const createLockKey = (owner: string) => `aw:create-lock:${lower(owner)}`;
/**
 * Per-wallet, per-chain settle lock. A fund-moving action (yield deposit /
 * withdraw, and any future send/batch caller that opts in) holds this for
 * the full read-check-sign-settle window so two concurrent actions on the
 * SAME wallet+chain serialise. Two purposes:
 *   - the maxAllocationPct read-check-execute can't be raced (both racers
 *     reading the same balance and each passing the cap);
 *   - the EIP-7702 authorization nonce (derived from the wallet's current
 *     tx count) can't be reused by two in-flight delegations on one chain.
 *
 * This is the SINGLE shared per-(wallet, chain) settle lock — yield and the
 * send/batch/recurring fund-moving paths must all acquire THIS key (and only
 * this key) so a yield op and a send on one wallet+chain can never run
 * concurrently and collide on the 7702 nonce.
 *
 * SAFE-LEASE (token-based), mirroring acquire/releasePendingFundReconcileLock
 * in db.ts: acquire writes a unique per-call token via SET NX + TTL; release
 * does a Lua compare-and-DELETE that only removes the key when the stored
 * token still equals ours. A plain unconditional DEL is unsafe: if holder A's
 * TTL expires and holder B then takes a FRESH lease, A's later release would
 * wipe B's lock (classic ABA / lease-drift) and let two fund-moving ops run
 * on one wallet+chain at once.
 */
const walletChainLockKey = (walletId: string, chain: string) =>
  `aw:wc-lock:${lower(walletId)}:${chain}`;
const exportLogKey = (owner: string, walletId: string) =>
  `aw:export-log:${lower(owner)}:${lower(walletId)}`;
/**
 * Daily-spend storage. Suffix `-c` distinguishes the cents-integer
 * v2 schema from the legacy float (`aw:daily-spend:…`). Legacy keys
 * carry a 48h TTL so the v1 surface auto-flushes naturally after a
 * deploy — no active migration needed; the codebase only writes to v2
 * from here forward. Cents storage eliminates the IEEE-754 drift that
 * accumulated over 10⁴+ small charges per day (≤$0.0001/day at the
 * worst-case cap, but never decreases — a one-way error that always
 * tightened the effective cap).
 */
const dailySpendKey = (owner: string, walletId: string, dateUtc: string) =>
  `aw:daily-spend-c:${lower(owner)}:${lower(walletId)}:${dateUtc}`;

/** USD → cents, banker-safe rounding. Caller must validate `amountUsd > 0`. */
function usdToCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}
/**
 * Charge-side cents conversion — same rounding as `usdToCents` BUT
 * floors any positive amount at 1 cent. Without the floor a
 * sub-half-cent send ($0.004 etc.) rounds to 0 and `incrBy(0)` leaves
 * the daily-spend ledger untouched, letting an automation loop
 * approach the cap from below with $0-counted dust. The limit side
 * (which still uses `usdToCents`) keeps full precision — only the
 * outgoing-charge side gets the minimum-1-cent guard.
 */
function chargeUsdToCents(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  return Math.max(1, Math.round(amountUsd * 100));
}
function centsToUsd(cents: number): number {
  return cents / 100;
}

const CREATE_LOCK_TTL_SEC = 10;
/**
 * TTL for the per-wallet+chain settle lock. Sized to comfortably exceed the
 * worst-case sign+settle path (RPC nonce read + EIP-712 sign + type-4
 * broadcast + receipt wait) while still self-healing if a holder dies
 * mid-flight, so a wallet can't be stuck-locked forever. Kept under the
 * route's maxDuration so a hung leg releases before the next request.
 */
const WALLET_CHAIN_LOCK_TTL_SEC = 90;

/**
 * Acquire the per-wallet+chain settle lock as a SAFE LEASE (SET NX + TTL with
 * a unique per-call token). Returns the lease TOKEN on success (pass it back
 * to `releaseWalletChainLock`), or `null` when another fund-moving action
 * already holds it. Serialises the critical section per (wallet, chain) so
 * concurrent yield deposits — and a concurrent send + yield — can't race the
 * balance cap or collide on the 7702 auth nonce.
 *
 * The token is what makes release ABA-safe: a stale holder whose TTL expired
 * cannot DEL a fresh holder's lock because the stored token no longer matches.
 */
export async function acquireWalletChainLock(
  walletId: string,
  chain: string,
): Promise<string | null> {
  const token =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const claimed = await kv.set(
    walletChainLockKey(walletId, chain),
    token,
    { nx: true, ex: WALLET_CHAIN_LOCK_TTL_SEC },
  );
  return claimed ? token : null;
}

/**
 * Release the per-wallet+chain settle lock. Compare-and-DELETE: only removes
 * the key when the stored token still equals OUR lease — so a holder whose TTL
 * already expired (and whose lock a different action has since re-acquired)
 * can't wipe the new holder's lock. Best-effort — the TTL is the backstop.
 *
 * Pass the exact token returned by `acquireWalletChainLock`; a null/missing
 * token is a no-op (nothing was acquired). Uses an atomic Lua compare-and-del
 * (provided by @vercel/kv via the underlying @upstash/redis `eval`), mirroring
 * releasePendingFundReconcileLock in db.ts.
 */
export async function releaseWalletChainLock(
  walletId: string,
  chain: string,
  token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  try {
    const script =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
    await (kv as unknown as {
      eval: (s: string, keys: string[], args: string[]) => Promise<unknown>;
    }).eval(script, [walletChainLockKey(walletId, chain)], [token]);
  } catch {
    /* TTL will sweep the lease if eval is unavailable / KV blips. */
  }
}

// Legacy keys — only used in the lazy-migration read path.
const legacyRecordKey = (owner: string) => `aw:${lower(owner)}`;
const legacyExportLogKey = (owner: string) => `aw:export-log:${lower(owner)}`;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Lazy migration ───────────────────────────────────────────────────────

/**
 * If the owner still has a legacy single-wallet record but no list index,
 * promote it into the new schema. Idempotent — a second call after a
 * successful migration is a no-op.
 *
 * Migration is best-effort: if the legacy record exists but the writes
 * to new keys fail mid-flight, the caller still sees the legacy record
 * via `_legacyFallback` in the read helpers below. The NEXT successful
 * call retries the migration.
 */
async function migrateLegacyIfNeeded(ownerAddr: string): Promise<void> {
  const owner = lower(ownerAddr);
  const list = await kv.get<string[]>(listKey(owner));
  if (Array.isArray(list) && list.length > 0) return; // already migrated

  const legacy = await kv.get<AgenticWalletRecord>(legacyRecordKey(owner));
  if (!legacy) return; // nothing to migrate

  const walletId = lower(legacy.address);
  // Promote the wallet record under the new key shape. NX so two
  // concurrent migrations don't both rewrite the same record (idempotent
  // for identical content, but skipping the second write is cheaper).
  await kv.set(recordKey(owner, walletId), legacy, { nx: true });

  // Initialise the list. NX is LOAD-BEARING here:
  //   - Concurrent migration: the second caller's NX fails → returns
  //     immediately, never re-overwrites the just-built list.
  //   - Concurrent `createAgenticWallet` race: createAgenticWallet
  //     calls migrate BEFORE acquiring its create-lock and then
  //     appends to the list. Without NX on this write, the migration
  //     can fire AFTER the create-lock's `set(list, [legacyId,
  //     newId])` and clobber it back to `[legacyId]`, dropping the
  //     fresh wallet from the index → orphan record. With NX the
  //     migration's list write only lands when no list exists yet.
  const listClaimed = await kv.set(listKey(owner), [walletId], { nx: true });
  if (!listClaimed) {
    // Another path (concurrent migration OR a createAgenticWallet
    // that already initialised the list with our legacy + a new
    // entry) already populated `listKey`. Stop — don't touch default
    // either, the winning path handles it.
    return;
  }
  await kv.set(defaultKey(owner), walletId, { nx: true });

  // Audit log: copy if present, then drop the legacy key.
  try {
    const oldLog = await kv.lrange<ExportLogEntry>(legacyExportLogKey(owner), 0, -1);
    if (Array.isArray(oldLog) && oldLog.length > 0) {
      for (const entry of [...oldLog].reverse()) {
        await kv.lpush(exportLogKey(owner, walletId), entry);
      }
      await kv.ltrim(exportLogKey(owner, walletId), 0, EXPORT_LOG_CAP - 1);
    }
  } catch {
    /* best-effort */
  }

  // Delete the legacy keys now that the v2 surface is fully populated.
  // Keeping them around would leave a record with no deletedAt that the
  // GC cron's scan correctly skips but still has to materialise on every
  // pass, slowly growing the `aw:*` surface. Once the new list under
  // `aw:list:{owner}` is written under SET NX, every future read goes
  // through it and never touches the legacy key, so cleanup is safe.
  try {
    await kv.del(legacyRecordKey(owner));
    await kv.del(legacyExportLogKey(owner));
  } catch {
    /* best-effort — next cron sweep will see the stale key, log a
       benign skip, and a future migration call retries the delete. */
  }
}

// ── Listing + default ────────────────────────────────────────────────────

/**
 * Return every wallet for `ownerAddr`, in creation order. Includes
 * soft-deleted records (caller filters via `record.deletedAt` if it
 * cares). Triggers lazy migration when called against a legacy owner.
 */
export async function listAgenticWallets(
  ownerAddr: string,
): Promise<AgenticWalletRecord[]> {
  await migrateLegacyIfNeeded(ownerAddr);
  const owner = lower(ownerAddr);
  const ids = (await kv.get<string[]>(listKey(owner))) ?? [];
  if (ids.length === 0) return [];
  const records = await Promise.all(
    ids.map((id) => kv.get<AgenticWalletRecord>(recordKey(owner, id))),
  );
  return records.filter((r): r is AgenticWalletRecord => r !== null && r !== undefined);
}

/**
 * Count an owner's wallets, including soft-deleted (they still occupy a
 * slot until the hard-delete cron sweeps them). Used by createAgenticWallet
 * to enforce the per-owner cap.
 */
export async function countAgenticWallets(ownerAddr: string): Promise<number> {
  const list = await listAgenticWallets(ownerAddr);
  return list.length;
}

/**
 * Compute the effective wallet cap for this owner based on subscription
 * scope. Trial = 1. Multichain-paid = MAX (10). Callers pass a boolean
 * indicating multichain scope (or null for the trial-only path).
 */
export function effectiveWalletCap(hasMultichainScope: boolean): number {
  return hasMultichainScope ? MAX_WALLETS_PER_OWNER : TRIAL_WALLET_CAP;
}

/**
 * Return the owner's default wallet (the oldest still-active one, or
 * the explicit pointer in `aw:default:{owner}`). Returns null when the
 * owner has zero wallets or the default points at a deleted record.
 */
export async function getDefaultAgenticWallet(
  ownerAddr: string,
): Promise<AgenticWalletRecord | null> {
  await migrateLegacyIfNeeded(ownerAddr);
  const owner = lower(ownerAddr);

  const explicit = await kv.get<string>(defaultKey(owner));
  if (explicit) {
    const record = await kv.get<AgenticWalletRecord>(recordKey(owner, explicit));
    if (record && !isSoftDeletedEffective(record)) return record;
    // Default points at a missing or deleted record — fall through to
    // pick the first available wallet.
  }

  const all = await listAgenticWallets(ownerAddr);
  const active = all.filter((r) => !isSoftDeletedEffective(r));
  return active[0] ?? null;
}

function isSoftDeletedEffective(record: AgenticWalletRecord): boolean {
  return !!record.deletedAt && Date.now() >= record.deletedAt;
}

/**
 * Pick a wallet from the owner's bag by either an explicit walletId or
 * by falling back to the default. Returns null if the requested walletId
 * isn't in this owner's list (no cross-owner reads) or if none exists.
 */
export async function resolveWallet(
  ownerAddr: string,
  walletId: string | null | undefined,
): Promise<AgenticWalletRecord | null> {
  if (!walletId) return await getDefaultAgenticWallet(ownerAddr);
  return await getAgenticWallet(ownerAddr, walletId);
}

// ── CRUD ─────────────────────────────────────────────────────────────────

/**
 * Create a fresh Agentic Wallet for `ownerAddr`, race-safe.
 *
 * Concurrency model: the cap check, record write, list append, and
 * default-pointer write must all run as a single critical section,
 * otherwise two concurrent creates can:
 *   (a) both pass the cap check and overshoot it,
 *   (b) one's list append clobber the other → an orphan record
 *       (encrypted key sitting in KV but invisible to listing because
 *       it's not in the index), OR
 *   (c) both set the default pointer to different walletIds.
 *
 * Vercel KV's wrapper doesn't expose MULTI/EXEC, so we serialise the
 * critical section per owner with a SET NX lock (`aw:create-lock:{owner}`,
 * 10s TTL — well above the worst-case path). Lock contention surfaces
 * as `AGENTIC_WALLET_CREATE_LOCKED` so the dashboard can show a
 * "creating, try again in a moment" hint instead of silently
 * corrupting state.
 */
export async function createAgenticWallet(
  ownerAddr: string,
  opts: { cap?: number; label?: string } = {},
): Promise<AgenticWalletRecord> {
  const owner = lower(ownerAddr);
  const cap = typeof opts.cap === "number" ? opts.cap : MAX_WALLETS_PER_OWNER;

  await migrateLegacyIfNeeded(owner);

  // ── Critical section under SET NX lock ────────────────────────────────
  const lockKey = createLockKey(owner);
  const lockClaimed = await kv.set(lockKey, "1", { nx: true, ex: CREATE_LOCK_TTL_SEC });
  if (!lockClaimed) {
    const err = new Error("AGENTIC_WALLET_CREATE_LOCKED");
    throw err;
  }
  try {
    const existing = await listAgenticWallets(owner);
    if (existing.length >= cap) {
      const err = new Error("AGENTIC_WALLET_CAP_REACHED");
      (err as Error & { cap?: number; have?: number }).cap = cap;
      (err as Error & { cap?: number; have?: number }).have = existing.length;
      throw err;
    }

    const wallet = ethers.Wallet.createRandom();
    const encryptedPK = encrypt(wallet.privateKey, walletKeyAad(owner, wallet.address));
    const walletId = lower(wallet.address);

    const record: AgenticWalletRecord = {
      ownerAddr: owner,
      address: ethers.getAddress(wallet.address),
      encryptedPK,
      createdAt: Date.now(),
      dailyLimitUsd: DEFAULT_DAILY_LIMIT_USD,
      perTxMaxUsd: DEFAULT_PER_TX_MAX_USD,
      ...(typeof opts.label === "string" && opts.label.length > 0
        ? { label: opts.label }
        : {}),
    };

    const claimed = await kv.set(recordKey(owner, walletId), record, { nx: true });
    if (!claimed) {
      // Cosmically unlikely ECDSA collision. Surface as an existence
      // error rather than silently overwriting.
      throw new Error("AGENTIC_WALLET_EXISTS");
    }

    // Append to the list. Under the create-lock this read-then-write is
    // safe — only one creator for this owner runs at a time, so the
    // list slice can't be clobbered by a concurrent append.
    const prevList = (await kv.get<string[]>(listKey(owner))) ?? [];
    if (!prevList.includes(walletId)) {
      await kv.set(listKey(owner), [...prevList, walletId]);
    }
    // Set as default if owner had no default yet.
    const prevDefault = await kv.get<string>(defaultKey(owner));
    if (!prevDefault) {
      await kv.set(defaultKey(owner), walletId);
    }

    return record;
  } finally {
    // Best-effort lock release. Even if this throws (KV outage), the
    // 10s TTL eventually clears the lock so the owner isn't stuck.
    await kv.del(lockKey).catch(() => {});
  }
}

/**
 * Return the wallet record for a specific (owner, walletId) pair. Returns
 * null if the walletId isn't in the owner's list (no cross-owner reads).
 * Soft-deleted records are still returned — call sites that need to
 * exclude them should check `record.deletedAt`.
 */
export async function getAgenticWallet(
  ownerAddr: string,
  walletId: string,
): Promise<AgenticWalletRecord | null> {
  await migrateLegacyIfNeeded(ownerAddr);
  const owner = lower(ownerAddr);
  const id = lower(walletId);
  // Enforce list membership — a stolen walletId from another owner must
  // not load.
  const list = (await kv.get<string[]>(listKey(owner))) ?? [];
  if (!list.includes(id)) return null;
  return await kv.get<AgenticWalletRecord>(recordKey(owner, id));
}

/**
 * Like `getAgenticWallet` but returns null for soft-deleted records.
 * Use in send / export / balance paths where a deleted wallet must not
 * be usable.
 */
export async function getActiveAgenticWallet(
  ownerAddr: string,
  walletId: string,
): Promise<AgenticWalletRecord | null> {
  const record = await getAgenticWallet(ownerAddr, walletId);
  if (!record) return null;
  if (isSoftDeletedEffective(record)) return null;
  return record;
}

/**
 * Decrypt and return the wallet's private key as a `0x`-prefixed hex
 * string. Hand off immediately to the signer; do not log or persist.
 */
export function decryptPrivateKey(record: AgenticWalletRecord): Hex {
  // Bind decryption to this record's identity (F5). New blobs authenticate
  // with the AAD; legacy blobs fall back transparently inside `decrypt`.
  const pk = decrypt(record.encryptedPK, walletKeyAad(record.ownerAddr, record.address));
  return (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
}

/**
 * Soft-delete a specific wallet. The hard delete is performed by the
 * GC cron after `SOFT_DELETE_GRACE_MS`. Cascades: every active
 * recurring rule attached to this wallet transitions to
 * "paused-by-archive" so the cron stops firing them. User-paused and
 * cancelled rules stay in their current state.
 */
export async function softDeleteAgenticWallet(
  ownerAddr: string,
  walletId: string,
): Promise<void> {
  const record = await getAgenticWallet(ownerAddr, walletId);
  if (!record) return;
  if (record.deletedAt) return;
  await kv.set(
    recordKey(ownerAddr, walletId),
    { ...record, deletedAt: Date.now() },
  );
  // Cascade — pause recurring rules that were active. Best-effort: a
  // failure here only leaves the rule queued in the ZSET; the cron's
  // own per-rule "wallet active?" check rejects the fire anyway.
  try {
    await pauseRulesForArchive(ownerAddr, walletId);
  } catch (e) {
    console.error("[agentic-wallet] cascade pause failed:", e);
  }
}

/**
 * Clear the soft-delete marker if still within the grace window.
 * Cascades: every "paused-by-archive" rule resumes with a fresh
 * nextRunAt ≥ now + cancelWindow. User-paused rules stay paused.
 */
export async function restoreAgenticWallet(
  ownerAddr: string,
  walletId: string,
): Promise<void> {
  const record = await getAgenticWallet(ownerAddr, walletId);
  if (!record || !record.deletedAt) return;
  const elapsed = Date.now() - record.deletedAt;
  if (elapsed > SOFT_DELETE_GRACE_MS) {
    throw new Error("AGENTIC_WALLET_GRACE_EXPIRED");
  }
  const next: AgenticWalletRecord = { ...record };
  delete next.deletedAt;
  await kv.set(recordKey(ownerAddr, walletId), next);
  // Cascade — resume rules that the archive automatically paused.
  try {
    await resumeRulesForRestore(ownerAddr, walletId);
  } catch (e) {
    console.error("[agentic-wallet] cascade resume failed:", e);
  }
}

/**
 * Delete every derived KV key this wallet owns, so a hard-delete leaves no
 * residue (privacy) and doesn't slowly grow the `aw:*` surface (storage
 * drift). ONLY this wallet's keys — never another wallet's or an owner-shared
 * index (`aw:list:{owner}` / `aw:default:{owner}` are handled by the caller).
 *
 * Recurring rules + their list/firelog are NOT swept here — the
 * `deleteRulesForHardDelete` cascade already owns that family.
 *
 * Two shapes:
 *   (1) deterministic, one key per wallet — deleted directly:
 *         aw:hooks:{walletId}                       hook / policy config
 *         aw:yield:{walletId}                       tracked Aave principal
 *         aw:balance:{owner}:{walletId}             balance cache (5m TTL)
 *         aw:daily-spend-c:{owner}:{walletId}:{today}  today's spend ledger
 *   (2) variable-suffix families keyed by the wallet address prefix —
 *       enumerated with a bounded SCAN then deleted:
 *         aw:yield:settled:{walletId}:*             durable yield idem markers
 *         aw:yield:idem:{walletId}:*                short-lived yield idem claims
 *         aw:wc-lock:{walletId}:*                   per-chain settle leases
 *
 * Each leg is best-effort: a KV blip on one family must not abort the record
 * delete in the caller. The GC cron's per-key scan would eventually reap any
 * stragglers anyway, but sweeping here keeps the common path clean.
 */
async function deleteDerivedWalletKv(owner: string, id: string): Promise<void> {
  // (1) Deterministic single keys.
  const direct = [
    `aw:hooks:${id}`,
    `aw:yield:${id}`,
    `aw:balance:${owner}:${id}`,
    dailySpendKey(owner, id, todayUtc()),
  ];
  for (const key of direct) {
    await kv.del(key).catch(() => {});
  }

  // (2) Variable-suffix families — SCAN the wallet-scoped prefix and DEL each
  // hit. Bounded by scanIters so a misbehaving cursor can't spin forever.
  for (const prefix of [
    `aw:yield:settled:${id}:`,
    `aw:yield:idem:${id}:`,
    `aw:wc-lock:${id}:`,
  ]) {
    let cursor: string | number = 0;
    let scanIters = 0;
    try {
      do {
        const res: [string | number, string[]] = await (
          kv as unknown as {
            scan: (
              c: string | number,
              o: { match: string; count: number },
            ) => Promise<[string | number, string[]]>;
          }
        ).scan(cursor, { match: `${prefix}*`, count: 200 });
        cursor = res[0];
        for (const key of res[1]) {
          await kv.del(key).catch(() => {});
        }
        scanIters++;
      } while (String(cursor) !== "0" && scanIters < 1000);
    } catch {
      /* best-effort — GC cron / TTLs reap anything left behind. */
    }
  }
}

/**
 * Permanent delete — only called by the hard-delete cron once the grace
 * window has elapsed AND on-chain balance is empty (the cron is
 * responsible for the balance + Aave-yield checks; this function trusts the
 * caller and does NOT re-read either — it only removes KV state).
 *
 * Removes the wallet record, audit log, list entry, recurring rules
 * (cascade), every derived KV key this wallet owns, and re-elects the
 * default if this was the default wallet.
 */
export async function hardDeleteAgenticWallet(
  ownerAddr: string,
  walletId: string,
): Promise<void> {
  const owner = lower(ownerAddr);
  const id = lower(walletId);
  // Cascade-delete recurring rules FIRST so a fire racing the hard-
  // delete sees the rule already gone (cron's per-rule wallet check
  // would also catch it via getActiveAgenticWallet, but defence in
  // depth is cheap here).
  try {
    await deleteRulesForHardDelete(owner, id);
  } catch (e) {
    console.error("[agentic-wallet] cascade delete failed:", e);
  }
  await kv.del(recordKey(owner, id));
  await kv.del(exportLogKey(owner, id));

  // Sweep this wallet's derived KV (hooks, yield position + idem markers,
  // balance cache, daily-spend, settle leases). Best-effort — never blocks
  // the record/list/default teardown below.
  try {
    await deleteDerivedWalletKv(owner, id);
  } catch (e) {
    console.error("[agentic-wallet] derived KV cleanup failed:", e);
  }

  // Remove from list.
  const list = (await kv.get<string[]>(listKey(owner))) ?? [];
  const filtered = list.filter((x) => x !== id);
  if (filtered.length === 0) {
    await kv.del(listKey(owner));
  } else {
    await kv.set(listKey(owner), filtered);
  }

  // Re-elect default if this wallet was the default.
  const prevDefault = await kv.get<string>(defaultKey(owner));
  if (prevDefault === id) {
    if (filtered.length > 0) {
      await kv.set(defaultKey(owner), filtered[0]);
    } else {
      await kv.del(defaultKey(owner));
    }
  }
}

export interface LimitPatch {
  dailyLimitUsd?: number | null;
  perTxMaxUsd?: number | null;
  label?: string | null;
}

/**
 * Update per-wallet spending limits and optional label. Pass `null` to
 * clear a field; omit it to leave it as-is.
 */
export async function updateAgenticWalletLimits(
  ownerAddr: string,
  walletId: string,
  patch: LimitPatch,
): Promise<AgenticWalletRecord> {
  const record = await getAgenticWallet(ownerAddr, walletId);
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
  if (Object.prototype.hasOwnProperty.call(patch, "label")) {
    if (patch.label === null) delete next.label;
    else if (typeof patch.label === "string") next.label = patch.label;
  }

  await kv.set(recordKey(ownerAddr, walletId), next);
  return next;
}

/**
 * Persist the ERC-8004 agent id assigned to this wallet after the user
 * completed a `register` tx. Stored as `${network}:${agentId}` so the
 * dashboard can build the correct scan URL even when the wallet has
 * been registered on multiple chains.
 */
export async function setErc8004AgentId(
  ownerAddr: string,
  walletId: string,
  network: string,
  agentId: bigint | string | number,
): Promise<void> {
  const record = await getAgenticWallet(ownerAddr, walletId);
  if (!record) throw new Error("AGENTIC_WALLET_NOT_FOUND");
  const tag = `${network}:${String(agentId)}`;
  await kv.set(recordKey(ownerAddr, walletId), { ...record, erc8004AgentId: tag });
}

// ── Export audit log ────────────────────────────────────────────────────

/**
 * Append an export event to the per-wallet audit log. Rethrows the
 * underlying KV error so the route's `.catch()` can fire an ops alert
 * — silent failure here would let a PK reveal slip past the audit trail.
 */
export async function recordExportEvent(
  ownerAddr: string,
  walletId: string,
  meta: { ip: string },
): Promise<void> {
  const key = exportLogKey(ownerAddr, walletId);
  const entry: ExportLogEntry = { ts: Date.now(), ip: meta.ip };
  // Intentionally NOT swallowing errors — route handler escalates a KV
  // failure as a critical ops alert so a PK reveal never slips past the
  // audit trail.
  await kv.lpush(key, entry);
  await kv.ltrim(key, 0, EXPORT_LOG_CAP - 1);
}

/** Return recent export events for this wallet (newest first). */
export async function getExportLog(
  ownerAddr: string,
  walletId: string,
): Promise<ExportLogEntry[]> {
  try {
    const rows = await kv.lrange<ExportLogEntry>(
      exportLogKey(ownerAddr, walletId),
      0,
      -1,
    );
    return rows ?? [];
  } catch {
    return [];
  }
}

// ── Daily spend (per-wallet) ────────────────────────────────────────────

/**
 * Sum of USD-equivalent stablecoin sent today (UTC) from the specific
 * Agentic Wallet. Returns 0 when no spend recorded or KV is unreachable.
 *
 * Storage is integer cents (no IEEE-754 drift). The return is still
 * a USD float so callers that compare against USD caps don't need to
 * change shape — but the underlying accumulator is exact within ±0.5¢
 * (the round-trip at the boundary), bounded forever rather than
 * accumulating per-charge.
 */
export async function getDailySpendUsd(
  ownerAddr: string,
  walletId: string,
): Promise<number> {
  try {
    const v = await kv.get<number>(
      dailySpendKey(ownerAddr, walletId, todayUtc()),
    );
    return typeof v === "number" && Number.isFinite(v) ? centsToUsd(v) : 0;
  } catch {
    return 0;
  }
}

/**
 * Read-only daily-cap check. Pure — does NOT mutate KV. Use the
 * `chargeAgainstDailyLimit` variant when reserving budget for an
 * imminent relay call.
 */
export async function checkDailyLimit(
  ownerAddr: string,
  walletId: string,
  amountUsd: number,
  limitUsd: number | undefined,
): Promise<
  | { allowed: true }
  | { allowed: false; spent: number; limit: number; requested: number }
> {
  if (typeof limitUsd !== "number" || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    return { allowed: true };
  }
  const spent = await getDailySpendUsd(ownerAddr, walletId);
  if (spent + amountUsd > limitUsd) {
    return { allowed: false, spent, limit: limitUsd, requested: amountUsd };
  }
  return { allowed: true };
}

/**
 * Atomically reserve `amountUsd` of today's daily-spend budget for the
 * given wallet. Uses INCRBY on integer cents so concurrent sends can't
 * burst past the cap AND the accumulator never accrues float drift.
 *
 * Caller MUST call `refundDailySpend` on any downstream failure (relay
 * error, network drop) so the budget releases.
 */
export async function chargeAgainstDailyLimit(
  ownerAddr: string,
  walletId: string,
  amountUsd: number,
  limitUsd: number | undefined,
): Promise<
  | { allowed: true; total: number }
  | { allowed: false; spent: number; limit: number; requested: number }
> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { allowed: true, total: 0 };
  }
  const key = dailySpendKey(ownerAddr, walletId, todayUtc());
  // chargeUsdToCents — NOT usdToCents — so sub-cent sends still
  // consume at least 1 cent of the daily budget. See helper docstring.
  const amountCents = chargeUsdToCents(amountUsd);
  const limitCents =
    typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd > 0
      ? usdToCents(limitUsd)
      : 0;

  let nextTotalCents: number;
  try {
    const v = await kv.incrby(key, amountCents);
    nextTotalCents = typeof v === "number" ? v : Number(v);
  } catch {
    if (limitCents <= 0) {
      return { allowed: true, total: 0 };
    }
    return { allowed: false, spent: 0, limit: limitUsd!, requested: amountUsd };
  }

  try { await kv.expire(key, DAILY_SPEND_TTL_SEC); } catch { /* best-effort */ }

  if (limitCents > 0 && nextTotalCents > limitCents) {
    try { await kv.incrby(key, -amountCents); } catch { /* best-effort */ }
    return {
      allowed: false,
      spent: Math.max(0, centsToUsd(nextTotalCents - amountCents)),
      limit: limitUsd!,
      requested: amountUsd,
    };
  }

  return { allowed: true, total: centsToUsd(nextTotalCents) };
}

/** Release a previously-charged daily-spend reservation. Cents-storage. */
export async function refundDailySpend(
  ownerAddr: string,
  walletId: string,
  amountUsd: number,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  const key = dailySpendKey(ownerAddr, walletId, todayUtc());
  try {
    // Symmetric with the charge side — see `chargeUsdToCents` docstring.
    await kv.incrby(key, -chargeUsdToCents(amountUsd));
  } catch {
    /* best-effort — next day's TTL flushes the key anyway. */
  }
}

/**
 * Legacy non-atomic spend recorder. Prefer `chargeAgainstDailyLimit`
 * for new code so concurrent sends can't both slip past a stale read.
 */
export async function recordDailySpend(
  ownerAddr: string,
  walletId: string,
  amountUsd: number,
): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  const key = dailySpendKey(ownerAddr, walletId, todayUtc());
  try {
    // chargeUsdToCents (not usdToCents) so the same minimum-1-cent
    // floor applies to the legacy recorder too.
    await kv.incrby(key, chargeUsdToCents(amountUsd));
    await kv.expire(key, DAILY_SPEND_TTL_SEC);
  } catch {
    /* best-effort — the TX already settled. */
  }
}

/**
 * Cheap pre-flight that callers can use before touching the keystore —
 * surfaces a 503 when the master key is misconfigured instead of
 * letting encrypt/decrypt throw mid-route.
 */
export function isKeystoreReady(): { ok: true } | { ok: false; reason: string } {
  const k = loadMasterKey();
  if (k.ok) return { ok: true };
  return { ok: false, reason: `${k.reason}: ${k.detail}` };
}
