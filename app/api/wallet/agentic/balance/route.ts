/**
 * GET /api/wallet/agentic/balance
 *
 * Returns the caller's Agent Wallet USDC + USDT balances across every
 * supported EVM chain. Results are cached in KV for 5 minutes so the
 * dashboard's polling loop doesn't fan out to 18 ERC20 reads per
 * refresh.
 *
 * Auth: owner EIP-191 session signature, same shape as GET /api/wallet/
 * agentic. No apiKey path — balance is read-only but the address is
 * still per-owner private.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";
import {
  fetchAgenticBalances,
  type AgenticBalances,
} from "@/app/lib/agentic-wallet-balance";

export const runtime = "nodejs";
export const maxDuration = 30;

const CACHE_TTL_SEC = 5 * 60;
const CACHE_KEY = (owner: string) => `aw:balance:${owner.toLowerCase()}`;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-balance", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const nonce = url.searchParams.get("nonce");
  const sig = url.searchParams.get("sig");
  const force = url.searchParams.get("force") === "1";

  const authResult = await requireAuth(address, nonce, sig);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // Cache hit short-circuits the heavy 9-chain read. `force=1` skips the
  // cache so the user can poke a refresh from the UI if a balance feels
  // stale.
  if (!force) {
    try {
      const cached = await kv.get<AgenticBalances>(CACHE_KEY(owner));
      if (cached && cached.asOf && Date.now() - cached.asOf < CACHE_TTL_SEC * 1000) {
        return NextResponse.json({ balances: cached, cached: true });
      }
    } catch {
      /* fall through to live read */
    }
  }

  const wallet = await getActiveAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  let balances: AgenticBalances;
  try {
    balances = await fetchAgenticBalances(wallet.address);
  } catch (e) {
    console.error("[agentic-wallet/balance] fetch failed:", e);
    return NextResponse.json({ error: "balance_fetch_failed" }, { status: 502 });
  }

  try {
    await kv.set(CACHE_KEY(owner), balances, { ex: CACHE_TTL_SEC });
  } catch {
    // Cache miss is fine — the next caller will recompute. Still surface
    // the live value.
  }

  return NextResponse.json({ balances, cached: false });
}
