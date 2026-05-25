/**
 * POST /api/wallet/agentic/info-by-key
 *
 * Read-only Agent Wallet introspection authenticated by apiKey alone
 * (no EIP-191 owner sig). Trades a little visibility for a lot of MCP
 * ergonomics: an agent running headless can answer "what's in my agent
 * wallet?" without bouncing through the dashboard for a signature.
 *
 * Returns: wallet record (address, caps, deletedAt) + a balance snapshot
 * across all 9 EVM chains. The balance snapshot honors the same 5-minute
 * KV cache as GET /api/wallet/agentic/balance so heavy MCP polling stays
 * cheap.
 *
 * Trust model: the apiKey is enough auth here because (a) the read is
 * scoped to the apiKey's owner, and (b) no funds move. Sandbox keys are
 * rejected just so an MCP test-run doesn't accidentally expose the real
 * wallet's record.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getApiKeyRecord } from "@/app/lib/db";
import { getAgenticWallet } from "@/app/lib/agentic-wallet";
import {
  fetchAgenticBalances,
  type AgenticBalances,
} from "@/app/lib/agentic-wallet-balance";

export const runtime = "nodejs";
export const maxDuration = 30;

const BALANCE_CACHE_TTL_SEC = 5 * 60;
const BALANCE_CACHE_KEY = (owner: string) => `aw:balance:${owner.toLowerCase()}`;

interface InfoBody {
  apiKey?: string;
}

interface PublicWallet {
  ownerAddr: string;
  address: string;
  createdAt: number;
  deletedAt: number | null;
  dailyLimitUsd: number | null;
  perTxMaxUsd: number | null;
  erc8004AgentId: string | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-info-by-key", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: InfoBody;
  try {
    body = (await req.json()) as InfoBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.apiKey !== "string" || body.apiKey.length === 0) {
    return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 400 });
  }
  if (body.apiKey.startsWith("q402_test_")) {
    return NextResponse.json(
      { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey to read wallet info." },
      { status: 401 },
    );
  }

  const rec = await getApiKeyRecord(body.apiKey);
  if (!rec || !rec.active) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  const wallet = await getAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  const publicWallet: PublicWallet = {
    ownerAddr: wallet.ownerAddr,
    address: wallet.address,
    createdAt: wallet.createdAt,
    deletedAt: wallet.deletedAt ?? null,
    dailyLimitUsd: wallet.dailyLimitUsd ?? null,
    perTxMaxUsd: wallet.perTxMaxUsd ?? null,
    erc8004AgentId: wallet.erc8004AgentId ?? null,
  };

  // Balance: try cache, then live fetch. Cache miss is acceptable — the
  // route still returns the wallet info, just without a balance.
  let balance: AgenticBalances | null = null;
  try {
    const cached = await kv.get<AgenticBalances>(BALANCE_CACHE_KEY(owner));
    if (cached && cached.asOf && Date.now() - cached.asOf < BALANCE_CACHE_TTL_SEC * 1000) {
      balance = cached;
    }
  } catch { /* cache miss falls through to live read */ }

  if (!balance && !wallet.deletedAt) {
    try {
      balance = await fetchAgenticBalances(wallet.address);
      try {
        await kv.set(BALANCE_CACHE_KEY(owner), balance, { ex: BALANCE_CACHE_TTL_SEC });
      } catch { /* best-effort */ }
    } catch {
      balance = null;
    }
  }

  return NextResponse.json({ wallet: publicWallet, balance });
}
