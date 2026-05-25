/**
 * POST /api/wallet/agentic/restore
 *
 * Clear the soft-delete marker on the caller's Agent Wallet, returning
 * it to the active set. Closes the loop on the 7-day grace promise —
 * archive can be undone here until the grace window expires (or the
 * hard-delete cron sweeps the record, whichever comes first).
 *
 * Auth: owner EIP-191 session signature (same as other CRUD methods).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { restoreAgenticWallet } from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

interface RestoreBody {
  address?: string;
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

  const result = await requireAuth(
    body.address ?? null,
    body.nonce ?? null,
    body.signature ?? null,
  );
  if (typeof result !== "string") {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.status },
    );
  }
  const owner = result;

  try {
    await restoreAgenticWallet(owner);
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
