/**
 * agent-metadata-store.ts — content-addressed Agent Wallet metadata
 * helpers.
 *
 * Used by `/api/wallet/agentic/register-agent` (writer) and
 * `/api/wallet/agentic/agent-metadata/[hash]` (reader) so the key
 * format and hashing convention live in exactly one place. We do not
 * pin to IPFS; the canonical JSON is stored verbatim in KV and served
 * from Q402's own domain.
 *
 * Hash format: keccak256 of the canonical JSON byte sequence,
 * `0x`-prefixed lowercase hex. Same shape as an EVM tx hash so the
 * URLs read naturally to anyone who's looked at Etherscan.
 */

import { ethers } from "ethers";

/**
 * Stable string serialisation used as the hashing input.
 *
 * Plain `JSON.stringify` follows insertion order, which means two
 * producers building the same logical payload via different key
 * orderings would emit different bytes and therefore different
 * keccak256 hashes. We sort object keys recursively before
 * serialisation so the hash is content-determined, not call-site-
 * determined. This is "canonical enough" for our agent-metadata
 * use case — we are not implementing RFC 8785 (no float
 * normalisation, no UTF-8 NFC step) because the metadata builder
 * controls all numeric fields and the JSON values are plain
 * ASCII strings.
 *
 * Idempotency contract: for *any* permutation of the same logical
 * object tree, `canonicalJson(a) === canonicalJson(b)`.
 */
export function canonicalJson(payload: unknown): string {
  return JSON.stringify(payload, replacerSortKeys);
}

function replacerSortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    out[k] = (value as Record<string, unknown>)[k];
  }
  return out;
}

/** keccak256 of the canonical JSON, `0x` lowercase. */
export function hashAgentMetadata(payload: unknown): string {
  const body = canonicalJson(payload);
  return ethers.keccak256(ethers.toUtf8Bytes(body));
}

/** KV key for a single metadata record. */
export function agentMetadataKey(hash: string): string {
  return `aw:agent-md:${hash.toLowerCase()}`;
}

/** Public URL prefix — appended with the hash to form the agent's
 *  `agentURI`. */
export function agentMetadataUrl(baseOrigin: string, hash: string): string {
  return `${baseOrigin.replace(/\/$/, "")}/api/wallet/agentic/agent-metadata/${hash.toLowerCase()}`;
}

/** Validate the hex shape we accept on the reader side. Matches the
 *  output of `hashAgentMetadata`. */
export function isAgentMetadataHash(s: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(s);
}
