/**
 * POST /api/wallet/agentic/register-agent
 *
 * Prepare phase of ERC-8004 agent registration. Multi-wallet Phase 3:
 * the caller picks a specific walletId; that wallet's address is the
 * payment endpoint declared in the agent metadata.
 *
 * Intent-bound auth (`agentic.register`): embeds walletId + name +
 * network in the canonical message so a leaked session sig can't
 * publish a public agent identity. Every fund-moving or identity-
 * publishing action takes a fresh challenge.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";
import {
  agentMetadataKey,
  agentMetadataUrl,
  canonicalJson,
  hashAgentMetadata,
} from "@/app/lib/agent-metadata-store";
import {
  ERC8004_NETWORKS,
  buildQ402AgentMetadata,
  encodeRegister,
  type Erc8004Network,
} from "@/app/lib/erc8004";
import { getAppOrigin } from "@/app/lib/app-origin";

export const runtime = "nodejs";
export const maxDuration = 30;

interface PrepareBody {
  address?: string;
  nonce?: string;
  signature?: string;
  walletId?: string;
  name?: string;
  description?: string;
  imageUrl?: string;
  network?: Erc8004Network;
  /**
   * Client-computed keccak256 of the canonical metadata JSON. Bound
   * into the intent challenge so a malicious or buggy client can't
   * sign with `name="legit"` and then mutate `description`/`imageUrl`
   * in the body — the rebuild here MUST hash to the same value or
   * the request is rejected.
   *
   * Compute on the client with `hashAgentMetadata(buildQ402AgentMetadata(
   *   { name, description, imageUrl, walletAddress, relayBaseUrl, mcpPackage }))`.
   * The `relayBaseUrl` must match `window.location.origin` (matches
   * the server's `getAppOrigin(req)` whenever APP_ORIGIN env is unset
   * — on prod the env is set, and the client sees the canonical URL,
   * so they converge).
   */
  metadataHash?: string;
}

const ALLOWED_NETWORKS: Erc8004Network[] = ["bsc"];
const MAX_IMAGE_URL = 300;

function isMetadataHash(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-register-agent", 6, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: PrepareBody;
  try {
    body = (await req.json()) as PrepareBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Body validation (BEFORE auth so the intent message we rebuild
  //    against the same constraints is provably the one the user signed) ──
  const network: Erc8004Network = body.network ?? "bsc";
  if (!ALLOWED_NETWORKS.includes(network)) {
    return NextResponse.json(
      { error: "NETWORK_NOT_SUPPORTED", message: `Available on: ${ALLOWED_NETWORKS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "NAME_REQUIRED" }, { status: 400 });
  }
  const name = body.name.trim();
  if (name.length > 80) {
    return NextResponse.json({ error: "NAME_TOO_LONG", limit: 80 }, { status: 400 });
  }
  const description = body.description?.trim() ?? "";
  if (description.length > 500) {
    return NextResponse.json({ error: "DESCRIPTION_TOO_LONG", limit: 500 }, { status: 400 });
  }
  // Image URL validation — content lands in a publicly-served metadata
  // document with CORS *, so we reject anything that isn't https://.
  let imageUrl: string | undefined;
  if (typeof body.imageUrl === "string" && body.imageUrl.length > 0) {
    if (body.imageUrl.length > MAX_IMAGE_URL) {
      return NextResponse.json({ error: "IMAGE_URL_TOO_LONG", limit: MAX_IMAGE_URL }, { status: 400 });
    }
    if (!isHttpsUrl(body.imageUrl)) {
      return NextResponse.json({ error: "IMAGE_URL_MUST_BE_HTTPS" }, { status: 400 });
    }
    imageUrl = body.imageUrl;
  }
  if (!isMetadataHash(body.metadataHash)) {
    return NextResponse.json(
      { error: "METADATA_HASH_REQUIRED", message: "Client must compute + send keccak256 of canonical metadata JSON for intent binding." },
      { status: 400 },
    );
  }
  const claimedMetadataHash = body.metadataHash.toLowerCase();

  // ── Intent-bound auth ─────────────────────────────────────────────────
  // Intent embeds the FULL metadata hash (not just name+network+wallet)
  // so description / imageUrl tampering after signing fails verification.
  // The hash is rebuilt below from the request body using the same
  // canonical JSON convention the client used; mismatch → reject.
  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.register",
    intent: {
      walletId: body.walletId.toLowerCase(),
      network,
      metadataHash: claimedMetadataHash,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // ── Wallet must exist + be active ──────────────────────────────────────
  const wallet = await getActiveAgenticWallet(owner, body.walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  // ── Build + self-host metadata ─────────────────────────────────────────
  // `getAppOrigin(req)` honours APP_ORIGIN env if set (prod), else
  // derives from request host. This keeps preview deploys self-
  // consistent: the agentURI we hand the user points at the SAME deploy
  // they signed against, not at a canonical URL that lacks the metadata.
  // The client must use `window.location.origin` for its own hash
  // computation so the two converge.
  const appOrigin = getAppOrigin(req);
  const metadata = buildQ402AgentMetadata({
    name,
    description: description.length > 0 ? description : undefined,
    walletAddress: wallet.address,
    relayBaseUrl: appOrigin,
    mcpPackage: "@quackai/q402-mcp",
    imageUrl,
  });

  const hash = hashAgentMetadata(metadata);
  if (hash.toLowerCase() !== claimedMetadataHash) {
    // Body fields differ from what the client signed. Either a malicious
    // client trying to publish metadata that differs from the signed
    // intent, OR a client/server canonical-JSON drift bug.
    return NextResponse.json(
      {
        error: "METADATA_HASH_MISMATCH",
        message: "The server-rebuilt metadata does not hash to the client-signed value. Body fields must be byte-identical to what was signed.",
        expected: claimedMetadataHash,
        computed: hash.toLowerCase(),
      },
      { status: 400 },
    );
  }
  try {
    await kv.set(agentMetadataKey(hash), metadata);
  } catch (e) {
    console.error("[register-agent] kv.set metadata failed:", e);
    return NextResponse.json({ error: "metadata_store_failed" }, { status: 502 });
  }

  const agentURI = agentMetadataUrl(appOrigin, hash);

  const cfg = ERC8004_NETWORKS[network];
  const calldata = encodeRegister(agentURI);

  return NextResponse.json({
    network,
    registry: cfg.registry,
    chainId: cfg.chainId,
    agentURI,
    metadataHash: hash,
    canonicalBytes: canonicalJson(metadata).length,
    calldata,
    metadata,
  });
}
