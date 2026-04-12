import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  getWebhookConfig,
  setWebhookConfig,
  deleteWebhookConfig,
} from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const PROVISION_MSG = (addr: string) =>
  `Q402 API Key Request\nAddress: ${addr.toLowerCase()}`;

function verifySignature(addr: string, signature: string): boolean {
  try {
    const recovered = ethers.verifyMessage(PROVISION_MSG(addr), signature);
    return recovered.toLowerCase() === addr.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * GET /api/webhook?address=0x...&sig=0x...
 * Returns current webhook config (URL only, not secret).
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-get", 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const sig     = req.nextUrl.searchParams.get("sig");
  if (!address || !sig) return NextResponse.json({ error: "address and sig required" }, { status: 400 });
  if (!verifySignature(address, sig)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const config = await getWebhookConfig(address.toLowerCase());
  if (!config) return NextResponse.json({ configured: false });

  return NextResponse.json({
    configured: true,
    url: config.url,
    active: config.active,
    createdAt: config.createdAt,
    // secret intentionally omitted
  });
}

/**
 * POST /api/webhook
 * Register or update webhook URL.
 * Body: { address, signature, url }
 * Returns the signing secret (shown ONCE — store it).
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-post", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; signature?: string; url?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { address, signature, url } = body;
  if (!address || !signature || !url) {
    return NextResponse.json({ error: "address, signature, and url required" }, { status: 400 });
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

  if (!verifySignature(address, signature)) {
    return NextResponse.json({ error: "Signature does not match address" }, { status: 401 });
  }

  const { randomBytes } = await import("crypto");
  // Reuse existing secret if re-registering — keeps client's stored secret valid
  const existing = await getWebhookConfig(address.toLowerCase());
  const secret = existing?.secret ?? randomBytes(32).toString("hex");

  await setWebhookConfig(address.toLowerCase(), {
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
 * Body: { address, signature }
 */
export async function DELETE(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-delete", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; signature?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { address, signature } = body;
  if (!address || !signature) {
    return NextResponse.json({ error: "address and signature required" }, { status: 400 });
  }
  if (!verifySignature(address, signature)) {
    return NextResponse.json({ error: "Signature does not match address" }, { status: 401 });
  }

  await deleteWebhookConfig(address.toLowerCase());
  return NextResponse.json({ success: true });
}
