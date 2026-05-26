/**
 * POST /api/wallet/agentic/register-agent
 *
 * Prepare phase of the ERC-8004 "graduate Agent Wallet to public agent
 * identity" flow. Server-side work happens here:
 *
 *   1. Auth via owner EIP-191 signature
 *   2. Build the Q402-flavoured agent metadata JSON (name, description,
 *      services[].q402 → our relay endpoint with the Agent Wallet
 *      address declared as the payment wallet)
 *   3. Pin it to IPFS via Pinata
 *   4. Encode `register(agentURI)` calldata for the user to submit
 *      through their MetaMask (the NFT mints to msg.sender, paying tiny
 *      BSC gas)
 *
 * The frontend then opens MetaMask, the user signs the register tx, and
 * the txHash is bounced back to the confirm endpoint below to finalize
 * the Agent Wallet record.
 *
 * Network: BSC mainnet only for v1. Other chains the registry is
 * deployed on (ETH, Base, Polygon, Arbitrum, Celo) come later.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";
import { pinJson, isPinnerReady } from "@/app/lib/ipfs-pin";
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
  name?: string;
  description?: string;
  imageUrl?: string;
  network?: Erc8004Network;
}

const ALLOWED_NETWORKS: Erc8004Network[] = ["bsc"]; // v1 — BSC mainnet only

function appOrigin(): string {
  return process.env.APP_ORIGIN ?? "https://q402.quackai.ai";
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

  const authResult = await requireAuth(
    body.address ?? null,
    body.nonce ?? null,
    body.signature ?? null,
  );
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // ── Validate body shape ────────────────────────────────────────────────
  const network: Erc8004Network = body.network ?? "bsc";
  if (!ALLOWED_NETWORKS.includes(network)) {
    return NextResponse.json(
      { error: "NETWORK_NOT_SUPPORTED", message: `ERC-8004 registration available on: ${ALLOWED_NETWORKS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return NextResponse.json({ error: "NAME_REQUIRED" }, { status: 400 });
  }
  if (body.name.length > 80) {
    return NextResponse.json({ error: "NAME_TOO_LONG", limit: 80 }, { status: 400 });
  }
  if (body.description && body.description.length > 500) {
    return NextResponse.json({ error: "DESCRIPTION_TOO_LONG", limit: 500 }, { status: 400 });
  }

  // ── Wallet must exist + be active ──────────────────────────────────────
  const wallet = await getActiveAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  if (!isPinnerReady()) {
    return NextResponse.json({ error: "ipfs_unavailable" }, { status: 503 });
  }

  // ── Build + pin metadata ───────────────────────────────────────────────
  const metadata = buildQ402AgentMetadata({
    name: body.name.trim(),
    description: body.description?.trim(),
    walletAddress: wallet.address,
    relayBaseUrl: appOrigin(),
    mcpPackage: "@quackai/q402-mcp",
    imageUrl: body.imageUrl,
  });

  const pinned = await pinJson(metadata);
  if (!pinned.ok) {
    console.error("[register-agent] pin failed:", pinned.reason);
    return NextResponse.json({ error: "pin_failed" }, { status: 502 });
  }

  // ── Encode calldata for the user's MetaMask ────────────────────────────
  const cfg = ERC8004_NETWORKS[network];
  const calldata = encodeRegister(pinned.uri);

  return NextResponse.json({
    network,
    registry: cfg.registry,
    chainId: cfg.chainId,
    agentURI: pinned.uri,
    calldata,
    metadata,
    // The frontend opens MetaMask with `{ to: registry, data: calldata, value: 0 }`
    // and the connected wallet signs + sends.
  });
}
