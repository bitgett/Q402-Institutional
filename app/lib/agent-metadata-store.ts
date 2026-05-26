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

/** Stable string serialisation used as the hashing input. Object key
 *  ordering matters — `JSON.stringify` follows insertion order by spec,
 *  and the metadata builder constructs the fields deterministically, so
 *  the hash is reproducible for a given content shape. */
export function canonicalJson(payload: unknown): string {
  return JSON.stringify(payload);
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
