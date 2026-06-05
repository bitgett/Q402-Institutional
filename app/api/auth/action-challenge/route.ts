/**
 * POST /api/auth/action-challenge
 *
 * Issues a one-time, action-bound challenge for the calling owner.
 *
 * The dashboard hits this BEFORE every fund-moving / destructive
 * Agent Wallet call (send / batch / export / archive). The client
 * receives `{ challenge, message }` — the *canonical* message text
 * server-side reconstruction will compare against — and asks the
 * connected wallet to sign that exact string. The signed
 * `{ challenge, signature }` then gets bundled with the action's
 * intent fields and sent to the action route.
 *
 * Why server-rebuilt messages: if the client picked the canonical
 * bytes the signature would no longer pin the intent — a client could
 * sign "send 1 USDT" and submit "send 100 USDT" with the same
 * signature against a different rebuilt string. By having the server
 * own message construction (and the action route rebuilds the same
 * bytes from server-trusted intent), the signature is provably
 * specific to the exact action + intent the caller asked us to mint
 * the challenge for.
 *
 * Rate-limited per IP. Stale challenges expire after CHALLENGE_TTL_SEC
 * and are also blocked by the consumed-marker single-use atomic claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { createFreshChallenge, buildIntentMessage } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

export const runtime = "nodejs";

interface Body {
  address?: string;
  action?: string;
  /**
   * Intent fields, all primitives (numbers + strings). Keys are
   * sorted server-side before serialisation so client field order
   * doesn't affect the canonical message.
   */
  intent?: Record<string, string | number>;
}

const ALLOWED_ACTIONS = new Set([
  "agentic.send",
  "agentic.batch",
  "agentic.export",
  "agentic.archive",
  "agentic.register",
  "agentic.register.confirm",
  "agentic.limits",
  "agentic.restore",
  "agentic.recurring.create",
  "agentic.recurring.update",
  "agentic.recurring.cancel",
  // CCIP USDC bridge — intent is { walletId, src, dst, amount, feeToken }.
  // /api/ccip/send rebuilds the canonical message from these fields and
  // verifies the signature there. Without this whitelist entry the
  // challenge endpoint refuses to mint, BridgeModal's getActionAuth
  // returns null, and the user sees "Sign the bridge challenge…" with
  // no wallet popup.
  "ccip.bridge",
  // Agent Wallet EIP-7702 delegation clear — intent is { walletId, chain }.
  // Lets the bridge modal recover when the Agent Wallet is delegated to
  // an impl with no receive(), without forcing the user out to a
  // separate UI / MCP tool. Server holds the Agent Wallet PK so the user
  // never sees the type-4 tx details; this challenge just authorises the
  // server to act on their behalf.
  "agentic.clear_delegation",
]);

function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isIntentShape(v: unknown): v is Record<string, string | number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 64) return false;
    if (typeof val !== "string" && typeof val !== "number") return false;
    if (typeof val === "string" && val.length > 200) return false;
  }
  return true;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "auth-action-challenge", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isAddress(body.address)) {
    return NextResponse.json({ error: "address must be a 0x-prefixed 20-byte address" }, { status: 400 });
  }
  if (!body.action || !ALLOWED_ACTIONS.has(body.action)) {
    return NextResponse.json(
      {
        error: "unsupported action",
        message: `Allowed actions: ${[...ALLOWED_ACTIONS].join(", ")}.`,
      },
      { status: 400 },
    );
  }
  if (!isIntentShape(body.intent)) {
    return NextResponse.json(
      {
        error: "intent must be an object of string|number values (≤200 chars per value, ≤64 chars per key)",
      },
      { status: 400 },
    );
  }

  const { challenge, ttlSec } = await createFreshChallenge(body.address);
  const message = buildIntentMessage(body.address, body.action, body.intent, challenge);
  return NextResponse.json({
    challenge,
    message,
    expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
  });
}
