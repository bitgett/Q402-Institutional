// Server-side Trust Receipt module.
//
// Storage layout (Vercel KV / Upstash Redis, TTL 1y):
//   receipt:{receiptId}    → JSON Receipt
//   receipt-by-tx:{txHash} → receiptId          (lookup helper)
//
// Pure types + canonical/verify helpers live in ./receipt-shared so they
// can be safely imported by client components (the /receipt/[id] page
// uses verifyReceiptSignature in the browser). This file only adds the
// server-only pieces: KV CRUD, EOA signing with RELAYER_PRIVATE_KEY, and
// id/fingerprint generation that pulls from node:crypto.

import { kv } from "@vercel/kv";
import { Wallet, getBytes } from "ethers";
import { randomBytes, createHash } from "node:crypto";
import {
  canonicalize,
  receiptDigest,
  type Receipt,
  type ReceiptSignedFields,
  type ReceiptWebhook,
} from "@/app/lib/receipt-shared";

// Re-export the shared surface so existing imports of `@/app/lib/receipt`
// keep working without each call site needing to learn about the split.
export {
  canonicalize,
  receiptDigest,
  verifyReceiptSignature,
} from "@/app/lib/receipt-shared";
export type {
  Receipt,
  ReceiptSignedFields,
  ReceiptWebhook,
  ReceiptMethod,
  WebhookDeliveryStatus,
} from "@/app/lib/receipt-shared";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const RECEIPT_TTL_SECONDS = 365 * 24 * 60 * 60;        // 1 year
const RECEIPT_PREFIX      = "rct_";
const RECEIPT_ID_BYTES    = 12;                        // → 24 hex chars

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function receiptKey(id: string)        { return `receipt:${id}`; }
function receiptByTxKey(tx: string)    { return `receipt-by-tx:${tx.toLowerCase()}`; }

export function newReceiptId(): string {
  return RECEIPT_PREFIX + randomBytes(RECEIPT_ID_BYTES).toString("hex");
}

export function apiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * Sign a receipt's settlement fields with the relayer's private key.
 * Throws if RELAYER_PRIVATE_KEY is unset.
 */
export async function signReceiptFields(fields: ReceiptSignedFields): Promise<{
  signature: string;
  signedBy:  string;
  signedAt:  string;
}> {
  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) throw new Error("RELAYER_PRIVATE_KEY unset; cannot sign receipt");
  const wallet    = new Wallet(pk);
  const canonical = canonicalize(fields);
  const digest    = receiptDigest(canonical);
  const signature = await wallet.signMessage(getBytes(digest));
  return {
    signature,
    signedBy: wallet.address.toLowerCase(),
    signedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

export async function createReceipt(input: Omit<Receipt,
  | "receiptId" | "createdAt" | "signature" | "signedBy" | "signedAt"
>): Promise<Receipt> {
  // Idempotency on txHash — if a receipt already exists for this settlement,
  // return it unchanged instead of producing a duplicate. Closes the
  // "one tx → two receipts" race that opens up when the inline body write
  // succeeds but the surrounding bookkeeping (RelayedTx record, queue
  // dequeue, response delivery) fails and a retry/backfill path tries again.
  // The receipt-by-tx index is the canonical lookup; if it points to a
  // present body, we're done. If the index points to something missing
  // (TTL'd, manually purged), we fall through and re-create — accepting the
  // very rare orphan over the more common silent loss.
  if (input.txHash) {
    const existingId = await getReceiptIdByTx(input.txHash);
    if (existingId) {
      const existing = await getReceipt(existingId);
      if (existing) return existing;
    }
  }

  const receiptId = newReceiptId();
  const createdAt = new Date().toISOString();

  const signedFields: ReceiptSignedFields = {
    receiptId,
    createdAt,
    txHash:         input.txHash,
    chain:          input.chain,
    payer:          input.payer,
    recipient:      input.recipient,
    token:          input.token,
    tokenAmount:    input.tokenAmount,
    tokenAmountRaw: input.tokenAmountRaw,
    method:         input.method,
    sandbox:        input.sandbox,
  };

  const proof = await signReceiptFields(signedFields);

  const receipt: Receipt = {
    ...input,
    receiptId,
    createdAt,
    ...proof,
  };

  await Promise.all([
    kv.set(receiptKey(receiptId), receipt, { ex: RECEIPT_TTL_SECONDS }),
    kv.set(receiptByTxKey(input.txHash), receiptId, { ex: RECEIPT_TTL_SECONDS }),
  ]);

  return receipt;
}

export async function getReceipt(receiptId: string): Promise<Receipt | null> {
  if (!receiptId.startsWith(RECEIPT_PREFIX)) return null;
  return await kv.get<Receipt>(receiptKey(receiptId));
}

export async function getReceiptIdByTx(txHash: string): Promise<string | null> {
  return await kv.get<string>(receiptByTxKey(txHash));
}

export async function updateReceiptWebhookStatus(
  receiptId: string,
  patch:     Partial<ReceiptWebhook>,
): Promise<Receipt | null> {
  const current = await getReceipt(receiptId);
  if (!current) return null;
  const next: Receipt = {
    ...current,
    webhook: { ...current.webhook, ...patch },
  };
  await kv.set(receiptKey(receiptId), next, { ex: RECEIPT_TTL_SECONDS });
  return next;
}

/**
 * Public-shaped receipt view. Strips both apiKeyId (always — it's a stable
 * identifier that lets external readers correlate activity across receipts
 * for the same project) and apiKeyTier (unless the customer explicitly
 * toggled showTier on; default false).
 *
 * Neither field is in the signed canonical hash, so stripping them here
 * doesn't break the Verify button on the receipt page.
 */
export function publicView(receipt: Receipt): Receipt {
  const view: Receipt = { ...receipt };
  delete view.apiKeyId;
  if (!receipt.showTier) delete view.apiKeyTier;
  return view;
}
