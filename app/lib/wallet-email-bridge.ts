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
 * Earlier revisions called `kv.set` twice without `await`, relying on
 * fire-and-forget. KV transient failures caused silent drift — bind
 * succeeded in the session but the global index missed. New behaviour:
 *
 *   - Attempt both writes with 3 retries (50ms / 250ms / 750ms backoff).
 *   - Idempotent against partial-previous-write — re-setting the same
 *     key/value is a no-op for our consumers.
 *   - Persistent failure (all 3 retries exhausted on either key) emits a
 *     deduped ops alert (1h TTL per address) so operators can detect
 *     drift and reconcile, without blocking the user's bind path. The
 *     bind itself stays committed regardless of bridge-write outcome.
 */
import { kv } from "@vercel/kv";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

export interface BridgeWriteResult {
  ok: boolean;
  walletLinkWritten: boolean;
  emailLinkWritten:  boolean;
  attempts:          number;
  error?:            string;
}

async function setWithRetry(
  key:   string,
  value: string,
  ttlSec: number,
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const delays = [50, 250, 750];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await kv.set(key, value, { ex: ttlSec });
      return { ok: true, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      // Don't sleep on the last attempt — caller is going to give up anyway.
      if (attempt < delays.length - 1) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
    }
  }
  return {
    ok:       false,
    attempts: delays.length,
    error:    lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

/**
 * Write the wallet↔email bridge atomically (well, as atomic as a 2-key KV
 * pair without transactions can be). Both keys are written sequentially
 * with retry; the function awaits both before returning. Failure on either
 * side fires an ops alert but does NOT throw — the caller's primary side
 * effect (bind / trial activation) is already committed at this point and
 * surfacing a 5xx now would be misleading.
 */
export async function writeWalletEmailBridge(
  addr:    string,
  email:   string,
  ttlSec:  number,
  caller:  string,
): Promise<BridgeWriteResult> {
  const walletKey = `wallet_email_link:${addr}`;
  const emailKey  = `email_to_wallet:${email}`;

  const walletWrite = await setWithRetry(walletKey, email, ttlSec);
  const emailWrite  = await setWithRetry(emailKey,  addr,  ttlSec);

  const result: BridgeWriteResult = {
    ok:                walletWrite.ok && emailWrite.ok,
    walletLinkWritten: walletWrite.ok,
    emailLinkWritten:  emailWrite.ok,
    attempts:          Math.max(walletWrite.attempts, emailWrite.attempts),
    error:             walletWrite.error ?? emailWrite.error,
  };

  if (!result.ok) {
    // Dedup so a 503'ing KV doesn't page on every retry from the user.
    const dedupKey = `bridge_write_alert:${addr}`;
    const fresh = await kv.set(dedupKey, "1", { nx: true, ex: 3600 }).catch(() => null);
    if (fresh) {
      const lines = [
        `<b>Wallet ↔ email bridge index write failed</b>`,
        `Caller: <code>${caller}</code>`,
        `Address: <code>${addr}</code>`,
        `Email: <code>${email}</code>`,
        `walletLinkWritten: ${result.walletLinkWritten}`,
        `emailLinkWritten:  ${result.emailLinkWritten}`,
        `attempts (max): ${result.attempts}`,
        result.error ? `error: ${result.error}` : "",
        "",
        "Bind/activation already committed; the bridge index is missing on at least one side. " +
        "Future wallet-only sign-ins may not surface the email's trial state until reconciliation.",
      ].filter(Boolean).join("\n");
      await sendOpsAlert(lines, "warn");
    }
  }

  return result;
}
