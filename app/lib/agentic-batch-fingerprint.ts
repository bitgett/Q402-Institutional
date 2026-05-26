/**
 * agentic-batch-fingerprint.ts — shared client + server fingerprint for
 * batch sends. The route uses the result as the idempotency key
 * (`aw:batch:{fp}`) AND as one of the intent fields in the
 * action-challenge canonical message. The dashboard modal needs to
 * compute the SAME hash before requesting the challenge so the user
 * signs a message that pins this exact recipient set.
 *
 * Layout: lowercase owner | chain | token | sorted "recipient:amount"
 * pairs joined by `,`. Keccak256 of the resulting UTF-8 bytes, then
 * the leading 16 hex chars (no `0x`). 64-bit truncation is enough
 * collision space for the idempotency cache and keeps the KV key
 * short.
 */

import { ethers } from "ethers";

export interface BatchRow {
  to: string;
  amount: string;
}

export function agenticBatchFingerprint(
  owner: string,
  chain: string,
  token: string,
  rows: BatchRow[],
): string {
  const sorted = rows
    .map((r) => `${r.to.toLowerCase()}:${r.amount}`)
    .sort()
    .join(",");
  const seed = `${owner.toLowerCase()}|${chain}|${token}|${sorted}`;
  return ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(2, 18);
}
