/**
 * GET /api/wallet/agentic/[walletId]/recurring/[ruleId]/fires
 *
 * Per-rule fire history. Reads the LIST written by the recurring cron's
 * `recordRuleFireLog` call, newest first. Capped at 50 entries server-side
 * (the LTRIM cap on write); the client may request fewer via `?limit=`.
 *
 * Read-only — session sig only, no intent challenge. The fire log is
 * tightly scoped: ownership of the rule (and the wallet that owns it) is
 * confirmed against `requireAuth`'s recovered address before we serve the
 * list, so a stale path can't enumerate someone else's history.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getActiveAgenticWallet } from "@/app/lib/agentic-wallet";
import {
  getRecurringRule,
  listRuleFires,
} from "@/app/lib/agentic-wallet-recurring";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ walletId: string; ruleId: string }>;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-recurring-fires", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { walletId, ruleId } = await ctx.params;
  if (!isHexAddress(walletId) || typeof ruleId !== "string" || ruleId.length === 0) {
    return NextResponse.json({ error: "INVALID_PARAMS" }, { status: 400 });
  }

  const authResult = await requireAuth(
    req.nextUrl.searchParams.get("address"),
    req.nextUrl.searchParams.get("nonce"),
    req.nextUrl.searchParams.get("sig"),
  );
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  // Wallet must exist + be active. We refuse to serve fire history for
  // archived/soft-deleted wallets so a stale dashboard tab on an
  // archived wallet doesn't surface "look, we still fired yesterday"
  // when the user expects the wallet to be paused.
  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }

  // Rule must exist + belong to the wallet. Mismatch is treated as
  // not-found so we don't leak rule-ID existence to a probing caller.
  const rule = await getRecurringRule(owner, walletId, ruleId);
  if (!rule) {
    return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
  }
  if (rule.ownerAddr !== owner.toLowerCase() || rule.walletId !== walletId.toLowerCase()) {
    return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limitRaw = limitParam ? Number(limitParam) : 50;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : 50;

  const fires = await listRuleFires(owner, walletId, ruleId, limit);
  return NextResponse.json({ fires });
}
