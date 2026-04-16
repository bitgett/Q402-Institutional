import { NextRequest, NextResponse } from "next/server";
import { getWebhookConfig } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { validateWebhookUrl } from "@/app/lib/webhook-validator";
import { createHmac } from "crypto";

/**
 * POST /api/webhook/test
 * Fires a test event to the registered webhook URL.
 * Body: { address, nonce, signature }
 *   nonce obtained from GET /api/auth/nonce?address={addr}
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "webhook-test", 5, 60))) {
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

  const config = await getWebhookConfig(addr);
  if (!config?.active) {
    return NextResponse.json({ error: "No webhook configured" }, { status: 404 });
  }

  // Re-validate stored URL — legacy rows may predate the current SSRF rules.
  const urlErr = validateWebhookUrl(config.url);
  if (urlErr) {
    return NextResponse.json(urlErr, { status: 400 });
  }

  const payload = {
    event: "relay.test",
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    chain: "avax",
    from: addr,
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
