import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";
import { keccak256, AbiCoder } from "ethers";

/**
 * Escrow records — the off-chain index for Q402 Gasless Escrow.
 *
 * The authoritative state of the FUNDS lives on-chain in Q402EscrowVault (one
 * per chain): a buyer locks ERC-20 into the vault, then releases to the seller,
 * reclaims after a timeout, or (with a named arbiter) the dispute is resolved.
 * This module is the mirror/index the dashboard, MCP and SDK read + write
 * around those on-chain actions — it NEVER custodies funds and NEVER decides a
 * payout (the contract does). It stores the parties, the chosen on-chain
 * escrowId, the lifecycle status, and the tx hashes.
 *
 * Storage mirrors payment-request.ts exactly:
 *
 *   escrow:{id}          -> EscrowRecord     (id-keyed record, TTL = deadline + grace)
 *   escrow:owner:{owner} -> list of ids      (RPUSH + LTRIM cap, newest last)
 *   escrow:lock:{id}     -> SET NX action lock (serializes state-changing actions)
 *   escrow:settled:{id}  -> durable settled marker (written BEFORE the terminal flip)
 *
 * The on-chain escrowId is keccak256(abi.encode(buyer, salt)) — bound to the
 * BUYER (mirrors Q402EscrowVault.lockFrom). Because it incorporates the buyer's
 * address, a front-runner who submits the same salt gets a different id and
 * cannot preempt the buyer's escrow slot. The random `salt` is what the buyer
 * signs; the vault derives the id from msg.sender + salt.
 */

export type EscrowStatus =
  | "pending"   // record created; funds NOT yet locked on-chain
  | "open"      // funds locked in the vault
  | "disputed"  // a party disputed; awaiting arbiter
  | "released"  // paid to seller (happy path or resolve-to-seller)
  | "refunded"  // returned to buyer (timeout or resolve-to-buyer)
  | "cancelled" // abandoned before lock
  | "expired";  // pending record passed its deadline without a lock

export type EscrowOutcome = "release" | "refund" | "resolve-seller" | "resolve-buyer";

export interface EscrowRecord {
  id: string;                 // "esc_<24-hex>"
  salt: string;               // bytes32 hex — the buyer-signed salt
  onchainEscrowId: string;    // bytes32 hex = keccak256(abi.encode(buyer, salt)); used by the vault
  creatorOwner: string;       // lowercased owner that created the record
  buyer: string;              // lowercased buyer EOA (locks + releases)
  seller: string;             // lowercased seller address (paid on release)
  chain: string;              // AgenticChainKey
  token: "USDC" | "USDT";
  amount: string;             // human-readable decimal STRING (never a JS Number)
  arbiter?: string;           // lowercased dispute resolver (absent = no disputes)
  memo?: string;
  releaseDeadline: string;    // ISO — after this the buyer may reclaim
  status: EscrowStatus;
  createdAt: string;          // ISO
  expiresAt: string;          // ISO — record-lifetime anchor (>= releaseDeadline)
  lockTxHash?: string;        // funding tx
  settleTxHash?: string;      // release / refund / resolve tx
  outcome?: EscrowOutcome;    // how it settled
  disputeTxHash?: string;     // dispute tx
  receiptId?: string;         // Trust Receipt id
  sandbox: boolean;           // created with a sandbox (q402_test_) key
}

/** Fields safe to return on the public GET surface (no creatorOwner). */
export interface PublicEscrow {
  id: string;
  salt: string;
  onchainEscrowId: string;
  buyer: string;
  seller: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  arbiter?: string;
  memo?: string;
  releaseDeadline: string;
  status: EscrowStatus;
  createdAt: string;
  expiresAt: string;
  lockTxHash?: string;
  settleTxHash?: string;
  outcome?: EscrowOutcome;
  disputeTxHash?: string;
  receiptId?: string;
  sandbox: boolean;
}

