import { NextRequest, NextResponse } from "next/server";
import {
  getWebhookConfig,
  setWebhookConfig,
  deleteWebhookConfig,
  getWebhookDeliveries,
} from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * GET /api/webhook?address=0x...&nonce=xxx&sig=0x...
 * Returns current webhook config (URL only, not secret).
 * nonce obtained from GET /api/auth/nonce?address={addr}
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-get", 20, 60))) {
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

  const config = await getWebhookConfig(addr);
  if (!config) return NextResponse.json({ configured: false });

  const deliveries = await getWebhookDeliveries(addr);
  return NextResponse.json({
    configured:   true,
    url:          config.url,
    active:       config.active,
    createdAt:    config.createdAt,
    lastDelivery: deliveries[0] ?? null,
    // secret intentionally omitted
  });
}

/**
 * POST /api/webhook
 * Register or update webhook URL.
 * Body: { address, nonce, signature, url }
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 * Returns the signing secret (shown ONCE — store it).
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-post", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; nonce?: string; signature?: string; url?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { url } = body;
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  // URL validation — block SSRF (private IPs, loopback, cloud metadata, IPv6 internals)
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("protocol");
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    const blocked =
      // IPv4 loopback / link-local / RFC-1918
      /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host) ||
      // IPv6 loopback and link-local
      /^(::1$|::ffff:|fe80:|fc00:|fd[0-9a-f]{2}:)/i.test(host) ||
      // Cloud metadata endpoints (GCP, AWS, Azure)
      /^(metadata\.google\.internal|169\.254\.169\.254|fd00:ec2::254)/.test(host) ||
      // Octal/hex encoded IPs (e.g. 0177.0.0.1)
      /^0[0-7]+\./.test(host);
    if (blocked) throw new Error("private");
    // Require HTTPS in production
    if (parsed.protocol === "http:" && process.env.NODE_ENV === "production") throw new Error("https_required");
  } catch (e) {
    const msg = e instanceof Error
      ? (e.message === "private" ? "Webhook URL must be a public endpoint"
        : e.message === "https_required" ? "Webhook URL must use HTTPS in production"
        : "Invalid webhook URL")
      : "Invalid webhook URL";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const authResult = await requireAuth(body.address, body.nonce, body.signature);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const { randomBytes } = await import("crypto");
  // Reuse existing secret if re-registering — keeps client's stored secret valid
  const existing = await getWebhookConfig(addr);
  const secret = existing?.secret ?? randomBytes(32).toString("hex");

  await setWebhookConfig(addr, {
    url,
    secret,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    active: true,
  });

  return NextResponse.json({
    success: true,
    url,
    // Return secret only on first registration (no existing config)
    secret: existing ? undefined : secret,
    note: existing
      ? "Webhook updated. Use your existing signing secret."
      : "Save this secret — it will not be shown again. Use it to verify X-Q402-Signature headers.",
  });
}

/**
 * DELETE /api/webhook
 * Remove webhook config.
 * Body: { address, nonce, signature }
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 */
export async function DELETE(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-delete", 5, 60))) {
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

  await deleteWebhookConfig(addr);
  return NextResponse.json({ success: true });
}
