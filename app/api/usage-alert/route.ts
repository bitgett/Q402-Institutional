import { NextRequest, NextResponse } from "next/server";
import {
  getUsageAlert,
  setUsageAlert,
  clearUsageAlert,
} from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * /api/usage-alert — wallet-scoped email alerting for TX-credit burn-down.
 *
 * Prior behaviour stored the alert email in the browser's localStorage only:
 * toggled on the UI, dispatched no email, never crossed the network. Users
 * therefore saw an "alerts on" control that did nothing.
 *
 * This endpoint persists the opt-in server-side (Vercel KV), lets the cron
 * (`/api/cron/usage-alert`) enumerate subscribers via an index Set, and keeps
 * the authorization symmetric with /api/webhook and /api/gas-tank/user-balance
 * — same nonce-based EIP-191 proof so an anonymous caller cannot read or
 * clobber another wallet's email.
 *
 * GET    ?address&nonce&sig         → { email, createdAt, lastThresholdAlerted } | { configured: false }
 * POST   { address, nonce, signature, email }   → { ok: true }
 * DELETE { address, nonce, signature }          → { ok: true }
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "usage-alert-get", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce   = req.nextUrl.searchParams.get("nonce");
  const sig     = req.nextUrl.searchParams.get("sig");

  const authResult = await requireAuth(address, nonce, sig);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const cfg = await getUsageAlert(addr);
  if (!cfg) return NextResponse.json({ configured: false });
  return NextResponse.json({
    configured:            true,
    email:                 cfg.email,
    createdAt:             cfg.createdAt,
    lastThresholdAlerted:  cfg.lastThresholdAlerted,
  });
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "usage-alert-post", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; nonce?: string; signature?: string; email?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const email = (body.email ?? "").trim();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json(
      { error: "email must be a valid address (max 254 chars)" },
      { status: 400 },
    );
  }

  const authResult = await requireAuth(body.address, body.nonce, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const cfg = await setUsageAlert(addr, email);
  return NextResponse.json({ ok: true, email: cfg.email });
}

export async function DELETE(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "usage-alert-delete", 5, 60))) {
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

  await clearUsageAlert(addr);
  return NextResponse.json({ ok: true });
}