// MUST exceed the on-chain RESOLVE_WINDOW (14 days): a disputed escrow's
// buyer-refund only becomes available at releaseDeadline + 14d, so the KV
// record + markers have to survive past that (else the buyer loses the API
// path to their gasless refund while the on-chain funds still sit locked).
// 21 = 14d resolve window + 7d margin.
const GRACE_DAYS = 21;
const OWNER_INDEX_CAP = 500;
const DEFAULT_RELEASE_DAYS = 7;
const MAX_RELEASE_DAYS = 90;

const ID_RE = /^esc_[0-9a-f]{24}$/;

export function escrowKey(id: string) { return `escrow:${id}`; }
export function escrowOwnerKey(owner: string) { return `escrow:owner:${owner.toLowerCase()}`; }
export function escrowLockKey(id: string) { return `escrow:lock:${id}`; }
export function escrowSettledKey(id: string) { return `escrow:settled:${id}`; }
export function escrowLockedKey(id: string) { return `escrow:locked:${id}`; }

export function isValidEscrowId(id: string): boolean { return ID_RE.test(id); }

function newEscrowId(): string { return `esc_${randomBytes(12).toString("hex")}`; }
function newSalt(): string { return `0x${randomBytes(32).toString("hex")}`; }

/** On-chain escrowId = keccak256(abi.encode(buyer, salt)) — mirrors Q402EscrowVault. */
export function deriveEscrowId(buyer: string, salt: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [buyer, salt]));
}

/** Seconds from now until the record should evict (deadline + grace, floored 1h). */
function ttlSecondsFor(expiresAtIso: string): number {
  const ms = new Date(expiresAtIso).getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000 - Date.now();
  return Math.max(3600, Math.floor(ms / 1000));
}

export interface CreateEscrowInput {
  creatorOwner: string;
  buyer: string;
  seller: string;
  chain: string;
  token: "USDC" | "USDT";
  amount: string;
  arbiter?: string;
  memo?: string;
  releaseDays?: number;
  sandbox: boolean;
}

export async function createEscrow(input: CreateEscrowInput): Promise<EscrowRecord> {
  const now = new Date();
  const days = input.releaseDays && input.releaseDays > 0
    ? Math.min(input.releaseDays, MAX_RELEASE_DAYS)
    : DEFAULT_RELEASE_DAYS;
  const releaseDeadline = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const id = newEscrowId();
  const salt = newSalt();
  const buyer = input.buyer.toLowerCase();

  const record: EscrowRecord = {
    id,
    salt,
    onchainEscrowId: deriveEscrowId(buyer, salt),
    creatorOwner: input.creatorOwner.toLowerCase(),
    buyer,
    seller: input.seller.toLowerCase(),
    chain: input.chain,
    token: input.token,
    amount: input.amount,
    ...(input.arbiter ? { arbiter: input.arbiter.toLowerCase() } : {}),
    ...(input.memo ? { memo: input.memo } : {}),
    releaseDeadline: releaseDeadline.toISOString(),
    status: "pending",
    createdAt: now.toISOString(),
    // Record outlives the release deadline so a settled escrow stays readable.
    expiresAt: releaseDeadline.toISOString(),
    sandbox: input.sandbox,
  };

  await kv.set(escrowKey(id), record, { ex: ttlSecondsFor(record.expiresAt) });

  try {
    const len = await kv.rpush(escrowOwnerKey(record.creatorOwner), id);
    if (len > OWNER_INDEX_CAP) {
      kv.ltrim(escrowOwnerKey(record.creatorOwner), -OWNER_INDEX_CAP, -1).catch(() => {});
    }
  } catch {
    // Index write failed — the id-keyed record is the source of truth; the
    // escrow is fully usable, it just may not appear in the dashboard list.
  }

  return record;
}

/**
 * Read by id. A `pending` record (never locked) lazily flips to `expired` once
 * past its deadline. A record that is already `open`/terminal is returned as-is
 * — expiry never overrides an on-chain truth (locked funds are governed by the
 * vault, not this index).
 */
