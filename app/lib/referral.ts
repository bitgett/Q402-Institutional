/**
 * Q402 Referral — link generation + new-user attribution + counting.
 *
 * Model (a "user" is an owner EOA, same identity the Agent Wallet schema uses):
 *   - Each owner has a DETERMINISTIC short code derived from their address, so
 *     no minting state is needed; we persist only the reverse map for O(1)
 *     resolution at claim time.
 *   - A referral is counted when a NEW user (referee, on their FIRST Agent
 *     Wallet) arrived via a referral link. Counting is gated by the route
 *     (first-wallet) and made exactly-once here by SET NX on ref:claimed:{referee}.
 *
 * KV keys (alongside the aw:* surface, same @vercel/kv client):
 *   ref:owner:{code}      → owner            (immutable reverse map)
 *   ref:code:{owner}      → code             (convenience cache)
 *   ref:claimed:{referee} → referrer         (SET NX — one attribution per referee, ever)
 *   ref:count:{owner}     → integer          (INCR)
 *   ref:referees:{owner}  → list of {address, ts}
 *   ref:leaderboard       → ZSET score=count member=owner (for a future leaderboard)
 *
 * No rewards are attached (metric/leaderboard only), so attribution carries no
 * funds — the guards here exist to keep the COUNT honest (no self-referral, no
 * double-count), not to defend money.
 */

import { kv } from "@vercel/kv";
import { keccak256, toUtf8Bytes } from "ethers";

const lower = (a: string) => a.toLowerCase();

const ownerByCodeKey = (code: string) => `ref:owner:${code}`;
const codeByOwnerKey = (owner: string) => `ref:code:${lower(owner)}`;
const claimedKey = (referee: string) => `ref:claimed:${lower(referee)}`;
const countKey = (owner: string) => `ref:count:${lower(owner)}`;
const refereesKey = (owner: string) => `ref:referees:${lower(owner)}`;
const LEADERBOARD_KEY = "ref:leaderboard";

/** Cap the stored referee list so a viral referrer can't grow an unbounded KV
 *  value; the count (INCR) is authoritative, the list is just for display. */
const REFEREE_LIST_CAP = 500;

export interface RefereeEntry {
  address: string;
  ts: number;
}

export interface ReferralStats {
  code: string;
  count: number;
  referees: RefereeEntry[];
  /** 1-based position on the all-inviters leaderboard, or null when count is 0
   *  (not yet on the board). Derived from the ref:leaderboard ZSET. */
  rank: number | null;
  /** Total number of owners who have referred at least one user (ZSET size). */
  totalInviters: number;
}

export interface ClaimResult {
  counted: boolean;
  reason?: "unknown_code" | "self" | "already_claimed";
  referrer?: string;
}

/**
 * Deterministic, URL-safe referral code for an owner EOA: base36 of the first
 * 7 bytes of keccak256("q402-ref:"+owner). ~10 chars, ~7.2e16 space, so the
 * collision probability is negligible at any realistic user count. Deterministic
 * means the same address always yields the same link with no minting round-trip.
 */
export function referralCodeFor(owner: string): string {
  const h = keccak256(toUtf8Bytes(`q402-ref:${lower(owner)}`)); // 0x + 64 hex
  return BigInt(h.slice(0, 16)).toString(36); // first 7 bytes → base36
}

/** Owner's code, persisting the immutable code→owner reverse map (NX) so claim()
 *  can resolve it. Idempotent. */
export async function getOrCreateReferralCode(owner: string): Promise<string> {
  const code = referralCodeFor(owner);
  await Promise.all([
    kv.set(ownerByCodeKey(code), lower(owner), { nx: true }),
    kv.set(codeByOwnerKey(owner), code, { nx: true }),
  ]);
  return code;
}

/** Resolve the owner behind a referral code, or null. */
export async function resolveReferrer(code: string): Promise<string | null> {
  if (!code || typeof code !== "string") return null;
  const owner = await kv.get<string>(ownerByCodeKey(code.trim()));
  return owner ?? null;
}

export async function getReferralStats(owner: string): Promise<ReferralStats> {
  const code = await getOrCreateReferralCode(owner);
  const [count, referees, rank0, totalInviters] = await Promise.all([
    kv.get<number>(countKey(owner)),
    kv.lrange<RefereeEntry>(refereesKey(owner), 0, -1),
    kv.zrevrank(LEADERBOARD_KEY, lower(owner)), // 0-based, or null if not ranked
    kv.zcard(LEADERBOARD_KEY),
  ]);
  return {
    code,
    count: count ?? 0,
    referees: referees ?? [],
    rank: typeof rank0 === "number" ? rank0 + 1 : null,
    totalInviters: totalInviters ?? 0,
  };
}

/**
 * Attribute a NEW user (referee) to the referrer behind `code`. Best-effort,
 * idempotent, integrity-guarded:
 *   - unknown/empty code        → no-op (unknown_code)
 *   - self-referral             → no-op (self)
 *   - already attributed before → no-op (already_claimed)
 * The CALLER must gate on first-wallet (only a genuinely new user reaches here);
 * SET NX on ref:claimed makes the INCR exactly-once even under a create race.
 */
export async function claimReferral(referee: string, code: string): Promise<ClaimResult> {
  const ref = lower(referee);
  const referrer = await resolveReferrer(code);
  if (!referrer) return { counted: false, reason: "unknown_code" };
  if (referrer === ref) return { counted: false, reason: "self", referrer };

  // One attribution per referee, ever — the single source of truth. Wins the
  // race, so exactly one caller proceeds to INCR.
  const claimed = await kv.set(claimedKey(ref), referrer, { nx: true });
  if (!claimed) return { counted: false, reason: "already_claimed", referrer };

  await Promise.all([
    kv.incr(countKey(referrer)),
    kv.rpush(refereesKey(referrer), { address: ref, ts: Date.now() }),
    kv.ltrim(refereesKey(referrer), -REFEREE_LIST_CAP, -1),
    kv.zincrby(LEADERBOARD_KEY, 1, referrer),
  ]);
  return { counted: true, referrer };
}
