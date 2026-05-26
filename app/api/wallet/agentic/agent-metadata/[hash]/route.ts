/**
 * GET /api/wallet/agentic/agent-metadata/[hash]
 *
 * Content-addressed Agent Wallet metadata server. The URL fragment is
 * the keccak256 hex of the canonical JSON body — same idea as IPFS CIDs
 * but anchored to a single domain we control. Trade-off: when q402.
 * quackai.ai goes down the metadata is unreachable, but the agent NFT
 * itself remains valid on-chain and the user can re-pin to a different
 * URI via `setAgentURI`.
 *
 * Why this exists: ERC-8004's `register(agentURI)` takes any URI scheme
 * (`ipfs://`, `https://`, `data:`, `ar://`, …). The Pinata integration
 * we had before added an external dependency that 503'd silently when
 * a `PINATA_JWT` env var was missing. Self-hosting on Q402 zeros that
 * external dep out — the only thing the registration flow needs is KV
 * (which we already require for every agentic-wallet path).
 *
 * Wire format:
 *   - KV key:   `aw:agent-md:{hash}` (lowercase, no 0x prefix)
 *   - KV value: the JSON object (Vercel KV serialises automatically)
 *   - No TTL — agent identity records are meant to persist.
 *
 * CORS: `Access-Control-Allow-Origin: *` so 8004scan + other ERC-8004
 * indexers can fetch from their own domains. The response is purely
 * public agent metadata — no secrets ever land here.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { agentMetadataKey, isAgentMetadataHash } from "@/app/lib/agent-metadata-store";

export const runtime = "nodejs";

const CACHE_HEADERS = {
  // Content-addressed: same hash always returns the same JSON. Caching is
  // safe and we want indexers / dashboards to honour it.
  "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CACHE_HEADERS });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agent-metadata-read", 120, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: CACHE_HEADERS });
  }

  const { hash: rawHash } = await params;
  // Strip a trailing `.json` extension if the caller appended one — some
  // crawlers / indexers prefer the content-type to be obvious from the
  // URL. Both forms must resolve to the same record.
  const hash = rawHash.replace(/\.json$/i, "").toLowerCase();
  if (!isAgentMetadataHash(hash)) {
    return NextResponse.json(
      { error: "INVALID_HASH", message: "Expect 0x-prefixed 32-byte hex." },
      { status: 400, headers: CACHE_HEADERS },
    );
  }

  let payload: unknown;
  try {
    payload = await kv.get(agentMetadataKey(hash));
  } catch (e) {
    console.error("[agent-metadata] kv.get failed:", e);
    return NextResponse.json({ error: "kv_unavailable" }, { status: 502, headers: CACHE_HEADERS });
  }

  if (payload === null || payload === undefined) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No agent metadata stored under this hash." },
      { status: 404, headers: CACHE_HEADERS },
    );
  }

  return NextResponse.json(payload, { status: 200, headers: CACHE_HEADERS });
}