export async function getEscrow(id: string): Promise<EscrowRecord | null> {
  if (!isValidEscrowId(id)) return null;
  const rec = await kv.get<EscrowRecord>(escrowKey(id));
  if (!rec) return null;
  if (rec.status === "pending" && Date.now() > new Date(rec.releaseDeadline).getTime()) {
    // F4: never expire a record whose funds are actually locked on-chain. A
    // durable locked marker means the lock tx landed but the status flip was
    // lost (KV blip) — reconcile the view to `open` so the escrow stays
    // actionable (release/refund), instead of stranding on-chain funds behind
    // an `expired` record.
    const locked = await getEscrowLockedMarker(id);
    if (locked) {
      const open: EscrowRecord = { ...rec, status: "open", lockTxHash: locked.txHash };
      void kv.set(escrowKey(id), open, { ex: ttlSecondsFor(open.expiresAt) }).catch(() => {});
      return open;
    }
    const expired: EscrowRecord = { ...rec, status: "expired" };
    // Persist best-effort, guarded by a re-read so a concurrent lock that landed
    // between our read and this write is never clobbered back to `expired`.
    void (async () => {
      try {
        const fresh = await kv.get<EscrowRecord>(escrowKey(id));
        if (fresh && fresh.status === "pending" && Date.now() > new Date(fresh.releaseDeadline).getTime()) {
          await kv.set(escrowKey(id), { ...fresh, status: "expired" }, { ex: ttlSecondsFor(fresh.expiresAt) });
        }
      } catch { /* the computed `expired` view is already returned */ }
    })();
    return expired;
  }
  return rec;
}

export async function listEscrowsPage(
  owner: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ records: EscrowRecord[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), OWNER_INDEX_CAP);
  const offset = Math.max(0, opts.offset ?? 0);
  let ids: string[] = [];
  try {
    ids = (await kv.lrange<string>(escrowOwnerKey(owner), -(offset + limit + 1), -(offset + 1))) ?? [];
  } catch {
    return { records: [], hasMore: false };
  }
  const hasMore = ids.length > limit;
  const pageIds = hasMore ? ids.slice(ids.length - limit) : ids;
  if (pageIds.length === 0) return { records: [], hasMore: false };
  const records = await Promise.all(pageIds.map((id) => getEscrow(id)));
  return {
    records: records
      .filter((r): r is EscrowRecord => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    hasMore,
  };
}

/**
 * Advance the record after an on-chain action lands. Each transition is guarded
 * by the legal from-states so a stale/duplicate callback can never, say, mark a
 * refunded escrow as released. Returns the updated record, or null if the id is
 * unknown, or the unchanged record if the transition is illegal.
 */
export async function markEscrowLocked(id: string, txHash: string): Promise<EscrowRecord | null> {
  return transition(id, ["pending"], (rec) => ({ ...rec, status: "open", lockTxHash: txHash }));
}

export async function markEscrowDisputed(id: string, txHash: string): Promise<EscrowRecord | null> {
  return transition(id, ["open"], (rec) => ({ ...rec, status: "disputed", disputeTxHash: txHash }));
}

export async function markEscrowSettled(
  id: string,
  fields: { outcome: EscrowOutcome; txHash: string; receiptId?: string },
): Promise<EscrowRecord | null> {
  const terminal: EscrowStatus =
    fields.outcome === "release" || fields.outcome === "resolve-seller" ? "released" : "refunded";
  // release settles from `open`; resolve-* settles from `disputed`; refund can
  // settle from `open` after the normal deadline or from `disputed` after the
  // bounded arbiter resolve window.
  const from: EscrowStatus[] =
    fields.outcome === "resolve-seller" || fields.outcome === "resolve-buyer"
      ? ["disputed"]
      : fields.outcome === "refund"
        ? ["open", "disputed"]
        : ["open"];
  return transition(id, from, (rec) => ({
    ...rec,
    status: terminal,
    outcome: fields.outcome,
    settleTxHash: fields.txHash,
    ...(fields.receiptId ? { receiptId: fields.receiptId } : {}),
  }));
}

