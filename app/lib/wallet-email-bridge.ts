/**
 * wallet-email-bridge.ts
 *
 * Single helper for the two-direction KV index that bridges a wallet
 * address ↔ email for 1:1 binding enforcement and wallet-only login
 * lookup:
 *
 *   wallet_email_link:{addr}  → email
 *   email_to_wallet:{email}   → addr
 *
 * Both keys MUST be set for the bridge to be queryable from either side;
 * a partial write (one key set, the other dropped) lets a future bind
 * incorrectly think no claim exists and creates 1:1 drift.
 *
 * The writes use SET NX semantics on BOTH directions so two concurrent
 * binds cannot both pass and last-write-wins the global index. The
 * caller's pre-check (load both indexes, reject if either points at a
 * different counterpart) is still kept as a friendly early-rejection
 * path — but the race-safe guarantee lives here.
 *
 * Result shape:
 *   { ok: true,  conflict: undefined }                — both directions claimed
 *   { ok: false, conflict: "email_already_bound" }    — emailKey points at a different addr
 *   { ok: false, conflict: "wallet_already_bound" }   — walletKey points at a different email
 *   { ok: false, conflict: "kv_write" }               — transient KV failure after retries
 *
 * "Same value, key already exists" is idempotent re-bind and is treated
 * as ok=true (retry safety).
 */
import { kv } from "@vercel/kv";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

export type BridgeConflict = "email_already_bound" | "wallet_already_bound" | "kv_write";

export interface BridgeWriteResult {
  ok:       boolean;
  conflict?: BridgeConflict;
  error?:   string;
  /** The address currently bound to this email (when conflict=email_already_bound). */
  existingAddr?:  string;
  /** The email currently bound to this wallet (when conflict=wallet_already_bound). */
  existingEmail?: string;
}

type ClaimOutcome =
  | { status: "claimed" }
  | { status: "matched" }              // existing value equals our desired value (idempotent)
  | { status: "conflict"; existing: string }
  | { status: "error"; error: string };

const RETRY_DELAYS = [50, 250, 750];

/**
 * Atomic SET-NX-or-match. Tries to claim the key with the given value:
 *   - If empty → claim succeeds via NX. Returns "claimed".
 *   - If exists with same value → idempotent retry. Returns "matched".
 *   - If exists with different value → conflict. Returns the existing value.
 *   - Transient KV error → retries up to 3 times with backoff, then "error".
 */
async function setNxOrMatch(
  key:   string,
  value: string,
  ttlSec: number,
): Promise<ClaimOutcome> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    try {
      const claimed = await kv.set(key, value, { nx: true, ex: ttlSec });
      if (claimed) return { status: "claimed" };
      // NX returned null → key already exists. Read and compare.
      const existing = await kv.get<string>(key);
      if (existing == null) {
        // Race between SET NX returning null and GET seeing it gone (TTL
        // expiry mid-call). Retry the SET.
        continue;
      }
      return existing === value
        ? { status: "matched" }
        : { status: "conflict", existing };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY_DELAYS.length - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }
  return {
    status: "error",
    error:  lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

/**
 * Write the wallet ↔ email bridge atomically (SET NX on both directions).
 *
 * Order matters for rollback semantics:
 *   1. Claim the EMAIL→wallet direction first. Email is the "primary" side
 *      — a second wallet trying to claim the same email is the more
 *      damaging race (it can grant a second trial). Reject early if a
 *      different wallet already holds this email.
 *   2. Then claim the WALLET→email direction. If that conflicts, roll
 *      back the email claim (only if we ourselves wrote it — not if it
 *      matched-existing).
 *
 * The 10-year TTL on these keys means "claimed" effectively persists
 * forever; "matched" means a prior bind already wrote the same value.
 */
export async function writeWalletEmailBridge(
  addr:    string,
  email:   string,
  ttlSec:  number,
  caller:  string,
): Promise<BridgeWriteResult> {
  const walletKey = `wallet_email_link:${addr}`;
  const emailKey  = `email_to_wallet:${email}`;

  // Phase 1: claim email side
  const emailClaim = await setNxOrMatch(emailKey, addr, ttlSec);
  if (emailClaim.status === "conflict") {
    return { ok: false, conflict: "email_already_bound", existingAddr: emailClaim.existing };
  }
  if (emailClaim.status === "error") {
    await fireDriftAlert(addr, email, caller, { side: "email", error: emailClaim.error });
    return { ok: false, conflict: "kv_write", error: emailClaim.error };
  }

  // Phase 2: claim wallet side
  const walletClaim = await setNxOrMatch(walletKey, email, ttlSec);
  if (walletClaim.status === "conflict") {
    // Roll back the email claim ONLY if we wrote it ourselves this call.
    if (emailClaim.status === "claimed") {
      await kv.del(emailKey).catch(() => {});
    }
    return { ok: false, conflict: "wallet_already_bound", existingEmail: walletClaim.existing };
  }
  if (walletClaim.status === "error") {
    // Don't roll back the email claim on transient KV error — half-written
    // is still consistent with our promise (next retry will see the
    // existing email→wallet entry and either match it or conflict).
    await fireDriftAlert(addr, email, caller, { side: "wallet", error: walletClaim.error });
    return { ok: false, conflict: "kv_write", error: walletClaim.error };
  }

  return { ok: true };
}

async function fireDriftAlert(
  addr:   string,
  email:  string,
  caller: string,
  detail: { side: "email" | "wallet"; error: string },
): Promise<void> {
  try {
    const dedupKey = `bridge_write_alert:${addr}`;
    const fresh = await kv.set(dedupKey, "1", { nx: true, ex: 3600 }).catch(() => null);
    if (!fresh) return;
    const lines = [
      `<b>Wallet ↔ email bridge KV write failed</b>`,
      `Caller: <code>${caller}</code>`,
      `Address: <code>${addr}</code>`,
      `Email: <code>${email}</code>`,
      `Failed side: ${detail.side}`,
      `Error: ${detail.error}`,
      "",
      "Bind / activation upstream of this helper may already be committed. " +
      "Future wallet-only lookups for this address may not surface the " +
      "email's trial state until KV recovers and the bind is retried.",
    ].join("\n");
    await sendOpsAlert(lines, "warn");
  } catch {
    /* alert path must not throw out of the bridge write */
  }
}
