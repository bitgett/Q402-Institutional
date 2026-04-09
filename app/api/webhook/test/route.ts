import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getWebhookConfig } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { createHmac } from "crypto";

const PROVISION_MSG = (addr: string) =>
  `Q402 API Key Request\nAddress: ${addr.toLowerCase()}`;

/**
 * POST /api/webhook/test
 * Fires a test event to the registered webhook URL.
 * Body: { address, signature }
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-test", 5, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; signature?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { address, signature } = body;
  if (!address || !signature) {
    return NextResponse.json({ error: "address and signature required" }, { status: 400 });
  }

  try {
    const recovered = ethers.verifyMessage(PROVISION_MSG(address.toLowerCase()), signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const config = await getWebhookConfig(address.toLowerCase());
  if (!config?.active) {
    return NextResponse.json({ error: "No webhook configured" }, { status: 404 });
  }

  // SSRF guard — paranoia check even though URL was validated on save
  try {
    const parsed = new URL(config.url);
    const host = parsed.hostname.toLowerCase();
    if (/^(localhost|127\.|0\.0\.0\.0|::1$|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(host)) {
      return NextResponse.json({ error: "Webhook URL is not a public endpoint" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid stored webhook URL" }, { status: 400 });
  }

  const payload = {
    event: "relay.test",
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    chain: "avax",
    from: address,
    to: "0x000000000000000000000000000000000000dEaD",
    amount: 1.0,
    token: "USDC",
    timestamp: new Date().toISOString(),
  };

  const body_str = JSON.stringify(payload);
  const hmac = createHmac("sha256", config.secret).update(body_str).digest("hex");

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Q402-Signature": `sha256=${hmac}`,
        "X-Q402-Event": "relay.test",
      },
      body: body_str,
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json({ success: true, statusCode: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request failed";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
