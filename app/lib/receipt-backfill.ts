// Receipt backfill — strong guarantee that every successful relay eventually
// gets a Trust Receipt, even when the inline createReceipt() call fails
// (KV blip, RELAYER_PRIVATE_KEY rotation, ECONNRESET, etc.).
//
// Flow:
//   1. relay/route.ts attempts createReceipt() inline.
//   2. On failure, queueReceiptBackfill() drops a minimal entry into KV:
//        receipt-backfill-queue            (Set of txHashes pending backfill)
//        receipt-backfill:{txHash}         (the BackfillEntry payload)
//   3. /api/cron/receipt-backfill scans the Set, takes a per-tx lock, and
//      retries createReceipt(). Successful entries are removed from the
//      queue. Entries that exceed MAX_ATTEMPTS are dropped with a log line.
//
// The backfill receipt's webhook delivery state is conservatively marked
// "failed" with `lastError: "delivery state recovered via backfill"` when a
// webhook had been configured at relay time, since the original dispatch
// state isn't reconstructible from KV alone. The receipt itself — the
// settlement attestation — is what matters; the trace is metadata.

import { kv } from "@vercel/kv";
import { createReceipt } from "@/app/lib/receipt";
import { patchRelayedTxReceiptId, getWebhookDeliveries } from "@/app/lib/db";
import type { ChainKey } from "@/app/lib/relayer";
import type { ReceiptMethod, ReceiptWebhook } from "@/app/lib/receipt-shared";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const QUEUE_KEY    = "receipt-backfill-queue";
export const ENTRY_PREFIX = "receipt-backfill:";
export const LOCK_PREFIX  = "receipt-backfill-lock:";

export const TTL_SECONDS  = 7 * 24 * 60 * 60;        // 7 days — drop entries that
                                                     // can't be processed within a week
export const LOCK_TTL_SEC = 60;                      // single-worker exclusion

export const MAX_ATTEMPTS = 5;                       // give up after this

