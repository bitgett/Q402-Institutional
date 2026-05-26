/**
 * POST /api/wallet/agentic/register-agent
 *
 * Prepare phase of ERC-8004 agent registration. Multi-wallet Phase 3:
 * the caller picks a specific walletId; that wallet's address is the
 * payment endpoint declared in the agent metadata.
 *
 * Audit fix (P1 #1 — auth+crypto): now intent-bound (`agentic.register`).
 * Embeds walletId + name + network in the canonical message so a leaked
 * session sig can't publish a public agent identity. Previously a
 * session signature was enough — sufficient if the user signs that
 * session, but the canonical model is "every fund-moving or identity-
 * publishing action takes a fresh challenge".
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
}

const ALLOWED_NETWORKS: Erc8004Network[] = ["bsc"];
const MAX_IMAGE_URL = 300;

function appOrigin(): string {
  return process.env.APP_ORIGIN ?? "https://q402.quackai.ai";
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:";
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

  // ── Intent-bound auth ─────────────────────────────────────────────────
  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.register",
    intent: {
      walletId: body.walletId.toLowerCase(),
      network,
      name,
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
  const metadata = buildQ402AgentMetadata({
    name,
    description: description.length > 0 ? description : undefined,
    walletAddress: wallet.address,
    relayBaseUrl: appOrigin(),
    mcpPackage: "@quackai/q402-mcp",
    imageUrl,
  });

  const hash = hashAgentMetadata(metadata);
  try {
    await kv.set(agentMetadataKey(hash), metadata);
  } catch (e) {
    console.error("[register-agent] kv.set metadata failed:", e);
    return NextResponse.json({ error: "metadata_store_failed" }, { status: 502 });
  }

  const agentURI = agentMetadataUrl(appOrigin(), hash);

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
