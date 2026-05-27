/**
 * POST /api/wallet/agentic/register-agent/confirm
 *
 * Confirm phase of ERC-8004 agent registration. Reads the receipt,
 * parses the Registered event, persists agentId on the wallet record.
 *
 * Multi-wallet Phase 3: takes walletId.
 *
 * Audit fixes:
 *   - P1 #1 (auth+crypto): intent-bound `agentic.register.confirm`
 *     with txHash + walletId in the canonical message. Stops session-
 *     sig replay across confirm operations.
 *   - P1 #2 (auth+crypto): SET NX claim on `aw:register-tx:{net}:{tx}`
 *     so the same txHash can't be re-parsed and overwrite the wallet's
 *     agentId. A second confirm call with the same txHash returns the
 *     cached result.
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { kv } from "@vercel/kv";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getAppOrigin } from "@/app/lib/app-origin";
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

const REGISTER_TX_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

interface ConfirmBody {
  address?: string;
  nonce?: string;
  signature?: string;
  walletId?: string;
  txHash?: string;
  network?: Erc8004Network;
}

interface RegisterTxRecord {
  agentId: string;
  owner: string;
  agentURI: string;
  walletId: string;
  network: Erc8004Network;
  confirmedAt: number;
}

const ALLOWED_NETWORKS: Erc8004Network[] = ["bsc"];

function isTxHash(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function registerTxKey(network: string, txHash: string): string {
  return `aw:register-tx:${network}:${txHash.toLowerCase()}`;
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

  if (!isTxHash(body.txHash)) {
    return NextResponse.json({ error: "INVALID_TX_HASH" }, { status: 400 });
  }
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }
  const network: Erc8004Network = body.network ?? "bsc";
  if (!ALLOWED_NETWORKS.includes(network)) {
    return NextResponse.json({ error: "NETWORK_NOT_SUPPORTED" }, { status: 400 });
  }

  // ── Intent-bound auth — binds owner + walletId + txHash + network ─────
  const authResult = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.register.confirm",
    intent: {
      walletId: body.walletId.toLowerCase(),
      txHash: body.txHash.toLowerCase(),
      network,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // ── Idempotency: SET NX claim on the txHash ───────────────────────────
  // If a previous confirm already parsed this txHash, return the cached
  // result — no re-parse, no agentId overwrite (audit P1 #2).
  const txKey = registerTxKey(network, body.txHash);
  const cached = await kv.get<RegisterTxRecord>(txKey);
  if (cached) {
    return NextResponse.json({
      network: cached.network,
      agentId: cached.agentId,
      owner: cached.owner,
      agentURI: cached.agentURI,
      walletId: cached.walletId,
      scanUrl: scanUrl(cached.network, cached.agentId),
      idempotent: true,
    });
  }

  const wallet = await getActiveAgenticWallet(owner, body.walletId);
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

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: body.txHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|could not be found/i.test(msg)) {
      return NextResponse.json(
        { error: "TX_PENDING", message: "Transaction not yet confirmed — retry in a few seconds." },
        { status: 425 },
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

  if (parsed.owner.toLowerCase() !== owner.toLowerCase()) {
    return NextResponse.json(
      {
        error: "OWNER_MISMATCH",
        message: "The agent was minted to a different address than your dashboard session.",
        mintOwner: parsed.owner,
        agentId: parsed.agentId.toString(),
      },
      { status: 403 },
    );
  }

  // ── walletId ↔ agentURI cross-check ───────────────────────────────────
  // The same owner may have multiple Agent Wallets (max 10). An owner
  // could mint NFT-X against wallet A's metadata, then call confirm
  // with walletId=B + the same txHash, attaching X's agentId to B's
  // record — B would then advertise A's payment endpoint to anyone
  // resolving the public agent. Block by fetching the on-chain
  // agentURI's metadata and verifying its q402 service walletAddress
  // matches the wallet whose record we're about to stamp.
  //
  // Posture is asymmetric by URI kind:
  //
  //   - Self-hosted URIs (our own `${APP_ORIGIN}/api/wallet/agentic/
  //     agent-metadata/{hash}`): we control the route, the metadata
  //     is content-addressed in our KV. A fetch failure here is a
  //     real signal (KV down, hash typo, replay against a stale
  //     hash) — fail closed.
  //   - Third-party URIs: user could have minted with metadata they
  //     host themselves (ipfs://, an arbitrary https). Fetch failure
  //     is plausibly transient — keep the old non-fatal behaviour.
  const appOriginPrefix = `${getAppOrigin(req).replace(/\/$/, "")}/api/wallet/agentic/agent-metadata/`;
  const isSelfHosted = parsed.agentURI.startsWith(appOriginPrefix);

  let metadataWalletAddr: string | null = null;
  let metadataFetchOk = false;
  let metadataServiceFound = false;
  try {
    const metaRes = await fetch(parsed.agentURI, { method: "GET" });
    if (metaRes.ok) {
      metadataFetchOk = true;
      const meta = (await metaRes.json()) as {
        services?: Array<{ name?: string; walletAddress?: string }>;
      };
      const q402Svc = meta.services?.find((s) => s?.name === "q402");
      if (q402Svc) metadataServiceFound = true;
      metadataWalletAddr =
        typeof q402Svc?.walletAddress === "string" ? q402Svc.walletAddress.toLowerCase() : null;
    }
  } catch (e) {
    console.error("[register-agent/confirm] metadata fetch for cross-check failed:", e);
  }

  // Fail closed for self-hosted URIs that can't be validated. A
  // self-hosted URI we can't reach OR that lacks a q402 service
  // entry means we cannot prove the agent points at THIS walletId —
  // safer to reject than to stamp a possibly-mismatched agentId.
  if (isSelfHosted && (!metadataFetchOk || !metadataServiceFound)) {
    return NextResponse.json(
      {
        error: "SELF_HOSTED_METADATA_UNVERIFIABLE",
        message:
          "Could not verify the self-hosted agent metadata that the NFT points at. " +
          (!metadataFetchOk
            ? "The metadata URL did not return 200."
            : "The metadata does not contain a q402 service entry to cross-check against the walletId."),
        agentURI: parsed.agentURI,
        agentId: parsed.agentId.toString(),
      },
      { status: 502 },
    );
  }

  if (metadataWalletAddr !== null && metadataWalletAddr !== body.walletId.toLowerCase()) {
    return NextResponse.json(
      {
        error: "WALLET_AGENTURI_MISMATCH",
        message:
          "The on-chain agentURI's q402 service points at a different wallet than the walletId " +
          "you're confirming against. This usually means the NFT was minted with metadata for " +
          "one of your other wallets — confirm with that wallet's walletId instead.",
        metadataWalletAddress: metadataWalletAddr,
        walletId: body.walletId.toLowerCase(),
        agentId: parsed.agentId.toString(),
      },
      { status: 409 },
    );
  }

  // Atomically claim the txHash so a concurrent retry can't re-parse +
  // overwrite. The race window is small (we already authed + fetched
  // receipt) but a SET NX is cheap insurance.
  const record: RegisterTxRecord = {
    agentId: parsed.agentId.toString(),
    owner: parsed.owner,
    agentURI: parsed.agentURI,
    walletId: body.walletId.toLowerCase(),
    network,
    confirmedAt: Date.now(),
  };
  const claimed = await kv.set(txKey, record, { nx: true, ex: REGISTER_TX_TTL_SEC });
  if (!claimed) {
    // Concurrent confirm raced us — return whichever record landed.
    const live = await kv.get<RegisterTxRecord>(txKey);
    if (live) {
      return NextResponse.json({
        network: live.network,
        agentId: live.agentId,
        owner: live.owner,
        agentURI: live.agentURI,
        walletId: live.walletId,
        scanUrl: scanUrl(live.network, live.agentId),
        idempotent: true,
      });
    }
    return NextResponse.json({ error: "confirm_claim_failed" }, { status: 500 });
  }

  await setErc8004AgentId(owner, body.walletId, network, parsed.agentId);

  return NextResponse.json({
    network,
    agentId: parsed.agentId.toString(),
    owner: parsed.owner,
    agentURI: parsed.agentURI,
    walletId: body.walletId.toLowerCase(),
    scanUrl: scanUrl(network, parsed.agentId),
  });
}
