/**
 * POST /api/wallet/agentic/export
 *
 * Reveals a specific Agent Wallet's private key once. Multi-wallet
 * Phase 3: the caller must specify walletId; the intent message embeds
 * it so a signature scoped to wallet A cannot reveal wallet B's key.
 *
 * Hard requirements (one bypassed = the key never leaves the server):
 *   1. A FRESH intent-bound challenge (action=agentic.export). The
 *      canonical message is rebuilt server-side from the walletId — a
 *      session sig has no path here.
 *   2. The caller's lowercased address must own the walletId.
 *   3. The wallet must not be soft-deleted. Archived wallets cannot
 *      export; restore first.
 *   4. Every successful export MUST land in the per-wallet audit log
 *      BEFORE the key bytes leave the server. recordExportEvent
 *      rethrows on KV failure; we catch and 503 the response so the
 *      key is never revealed without an audit row persisting. A user
 *      retrying once KV recovers gets a clean export.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import {
  getAgenticWallet,
  decryptPrivateKey,
  isKeystoreReady,
  recordExportEvent,
} from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

interface ExportBody {
  ownerAddress?: string;
  walletId?: string;
  challenge?: string;
  signature?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-export", 5, 300))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: ExportBody;
  try {
    body = (await req.json()) as ExportBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }

  const authResult = await requireIntentAuth({
    address: body.ownerAddress ?? null,
    challenge: body.challenge ?? null,
    signature: body.signature ?? null,
    action: "agentic.export",
    intent: {
      walletId: body.walletId.toLowerCase(),
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;

  const ready = isKeystoreReady();
  if (!ready.ok) {
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  const wallet = await getAgenticWallet(owner, body.walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  if (wallet.deletedAt) {
    return NextResponse.json(
      { error: "WALLET_ARCHIVED", message: "Restore the wallet before exporting." },
      { status: 409 },
    );
  }

  let pk: string;
  try {
    pk = decryptPrivateKey(wallet);
  } catch (e) {
    console.error("[agentic-wallet/export] decrypt failed:", e);
    return NextResponse.json({ error: "decrypt_failed" }, { status: 500 });
  }

  // Audit log MUST land before we hand the key to the client.
  // recordExportEvent rethrows on KV failure; refuse the export with
  // 503 so the operation is atomic (audit row landed ⇔ key revealed).
  // A KV outage temporarily blocks exports — acceptable cost for the
  // invariant "no key reveal without an audit row".
  try {
    await recordExportEvent(owner, body.walletId, { ip });
  } catch (e) {
    console.error("[agentic-wallet/export] audit log failed — refusing export:", e);
    void sendOpsAlert(
      `Agentic Wallet EXPORT refused (fail-closed) for owner ${owner} ` +
        `(walletId ${body.walletId}, ip ${ip}). Audit log write failed; ` +
        `key was NOT revealed. Investigate KV health, then retry the export.`,
      "critical",
    );
    return NextResponse.json(
      {
        error: "AUDIT_LOG_UNAVAILABLE",
        message:
          "Could not persist the export audit row. The key was not revealed. " +
          "Please retry in a few seconds; if the failure persists, contact ops.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      address: wallet.address,
      walletId: wallet.address.toLowerCase(),
      privateKey: pk,
      exportedAt: Date.now(),
      warning:
        "This key is shown once. Save it to a hardware wallet or password manager. " +
        "Anyone with this key can spend any USDC/USDT in the wallet.",
    },
    { status: 200 },
  );
}
