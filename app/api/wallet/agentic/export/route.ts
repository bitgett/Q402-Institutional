/**
 * POST /api/wallet/agentic/export
 *
 * Reveals the caller's Agent Wallet private key once. Designed to back
 * the "custodial + export" promise: at any point the user can pull the
 * key out of Q402's keystore and continue self-custody from MetaMask /
 * a hardware wallet.
 *
 * Hard requirements (one bypassed = the key never leaves the server):
 *   1. A FRESH one-time challenge — not a session nonce. Issued via
 *      GET /api/auth/challenge; consumed atomically by requireFreshAuth.
 *      A leaked session nonce can't be turned into an export.
 *   2. The caller's lowercased address must match the agentic wallet's
 *      ownerAddr — verified after challenge consumption.
 *   3. The wallet must not be soft-deleted. Archived wallets cannot
 *      export; restore first.
 *   4. Every successful export is appended to the per-owner audit log
 *      (timestamp + IP). The log is capped to the most recent 50 events.
 *
 * Response surface: the decrypted private key returns ONCE in the JSON
 * body. The client UI is expected to clear it from memory after the
 * user copies it. We never persist plaintext anywhere else.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getAgenticWallet,
  decryptPrivateKey,
  isKeystoreReady,
  recordExportEvent,
} from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

interface ExportBody {
  ownerAddress?: string;
  challenge?: string;
  signature?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Throttle hard — export is the most sensitive surface in the
  // agentic-wallet feature.
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

  // requireFreshAuth verifies + atomically consumes the one-time
  // challenge so the same signature can't be replayed.
  const authResult = await requireFreshAuth(
    body.ownerAddress ?? null,
    body.challenge ?? null,
    body.signature ?? null,
  );
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

  const wallet = await getAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  // Archived wallets cannot export — restore the wallet first so the
  // export action shows up against a non-deleted record in the audit
  // log.
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

  // Audit log — best-effort but should normally land. The export
  // already succeeded by the time this runs; a KV outage here logs to
  // server stderr instead of failing the call.
  await recordExportEvent(owner, { ip }).catch((e) => {
    console.error("[agentic-wallet/export] audit log failed:", e);
  });

  return NextResponse.json(
    {
      address: wallet.address,
      privateKey: pk,
      exportedAt: Date.now(),
      warning:
        "This key is shown once. Save it to a hardware wallet or password manager. " +
        "Anyone with this key can spend any USDC/USDT in the wallet.",
    },
    { status: 200 },
  );
}
