import { NextRequest, NextResponse } from "next/server";
import { rotateApiKey, type RotateScope } from "@/app/lib/db";
import { requireFreshAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/keys/rotate
 *
 * Deactivates the current live API key in the requested scope and issues
 * a new one. Requires a fresh one-time challenge (GET /api/auth/challenge)
 * — not the session nonce. The challenge is consumed on first use and
 * cannot be replayed.
 *
 * Body: { address, challenge, signature, scope?: "paid" | "trial" }
 *   - scope defaults to "paid" so existing clients keep working.
 *   - "trial" rotates sub.trialApiKey (or the pre-Phase-1 sub.apiKey
 *     when the sub still holds the trial key in the paid slot).
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "rotate", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: {
    address?: string;
    challenge?: string;
    signature?: string;
    scope?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const authResult = await requireFreshAuth(body.address, body.challenge, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  // Accept "paid" / "trial" / undefined. Unknown values fall back to
  // "paid" so a malformed client never silently rotates the wrong slot.
  const scope: RotateScope = body.scope === "trial" ? "trial" : "paid";

  try {
    const newKey = await rotateApiKey(addr, scope);
    return NextResponse.json({ apiKey: newKey, scope });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Rotation failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
