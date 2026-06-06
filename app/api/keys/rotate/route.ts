import { NextRequest, NextResponse } from "next/server";
import { rotateApiKey, type RotateScope } from "@/app/lib/db";
import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/keys/rotate
 *
 * Deactivates the current live API key in the requested scope and issues
 * a new one. Requires an INTENT-BOUND one-time signature
 * (`action = "keys.rotate"`, intent = { scope }) — not a generic fresh
 * challenge. Without intent binding, a signature collected for any other
 * action (wallet bind, email link, trial activation, …) on the same
 * generic challenge could be REPLAYED on this endpoint to mint a fresh
 * API key for the attacker, granting full programmatic spend access
 * within seconds of capture. Audit FIX 2026-06-07.
 *
 * Body: { address, nonce, signature, scope?: "paid" | "trial" }
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
    nonce?: string;
    signature?: string;
    scope?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  // Accept "paid" / "trial" / undefined. Unknown values fall back to
  // "paid" so a malformed client never silently rotates the wrong slot.
  const scope: RotateScope = body.scope === "trial" ? "trial" : "paid";

  // Validate the intent-bound signature. The scope MUST be part of the
  // intent so a trial-scope signature can't be replayed to rotate the
  // paid key. Field name on the wire is `nonce` (matches other
  // intent-bound routes); legacy `challenge` accepted as fallback so
  // mid-rotation clients aren't suddenly broken.
  const authResult = await requireIntentAuth({
    address:   body.address ?? null,
    challenge: body.nonce ?? body.challenge ?? null,
    signature: body.signature ?? null,
    action:    "keys.rotate",
    intent:    { scope },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  try {
    const newKey = await rotateApiKey(addr, scope);
    return NextResponse.json({ apiKey: newKey, scope });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Rotation failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
