/**
 * GET /api/wallet/agentic/yield/positions?walletId=0x...&chain=bnb
 *
 * A wallet's current Q402 Yield positions (balance = principal +
 * accrued) across supported chains. Read-only, moves no funds.
 *
 * Auth mirrors the hooks-config GET (low-sensitivity read of your own
 * wallet's state):
 *   - Mode C: live apiKey in the `x-api-key` HEADER (never the query —
 *     a live key is a long-lived secret and query strings leak into
 *     access logs).
 *   - Owner-sig: the dashboard's cached SESSION signature.
 * Ownership is enforced via resolveWallet (refuses cross-owner reads).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getApiKeyRecord } from "@/app/lib/db";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import { listAllPositions, yieldSupportedChains } from "@/app/lib/yield";

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
  if (!(await rateLimit(getClientIP(req), "yield-positions", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const walletId = url.searchParams.get("walletId");
  if (!walletId) {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }

  // Auth: Mode C apiKey (header) OR cached session sig.
  let owner: string;
  const fromKey = await ownerFromApiKey(req.headers.get("x-api-key") ?? undefined);
  if (fromKey instanceof NextResponse) return fromKey;
  if (typeof fromKey === "string") {
    owner = fromKey;
  } else {
    const auth = await requireAuth(
      url.searchParams.get("address"),
      url.searchParams.get("nonce"),
      url.searchParams.get("signature"),
    );
    if (typeof auth !== "string") {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }
    owner = auth;
  }

  const wallet = await resolveWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  const walletAddr = wallet.address.toLowerCase();

  const chainParam = url.searchParams.get("chain");
  const chains = chainParam ? [chainParam] : yieldSupportedChains();

  const positions = (
    await Promise.all(chains.map((c) => listAllPositions(c, walletAddr).catch(() => [])))
  ).flat();

  const totalUsd = positions.reduce((acc, p) => acc + Number(p.balance), 0);

  return NextResponse.json({
    walletId: walletAddr,
    positions,
    totalSuppliedUsd: totalUsd,
    asOf: new Date().toISOString(),
  });
}