export async function cancelEscrow(id: string): Promise<EscrowRecord | null> {
  return transition(id, ["pending"], (rec) => ({ ...rec, status: "cancelled" }));
}

async function transition(
  id: string,
  from: EscrowStatus[],
  apply: (rec: EscrowRecord) => EscrowRecord,
): Promise<EscrowRecord | null> {
  const rec = await kv.get<EscrowRecord>(escrowKey(id));
  if (!rec) return null;
  if (!from.includes(rec.status)) return rec; // illegal transition — no-op
  const next = apply(rec);
  await kv.set(escrowKey(id), next, { ex: ttlSecondsFor(next.expiresAt) });
  return next;
}

// ─── Action lock + durable settled marker (mirror payment-request) ────────────

export async function acquireEscrowActionLock(id: string): Promise<boolean> {
  return !!(await kv.set(escrowLockKey(id), "1", { nx: true, ex: 120 }));
}
export async function releaseEscrowActionLock(id: string): Promise<void> {
  await kv.del(escrowLockKey(id)).catch(() => {});
}

export interface EscrowSettledMarker {
  outcome: EscrowOutcome;
  txHash: string;
  settledAt: string; // ISO
}

export async function getEscrowSettledMarker(id: string): Promise<EscrowSettledMarker | null> {
  if (!isValidEscrowId(id)) return null;
  try {
    return (await kv.get<EscrowSettledMarker>(escrowSettledKey(id))) ?? null;
  } catch {
    return null;
  }
}

export async function writeEscrowSettledMarker(
  id: string,
  marker: EscrowSettledMarker,
  expiresAtIso: string,
): Promise<boolean> {
  const ttl = ttlSecondsFor(expiresAtIso);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await kv.set(escrowSettledKey(id), marker, { ex: ttl });
      return true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return false;
}

// ─── Durable locked marker (mirror the settled marker) ───────────────────────
// Written the instant a lock tx lands, BEFORE the status flip, so a lost flip
// (KV blip) can never strand on-chain funds behind a `pending`/`expired` record.

export interface EscrowLockedMarker {
  txHash: string;
  lockedAt: string; // ISO
}

export async function getEscrowLockedMarker(id: string): Promise<EscrowLockedMarker | null> {
  if (!isValidEscrowId(id)) return null;
  try {
    return (await kv.get<EscrowLockedMarker>(escrowLockedKey(id))) ?? null;
  } catch {
    return null;
  }
}

export async function writeEscrowLockedMarker(
  id: string,
  marker: EscrowLockedMarker,
  expiresAtIso: string,
): Promise<boolean> {
  const ttl = ttlSecondsFor(expiresAtIso);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await kv.set(escrowLockedKey(id), marker, { ex: ttl });
      return true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return false;
}

export function toPublicEscrow(r: EscrowRecord): PublicEscrow {
  return {
    id: r.id,
    salt: r.salt,
    onchainEscrowId: r.onchainEscrowId,
    buyer: r.buyer,
    seller: r.seller,
    chain: r.chain,
    token: r.token,
    amount: r.amount,
    ...(r.arbiter ? { arbiter: r.arbiter } : {}),
    ...(r.memo ? { memo: r.memo } : {}),
    releaseDeadline: r.releaseDeadline,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.lockTxHash ? { lockTxHash: r.lockTxHash } : {}),
    ...(r.settleTxHash ? { settleTxHash: r.settleTxHash } : {}),
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(r.disputeTxHash ? { disputeTxHash: r.disputeTxHash } : {}),
    ...(r.receiptId ? { receiptId: r.receiptId } : {}),
    sandbox: r.sandbox,
  };
}
