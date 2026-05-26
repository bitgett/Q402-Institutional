/**
 * POST /api/wallet/agentic/register-agent/confirm
 *
 * Confirm phase of the ERC-8004 agent registration flow. After the user
 * signs and submits the `register(agentURI)` transaction through their
 * wallet, the frontend bounces the resulting `txHash` here so the
 * server can:
 *
 *   1. Read the receipt
 *   2. Parse the `Registered(agentId, agentURI, owner)` event
 *   3. Verify the registry address matches the network we expected
 *   4. Persist `{network}:{agentId}` on the Agent Wallet record
 *
 * Returns the assigned `agentId` + an `8004scan.io` URL the dashboard
 * card uses to render the "Agent #N" badge.
 *
 * Replay-safe: the txHash is the unique identity. We don't dedupe in
 * KV because re-running the parse for the same hash is idempotent — it
 * just rewrites the same agentId tag onto the wallet record.
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getActiveAgenticWallet,
  setErc8004AgentId,
} from "@/app/lib/agentic-wallet";
import {
  ERC8004_NETWORKS,
  parseRegisteredEvent,
  scanUrl,
  type Erc8004Network,
} from "@/app/lib/erc8004";

export const runtime = "nodejs";
export const maxDuration = 30;

interface ConfirmBody {
  address?: string;
  nonce?: string;
  signature?: string;
  txHash?: string;
  network?: Erc8004Network;
}

const ALLOWED_NETWORKS: Erc8004Network[] = ["bsc"];

function isTxHash(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-register-agent-confirm", 12, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
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

  if (!isTxHash(body.txHash)) {
    return NextResponse.json({ error: "INVALID_TX_HASH" }, { status: 400 });
  }
  const network: Erc8004Network = body.network ?? "bsc";
  if (!ALLOWED_NETWORKS.includes(network)) {
    return NextResponse.json({ error: "NETWORK_NOT_SUPPORTED" }, { status: 400 });
  }

  const wallet = await getActiveAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  const cfg = ERC8004_NETWORKS[network];
  const client = createPublicClient({
    chain: {
      id: cfg.chainId,
      name: cfg.name,
      nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpc] } },
    },
    transport: http(cfg.rpc),
  });

  // The receipt may still be pending if the user just submitted. We try
  // once and surface a clear "still pending" code so the frontend can
  // poll instead of blowing up.
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: body.txHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|could not be found/i.test(msg)) {
      return NextResponse.json(
        { error: "TX_PENDING", message: "Transaction not yet confirmed — retry in a few seconds." },
        { status: 425 }, // 425 Too Early
      );
    }
    console.error("[register-agent/confirm] receipt fetch failed:", e);
    return NextResponse.json({ error: "receipt_fetch_failed" }, { status: 502 });
  }

  if (receipt.status !== "success") {
    return NextResponse.json(
      { error: "TX_REVERTED", message: "The register transaction reverted on-chain." },
      { status: 400 },
    );
  }

  const parsed = parseRegisteredEvent(receipt.logs, cfg.registry);
  if (!parsed) {
    return NextResponse.json(
      {
        error: "REGISTERED_EVENT_NOT_FOUND",
        message:
          "Couldn't find the Registered event in this receipt. " +
          "Verify the txHash points to a successful register() call on the IdentityRegistry.",
      },
      { status: 400 },
    );
  }

  // The NFT owner is whoever submitted the tx. We don't *require* it to
  // match the Agent Wallet owner EOA — the user may have minted from
  // a different address and we still want to record the linkage. But
  // we DO require the owner to be the caller's owner-sig address, to
  // prevent random callers attaching someone else's agent id.
  if (parsed.owner.toLowerCase() !== owner.toLowerCase()) {
    return NextResponse.json(
      {
        error: "OWNER_MISMATCH",
        message: "The agent was minted to a different address than your dashboard session.",
        mintOwner: parsed.owner,
      },
      { status: 403 },
    );
  }

  await setErc8004AgentId(owner, network, parsed.agentId);

  return NextResponse.json({
    network,
    agentId: parsed.agentId.toString(),
    owner: parsed.owner,
    agentURI: parsed.agentURI,
    scanUrl: scanUrl(network, parsed.agentId),
  });
}