const entryKey = (tx: string) => `${ENTRY_PREFIX}${tx.toLowerCase()}`;
const lockKey  = (tx: string) => `${LOCK_PREFIX}${tx.toLowerCase()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BackfillEntry {
  txHash:            string;
  address:           string;        // q402 customer wallet (api key owner)
  chain:             ChainKey;
  payer:             string;
  recipient:         string;
  token:             "USDC" | "USDT";
  tokenAmount:       string;
  tokenAmountRaw:    string;
  method:            ReceiptMethod;
  gasCostNative?:    string;
  apiKeyTier:        string;
  apiKeyId:          string;
  sandbox:           boolean;
  webhookConfigured: boolean;
  blockNumber?:      number;
  relayedAt:         string;
  queuedAt:          string;
  attempts:          number;
}

export type BackfillInput = Omit<BackfillEntry, "queuedAt" | "attempts">;

export type ProcessResult =
  | { ok: true;  receiptId: string }
  | { ok: false; reason: string; givenUp: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Queue helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop an entry into the backfill queue. Idempotent — repeated calls for the
 * same txHash overwrite the entry payload but only add the txHash to the Set
 * once (Redis SADD semantics).
 */
export async function queueReceiptBackfill(input: BackfillInput): Promise<void> {
  if (!input.txHash) return;             // nothing to anchor on; skip
  const entry: BackfillEntry = {
    ...input,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  await Promise.all([
    kv.sadd(QUEUE_KEY, input.txHash.toLowerCase()),
    kv.set(entryKey(input.txHash), entry, { ex: TTL_SECONDS }),
  ]);
}

/**
 * Read the current queue. Returns entries in arbitrary order — callers that
 * care about ordering should sort by queuedAt themselves.
 */
export async function listBackfillQueue(): Promise<BackfillEntry[]> {
  const txHashes = (await kv.smembers(QUEUE_KEY)) as string[] | null;
  if (!txHashes || txHashes.length === 0) return [];
  const entries = await Promise.all(txHashes.map(tx => kv.get<BackfillEntry>(entryKey(tx))));
  // Drop any nulls (TTL'd or otherwise missing payloads) and clean their
  // dangling references in the Set so next run is shorter.
  const orphaned: string[] = [];
  const valid: BackfillEntry[] = [];
  entries.forEach((entry, i) => {
    if (entry) valid.push(entry);
    else       orphaned.push(txHashes[i]);
  });
  if (orphaned.length > 0) {
    await Promise.all(orphaned.map(tx => kv.srem(QUEUE_KEY, tx))).catch(() => {});
  }
  return valid;
}

async function dequeue(txHash: string): Promise<void> {
  await Promise.all([
    kv.srem(QUEUE_KEY, txHash.toLowerCase()),
    kv.del(entryKey(txHash)),
  ]);
}

/**
 * Recover the webhook delivery state for a backfilled receipt from the
 * audit log. recordWebhookDelivery() stamps txHash on every entry so we
 * can find the matching dispatch attempt and rebuild a truthful trace
 * (delivered / failed / pending) instead of always marking it "failed",
 * which produced false negatives in the previous implementation.
 *
 * If the customer never configured a webhook, returns "not_configured".
 * If a webhook was configured but no delivery record exists yet, returns
 * "pending" (the dispatch may still be in flight when the cron runs).
 */
async function reconstructWebhookState(entry: BackfillEntry): Promise<ReceiptWebhook> {
  if (!entry.webhookConfigured) {
    return {
      configured:     false,
      event:          "relay.success",
      deliveryStatus: "not_configured",
    };
  }

  let match: Awaited<ReturnType<typeof getWebhookDeliveries>>[number] | undefined;
  try {
    const deliveries = await getWebhookDeliveries(entry.address);
    const targetTx = entry.txHash.toLowerCase();
    match = deliveries.find(d => (d.txHash ?? "").toLowerCase() === targetTx);
  } catch {
    /* ignore — fall through to "pending" below */
  }

  if (!match) {
    // Configured but we have no audit record — best honest answer is
    // "pending" (delivery may still happen) rather than the previous
    // false-negative "failed".
    return {
      configured:     true,
      event:          "relay.success",
      deliveryStatus: "pending",
    };
  }

  return {
    configured:      true,
    event:           "relay.success",
    deliveryStatus:  match.ok ? "delivered" : "failed",
    attempts:        match.attempt,
    lastStatusCode:  match.statusCode,
    lastError:       match.error,
    deliveredAt:     match.ok ? match.timestamp : undefined,
  };
}

async function bumpAttempts(entry: BackfillEntry): Promise<void> {
  await kv.set(entryKey(entry.txHash), { ...entry, attempts: entry.attempts + 1 }, { ex: TTL_SECONDS });
}

// ─────────────────────────────────────────────────────────────────────────────
// Processor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to materialize one backfill entry into a real Receipt. Returns
 * { ok: true } on success (entry removed from queue) or { ok: false } on
 * failure (entry kept; given up after MAX_ATTEMPTS). Uses a per-tx KV lock
 * so concurrent cron invocations don't double-process the same entry.
 */
export async function processBackfillEntry(entry: BackfillEntry): Promise<ProcessResult> {
  const lock = await kv.set(lockKey(entry.txHash), "1", { nx: true, ex: LOCK_TTL_SEC });
  if (lock !== "OK") {
    return { ok: false, reason: "Locked by another worker", givenUp: false };
  }

  // Recover the actual webhook delivery state from the audit log so the
  // backfilled receipt's trace reflects what really happened, not a worst-
  // case guess. recordWebhookDelivery now stamps txHash on every entry, so
  // a precise lookup is possible.
  const webhookState = await reconstructWebhookState(entry);

  try {
    const receipt = await createReceipt({
      txHash:         entry.txHash,
      blockNumber:    entry.blockNumber,
      chain:          entry.chain,
      payer:          entry.payer,
      recipient:      entry.recipient,
      token:          entry.token,
      tokenAmount:    entry.tokenAmount,
      tokenAmountRaw: entry.tokenAmountRaw,
      method:         entry.method,
      gasCostNative:  entry.gasCostNative,
      apiKeyId:       entry.apiKeyId,
      apiKeyTier:     entry.apiKeyTier,
      showTier:       false,
      sandbox:        entry.sandbox,
      webhook:        webhookState,
    });

    // Patch the existing RelayedTx history row so the dashboard's
    // "View Receipt" link starts working for this tx. The original row
    // was written with receiptId=undefined when inline createReceipt
    // failed; without this patch the dashboard would forever show "—"
    // even after the receipt itself exists. Best-effort — the receipt
    // is the source of truth, the column is cosmetic.
    const patched = await patchRelayedTxReceiptId(
      entry.address,
      entry.txHash,
      receipt.receiptId,
      entry.relayedAt,
    ).catch((e: unknown) => {
      console.error(`[receipt-backfill] tx-history patch failed for ${entry.txHash}:`, e);
      return false;
    });
    if (!patched) {
      console.warn(
        `[receipt-backfill] tx-history row for ${entry.txHash} not found — dashboard will not show the receipt link until the row ages out`,
      );
    }

    await dequeue(entry.txHash);
    return { ok: true, receiptId: receipt.receiptId };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await bumpAttempts(entry);
    if (entry.attempts + 1 >= MAX_ATTEMPTS) {
      console.error(
        `[receipt-backfill] giving up on ${entry.txHash} after ${MAX_ATTEMPTS} attempts: ${reason}`,
      );
      await dequeue(entry.txHash);
      return { ok: false, reason: `gave up after ${MAX_ATTEMPTS} attempts: ${reason}`, givenUp: true };
    }
    return { ok: false, reason, givenUp: false };
  } finally {
    // Best-effort lock release; if this fails the lock TTL will clean up.
    await kv.del(lockKey(entry.txHash)).catch(() => {});
  }
}
