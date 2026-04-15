import { NextRequest, NextResponse } from "next/server";
import { rotateApiKey } from "@/app/lib/db";
import { requireAuth, invalidateNonce } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/keys/rotate
 *
 * Deactivates the current live API key and issues a new one.
 * Requires nonce-based EIP-191 proof-of-ownership to prevent address spoofing.
 * Nonce is invalidated after rotation, forcing re-sign on the next sensitive action.
 *
 * Body: { address, nonce, signature }
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "rotate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; nonce?: string; signature?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const authResult = await requireAuth(body.address, body.nonce, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  try {
    const newKey = await rotateApiKey(addr);
    // Invalidate nonce after key rotation — forces re-sign on next sensitive action
    await invalidateNonce(addr);
    return NextResponse.json({ apiKey: newKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Rotation failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
