// Pure types + canonical / verification helpers shared between server and
// client. NO server-only imports here (kv, Wallet, node:crypto) — anything
// that touches the relayer private key or KV must live in receipt.ts.
//
// The Verify button on /receipt/[id] uses these exact functions client-side
// to recompute the canonical hash and recover the signer locally. They MUST
// match the server's signing logic byte-for-byte.

import { keccak256, toUtf8Bytes, getBytes, verifyMessage } from "ethers";
import type { ChainKey } from "@/app/lib/relayer";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ReceiptMethod = "eip7702" | "eip3009" | "eip7702_xlayer" | "eip7702_stable";

export type WebhookDeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "not_configured";

export interface ReceiptWebhook {
  configured:       boolean;
  event:            string;
  deliveryStatus:   WebhookDeliveryStatus;
  attempts?:        number;
  lastStatusCode?:  number;
  lastError?:       string;
  deliveredAt?:     string;
  payloadSha256?:   string;
  signatureSha256?: string;
}

export interface Receipt {
  receiptId:        string;
  createdAt:        string;
  txHash:           string;
  blockNumber?:     number;
  chain:            ChainKey;
  payer:            string;
  recipient:        string;
  token:            "USDC" | "USDT";
  tokenAmount:      string;
  tokenAmountRaw:   string;
  method:           ReceiptMethod;
  gasCostNative?:   string;
  // apiKeyId + apiKeyTier are server-only audit fields. They are stored in
  // the raw KV record for internal correlation, but stripped by publicView()
  // and excluded from ReceiptSignedFields so a public reader can't use the
  // receipt URL to correlate activity across multiple settlements for the
  // same project. (Reviewer P3 feedback, 2026-05.)
  apiKeyId?:        string;
  apiKeyTier?:      string;
  showTier:         boolean;
  sandbox:          boolean;
  webhook:          ReceiptWebhook;
  signature:        string;
  signedBy:         string;
  signedAt:         string;
}

export type ReceiptSignedFields = Pick<Receipt,
  | "receiptId"
  | "createdAt"
  | "txHash"
  | "chain"
  | "payer"
  | "recipient"
  | "token"
  | "tokenAmount"
  | "tokenAmountRaw"
  | "method"
  | "sandbox"
>;

// ─────────────────────────────────────────────────────────────────────────────
// Canonical form + digest + verify
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalize(fields: ReceiptSignedFields): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(fields).sort()) {
    sorted[k] = (fields as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(sorted);
}

export function receiptDigest(canonical: string): string {
  return keccak256(toUtf8Bytes(canonical));
}

export function verifyReceiptSignature(
  fields:         ReceiptSignedFields,
  signature:      string,
  expectedSigner: string,
): boolean {
  try {
    const canonical = canonicalize(fields);
    const digest    = receiptDigest(canonical);
    const recovered = verifyMessage(getBytes(digest), signature).toLowerCase();
    return recovered === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}
