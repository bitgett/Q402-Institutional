/**
 * GET /api/wallet/agentic/balance
 *
 * Returns a specific Agent Wallet's USDC + USDT balances across every
 * supported EVM chain. Cached per-wallet in KV for 5 minutes.
 *
 * Multi-wallet Phase 3: takes a `walletId` query param. Omitting it
 * resolves to the owner's default wallet so existing single-wallet
 * dashboards keep working without code changes.
 *
 * Auth: owner EIP-191 session signature. No apiKey path (info-by-key
 * is the apiKey route).
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet, resolveWallet } from "@/app/lib/agentic-wallet";
import {
  fetchAgenticBalances,
  type AgenticBalances,
} from "@/app/lib/agentic-wallet-balance";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_SEC = 5 * 60;
const CACHE_KEY = (owner: string, walletId: string) =>
  `aw:balance:${owner.toLowerCase()}:${walletId.toLowerCase()}`;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-balance", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const nonce = url.searchParams.get("nonce");
  const sig = url.searchParams.get("sig");
  const walletIdParam = url.searchParams.get("walletId");
  const force = url.searchParams.get("force") === "1";

  const authResult = await requireAuth(address, nonce, sig);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // Resolve to a specific wallet — walletId param if supplied, default
  // wallet otherwise. Active-only (soft-deleted = treated as gone).
  const wallet = walletIdParam
    ? await getActiveAgenticWallet(owner, walletIdParam)
    : await resolveWallet(owner, null);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  const walletId = wallet.address.toLowerCase();

  if (!force) {
    try {
      const cached = await kv.get<AgenticBalances>(CACHE_KEY(owner, walletId));
      if (cached && cached.asOf && Date.now() - cached.asOf < CACHE_TTL_SEC * 1000) {
        return NextResponse.json({ balances: cached, cached: true, walletId });
      }
    } catch {
      /* fall through to live read */
    }
  }

  let balances: AgenticBalances;
  try {
    balances = await fetchAgenticBalances(wallet.address);
  } catch (e) {
    console.error("[agentic-wallet/balance] fetch failed:", e);
    return NextResponse.json({ error: "balance_fetch_failed" }, { status: 502 });
  }

  try {
    await kv.set(CACHE_KEY(owner, walletId), balances, { ex: CACHE_TTL_SEC });
  } catch {
    /* cache miss is non-fatal */
  }

  return NextResponse.json({ balances, cached: false, walletId });
}
