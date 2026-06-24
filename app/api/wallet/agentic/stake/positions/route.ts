/**
 * GET /api/wallet/agentic/stake/positions
 *
 * Read-only: the Agent Wallet's Q staking positions on the live QuackAiStake
 * contract (BNB), plus the wallet's liquid Q balance (the stake "max" ceiling).
 * Drives the Stake modal's "your positions" list, the unstake Max amount, and
 * the MCP q402_stake_positions tool + its "max" preview.
 *
 * Auth mirrors /yield/positions (low-sensitivity read of your own wallet):
 *   - Mode C: live apiKey in the `x-api-key` HEADER (never the query — a live
 *     key is a long-lived secret and query strings leak into access logs).
 *   - Owner-sig: the dashboard's cached SESSION signature (address+nonce+sig).
 * Ownership is enforced via resolveWallet (refuses cross-owner reads).
 */
import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { requireAuth } from "@/app/lib/auth";
import { getApiKeyRecord } from "@/app/lib/db";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import { readStakePositions } from "@/app/lib/staking/positions";
import { Q_TOKEN } from "@/app/lib/staking/sign";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

export const runtime = "nodejs";

async function ownerFromApiKey(apiKey: string | undefined): Promise<string | NextResponse | null> {
  if (!apiKey || apiKey.length === 0) return null;
  if (apiKey.startsWith("q402_test_") || apiKey.startsWith("q402_sandbox_") || !apiKey.startsWith("q402_live_")) {
    return NextResponse.json({ error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey." }, { status: 401 });
  }
  const rec = await getApiKeyRecord(apiKey);
  if (!rec || !rec.active || rec.isSandbox) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  return rec.address.toLowerCase();
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-stake-positions", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const walletId = req.nextUrl.searchParams.get("walletId");

  // Auth: Mode C apiKey (header) OR cached session sig.
  let owner: string;
  const fromKey = await ownerFromApiKey(req.headers.get("x-api-key") ?? undefined);
  if (fromKey instanceof NextResponse) return fromKey;
  if (typeof fromKey === "string") {
    owner = fromKey;
  } else {
    const authResult = await requireAuth(
      req.nextUrl.searchParams.get("address"),
      req.nextUrl.searchParams.get("nonce"),
      req.nextUrl.searchParams.get("sig"),
    );
    if (typeof authResult !== "string") {
      return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
    }
    owner = authResult;
  }

  const wallet = await resolveWallet(owner, walletId && walletId.length > 0 ? walletId.toLowerCase() : null);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  try {
    const result = await readStakePositions(wallet.address);
    // Liquid Q balance — the stake "max" ceiling. Best-effort: a balance read
    // failure shouldn't blank the (more important) positions list.
    let qBalance = "0";
    let qBalanceRaw = "0";
    try {
      const provider = new ethers.JsonRpcProvider(AGENTIC_CHAINS.bnb.rpc, undefined, { batchMaxCount: 1 });
      const q = new ethers.Contract(Q_TOKEN, ["function balanceOf(address) view returns (uint256)"], provider);
      const raw = (await q.balanceOf(wallet.address)) as bigint;
      qBalanceRaw = raw.toString();
      qBalance = ethers.formatUnits(raw, 18);
    } catch {
      /* leave qBalance at 0 — positions are the primary payload */
    }
    return NextResponse.json({ ...result, walletId: wallet.address.toLowerCase(), qBalance, qBalanceRaw });
  } catch (e) {
    return NextResponse.json({ error: "positions_read_failed", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
