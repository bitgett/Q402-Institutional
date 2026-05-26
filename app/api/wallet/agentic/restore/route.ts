/**
 * POST /api/wallet/agentic/restore
 *
 * Clear the soft-delete marker on a specific Agent Wallet, returning it
 * to the active set. Multi-wallet Phase 3: takes walletId, intent-bound.
 *
 * Auth: intent-bound `agentic.restore` action. Restore isn't destructive
 * — it brings a record BACK — but binding it to the walletId still
 * pays off: it pins which wallet is being restored so a leaked session
 * signature can't surface a previously-archived wallet the user didn't
 * intend to revive.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { restoreAgenticWallet } from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

interface RestoreBody {
  address?: string;
  walletId?: string;
  nonce?: string;
  signature?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-restore", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: RestoreBody;
  try {
    body = (await req.json()) as RestoreBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }

  const result = await requireIntentAuth({
    address: body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action: "agentic.restore",
    intent: { walletId: body.walletId.toLowerCase() },
  });
  if (typeof result !== "string") {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.status },
    );
  }
  const owner = result;

  try {
    await restoreAgenticWallet(owner, body.walletId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENTIC_WALLET_GRACE_EXPIRED") {
      return NextResponse.json(
        {
          error: "GRACE_EXPIRED",
          message: "The 7-day restore window has passed. Create a new Agent Wallet instead.",
        },
        { status: 410 },
      );
    }
    console.error("[agentic-wallet/restore] failed:", e);
    return NextResponse.json({ error: "restore_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
