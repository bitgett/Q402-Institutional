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
import {
  REQUIRED_AGENT_NAME,
  REQUIRED_DESC_PREFIX,
  MAX_TAGLINE,
  brandIconUrl,
  validateDescription,
} from "@/app/lib/agent-brand";
import { originFromRequest } from "@/app/lib/agent-origin";

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
   * sign with one set of fields and submit another — the rebuild here
   * MUST hash to the same value or the request is rejected.
   *
   * Compute on the client with `hashAgentMetadata(buildQ402AgentMetadata(
   *   { name, description, imageUrl, walletAddress, relayBaseUrl, mcpPackage }))`.
   * Convergence: client uses `window.location.origin` for relayBaseUrl
   * + imageUrl; server uses `originFromRequest(req)` (deliberately host-
   *  derived, NOT env-derived) so both always see the same string.
   */
  metadataHash?: string;
}

const ALLOWED_NETWORKS: Erc8004Network[] = ["bsc"];

function isMetadataHash(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
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
  // Brand lock — name must be the exact Q402 fleet identity, identical
  // for every user, so every Q402 agent reads as part of one fleet on
  // 8004scan instead of a one-off vanity mint.
  if (name !== REQUIRED_AGENT_NAME) {
    return NextResponse.json(
      {
        error: "NAME_NOT_ALLOWED",
        message: `Agent name must be exactly "${REQUIRED_AGENT_NAME}".`,
        required: REQUIRED_AGENT_NAME,
      },
      { status: 400 },
    );
  }
  const description = body.description?.trim() ?? "";
  const descErr = validateDescription(description);
  if (descErr === "DESCRIPTION_PREFIX_REQUIRED") {
    return NextResponse.json(
      {
        error: descErr,
        message: `Description must start with "${REQUIRED_DESC_PREFIX}". A one-line tagline may follow, separated by a single space.`,
        required: REQUIRED_DESC_PREFIX,
      },
      { status: 400 },
    );
  }
  if (descErr === "TAGLINE_LENGTH") {
    return NextResponse.json(
      { error: descErr, message: `Tagline must be 1..${MAX_TAGLINE} chars.`, limit: MAX_TAGLINE },
      { status: 400 },
    );
  }

  // imageUrl is also brand-locked: if the body carries one it must be
  // exactly the canonical icon for THIS deploy (`${appOrigin}/icon.svg`).
  // The full origin check happens after `appOrigin` is derived below; we
  // record the raw value here so the hash-rebuild path sees the same
  // string the client signed against.
  const submittedImageUrl: string | undefined =
    typeof body.imageUrl === "string" && body.imageUrl.length > 0 ? body.imageUrl : undefined;
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
  // Origin is derived from the request host (NOT APP_ORIGIN env) so the
  // client's `window.location.origin` always converges with whatever
  // string we hash + bake into the agentURI. See `originFromRequest`
  // for the rationale (preview deploys + env divergence).
  const appOrigin = originFromRequest(req);
  const expectedIconUrl = brandIconUrl(appOrigin);
  if (submittedImageUrl !== undefined && submittedImageUrl !== expectedIconUrl) {
    return NextResponse.json(
      {
        error: "IMAGE_URL_NOT_ALLOWED",
        message:
          "imageUrl must be the canonical Q402 brand icon for this deploy. " +
          "Either omit it, or send exactly the deploy's /icon.svg URL.",
        required: expectedIconUrl,
      },
      { status: 400 },
    );
  }
  const metadata = buildQ402AgentMetadata({
    name,
    description,
    walletAddress: wallet.address,
    relayBaseUrl: appOrigin,
    mcpPackage: "@quackai/q402-mcp",
    imageUrl: submittedImageUrl,
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
