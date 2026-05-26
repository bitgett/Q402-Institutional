/**
 * agentic-wallet-agent-metadata.test.ts
 *
 * Behavioural coverage for the content-addressed Agent Wallet metadata
 * surface. Two routes interact:
 *
 *   - WRITER  POST /api/wallet/agentic/register-agent
 *       Hashes the canonical JSON, stores it in KV, and returns the
 *       self-hosted `agentURI` URL.
 *
 *   - READER  GET  /api/wallet/agentic/agent-metadata/[hash]
 *       Looks up the stored JSON, returns it with public CORS +
 *       long-cache headers.
 *
 * Together they replace the prior Pinata pinning flow, so we keep
 * three invariants under guard: (a) the writer's URL prefix matches
 * the reader's path, (b) the hash format the writer emits is exactly
 * the format the reader accepts, (c) the reader is CORS-enabled +
 * content-typed JSON.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  agentMetadataKey,
  agentMetadataUrl,
  canonicalJson,
  hashAgentMetadata,
  isAgentMetadataHash,
} from "@/app/lib/agent-metadata-store";

describe("agent-metadata-store lib", () => {
  it("produces the same hash for the same payload (idempotent retry)", () => {
    const payload = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "test",
      services: [{ name: "q402", endpoint: "https://example.test/api/relay/info" }],
    };
    expect(hashAgentMetadata(payload)).toBe(hashAgentMetadata(payload));
  });

  it("produces different hashes for different payloads", () => {
    const a = hashAgentMetadata({ name: "a" });
    const b = hashAgentMetadata({ name: "b" });
    expect(a).not.toBe(b);
  });

  it("emits 0x-prefixed 64-hex (keccak256 shape)", () => {
    const h = hashAgentMetadata({ name: "x" });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(isAgentMetadataHash(h)).toBe(true);
  });

  it("isAgentMetadataHash rejects malformed input", () => {
    expect(isAgentMetadataHash("0xnothex")).toBe(false);
    expect(isAgentMetadataHash("0x" + "f".repeat(63))).toBe(false); // too short
    expect(isAgentMetadataHash("0x" + "F".repeat(64))).toBe(false); // uppercase rejected
    expect(isAgentMetadataHash("noprefix" + "0".repeat(64))).toBe(false);
  });

  it("agentMetadataKey lowercases the hash so writer/reader cannot drift", () => {
    const upper = "0x" + "A".repeat(64);
    const lower = "0x" + "a".repeat(64);
    expect(agentMetadataKey(upper)).toBe(agentMetadataKey(lower));
  });

  it("agentMetadataUrl strips trailing slash from origin and embeds the hash", () => {
    const url = agentMetadataUrl("https://q402.test/", "0xabc");
    expect(url).toBe("https://q402.test/api/wallet/agentic/agent-metadata/0xabc");
  });

  it("canonicalJson is JSON.stringify with no whitespace + recursively sorted keys", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    // Same logical object, reversed input order — must hash the same.
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashAgentMetadata({ b: 2, a: 1 })).toBe(hashAgentMetadata({ a: 1, b: 2 }));
  });

  it("sorts nested object keys recursively", () => {
    const left = { outer: { z: 1, a: 2 }, top: "x" };
    const right = { top: "x", outer: { a: 2, z: 1 } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("leaves array element order untouched (arrays are positional)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("GET /api/wallet/agentic/agent-metadata/[hash] — route shape", () => {
  const readerSrc = readFileSync(
    resolve(
      __dirname,
      "..",
      "app",
      "api",
      "wallet",
      "agentic",
      "agent-metadata",
      "[hash]",
      "route.ts",
    ),
    "utf8",
  );

  it("rate-limits per IP (defence in depth — indexers can poll)", () => {
    expect(readerSrc).toMatch(/rateLimit\(ip,\s*"agent-metadata-read"/);
  });

  it("rejects malformed hashes with INVALID_HASH 400", () => {
    expect(readerSrc).toMatch(/INVALID_HASH/);
    expect(readerSrc).toMatch(/isAgentMetadataHash/);
  });

  it("returns 404 NOT_FOUND when no record stored under that hash", () => {
    expect(readerSrc).toMatch(/NOT_FOUND/);
    expect(readerSrc).toMatch(/No agent metadata stored/);
  });

  it("ships CORS headers so 8004scan + other indexers can fetch cross-origin", () => {
    expect(readerSrc).toMatch(/Access-Control-Allow-Origin.*\*/);
    expect(readerSrc).toMatch(/export async function OPTIONS/);
  });

  it("ships a long immutable cache header for content-addressed payloads", () => {
    expect(readerSrc).toMatch(/max-age=86400/);
    expect(readerSrc).toMatch(/immutable/);
  });

  it("tolerates a trailing .json suffix so URL aesthetics don't break resolution", () => {
    expect(readerSrc).toMatch(/replace\(\/\\\.json\$\/i, ""\)/);
  });
});

describe("POST /api/wallet/agentic/register-agent — writes self-hosted metadata", () => {
  const writerSrc = readFileSync(
    resolve(__dirname, "..", "app", "api", "wallet", "agentic", "register-agent", "route.ts"),
    "utf8",
  );

  it("imports the content-addressed store helpers, not the old Pinata module", () => {
    expect(writerSrc).toMatch(/from "@\/app\/lib\/agent-metadata-store"/);
    expect(writerSrc).not.toMatch(/ipfs-pin/);
    expect(writerSrc).not.toMatch(/pinJson/);
  });

  it("hashes the metadata, writes to KV at agentMetadataKey, and builds an https agentURI", () => {
    expect(writerSrc).toMatch(/hashAgentMetadata\(metadata\)/);
    expect(writerSrc).toMatch(/agentMetadataKey\(hash\)/);
    expect(writerSrc).toMatch(/agentMetadataUrl\(appOrigin\(\),\s*hash\)/);
  });

  it("returns metadataHash + canonicalBytes in the response so the UI can verify content", () => {
    expect(writerSrc).toMatch(/metadataHash:\s*hash/);
    expect(writerSrc).toMatch(/canonicalBytes:/);
  });

  it("encodes register(agentURI) using the self-hosted URL", () => {
    const encodeIdx = writerSrc.search(/encodeRegister\(agentURI\)/);
    const uriIdx = writerSrc.search(/const\s+agentURI\s*=\s*agentMetadataUrl/);
    expect(encodeIdx).toBeGreaterThanOrEqual(0);
    expect(uriIdx).toBeGreaterThanOrEqual(0);
    expect(encodeIdx).toBeGreaterThan(uriIdx);
  });

  it("no longer surfaces a 503 ipfs_unavailable response", () => {
    expect(writerSrc).not.toMatch(/ipfs_unavailable/);
    expect(writerSrc).not.toMatch(/PINATA/);
  });
});
