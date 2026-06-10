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
import { listAllPositionsStrict, yieldSupportedChains, type YieldPosition } from "@/app/lib/yield";

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
  // walletId is OPTIONAL: omit it to read your default wallet (mirrors
  // /balance and the documented MCP q402_yield_positions contract).
  const walletId = url.searchParams.get("walletId");

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

  // walletId param if supplied, default wallet otherwise (resolveWallet
  // falls back to the owner's default when walletId is null).
  const wallet = await resolveWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json(
      {
        error: "AGENTIC_WALLET_NOT_FOUND",
        message: walletId
          ? `No agentic wallet ${walletId} for this owner.`
          : "No default agentic wallet for this owner — create one (POST /api/wallet/agentic) or pass an explicit walletId.",
      },
      { status: 404 },
    );
  }
  const walletAddr = wallet.address.toLowerCase();

  const chainParam = url.searchParams.get("chain");
  const chains = chainParam ? [chainParam] : yieldSupportedChains();

  // Strict per-chain reads: a real "no position" (0 balance) reports as an
  // empty list, but an RPC read FAILURE surfaces as an unavailable chain —
  // so callers never mistake "couldn't read" for "nothing deposited".
  const results = await Promise.all(
    chains.map(async (c) => {
      try {
        return { chain: c, positions: await listAllPositionsStrict(c, walletAddr) };
      } catch (e) {
        console.error(`[yield/positions] read failed on ${c}:`, e);
        return { chain: c, positions: null as YieldPosition[] | null };
      }
    }),
  );

  const positions: YieldPosition[] = results
    .filter((r) => r.positions !== null)
    .flatMap((r) => r.positions as YieldPosition[]);
  const unavailableChains = results.filter((r) => r.positions === null).map((r) => r.chain);
  const totalUsd = positions.reduce((acc, p) => acc + Number(p.balance), 0);

  const body = {
    walletId: walletAddr,
    positions,
    totalSuppliedUsd: totalUsd,
    // Present only when at least one chain's read failed. When set, the
    // position list / total cover ONLY the chains that read cleanly —
    // treat the figures as partial, not as "no position" on the rest.
    ...(unavailableChains.length > 0 ? { unavailable: true, unavailableChains } : {}),
    asOf: new Date().toISOString(),
  };

  // If EVERY requested chain failed, the payload would otherwise look like
  // "no positions anywhere" — surface a 503 so the caller knows it's a read
  // failure, not an empty wallet.
  const allFailed = unavailableChains.length === chains.length && chains.length > 0;
  return NextResponse.json(body, { status: allFailed ? 503 : 200 });
}
