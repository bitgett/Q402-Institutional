import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getSubscription, setSubscription, generateApiKey, generateSandboxKey } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

/**
 * POST /api/keys/provision
 *
 * Returns or creates an API key for the caller's wallet address.
 * Requires a personal_sign proof-of-ownership signature to prevent
 * address spoofing — without this, any caller could retrieve any user's key.
 *
 * Body: { address: string, signature: string }
 *   signature = personal_sign("Q402 API Key Request\nAddress: {addr}", address)
 *
 * The client caches the signature in sessionStorage so the user is only
 * prompted to sign once per browser session.
 */

// Deterministic message — no nonce needed; proves address ownership at request time.
const PROVISION_MSG = (addr: string) =>
  `Q402 API Key Request\nAddress: ${addr.toLowerCase()}`;

export async function POST(req: NextRequest) {
  // ── Rate limit: 10 requests / 60 s per IP ────────────────────────────────
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "provision", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { address?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { address, signature } = body;
  if (!address || !signature) {
    return NextResponse.json({ error: "address and signature required" }, { status: 400 });
  }

  const addr = address.toLowerCase();

  // ── Verify wallet ownership via EIP-191 personal_sign ────────────────────
  try {
    const recovered = ethers.verifyMessage(PROVISION_MSG(addr), signature);
    if (recovered.toLowerCase() !== addr) {
      return NextResponse.json({ error: "Signature does not match address" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── Return existing keys if present ──────────────────────────────────────
  const existing = await getSubscription(addr);
  if (existing?.apiKey) {
    // Ensure sandbox key exists (may be missing for older accounts)
    if (!existing.sandboxApiKey) {
      const sandboxApiKey = await generateSandboxKey(addr, existing.plan);
      await setSubscription(addr, { ...existing, sandboxApiKey });
      return NextResponse.json({
        apiKey: existing.apiKey,
        sandboxApiKey,
        plan: existing.plan,
        hasPaid: (existing.amountUSD ?? 0) > 0,
        isNew: false,
      });
    }
    return NextResponse.json({
      apiKey: existing.apiKey,
      sandboxApiKey: existing.sandboxApiKey,
      plan: existing.plan,
      hasPaid: (existing.amountUSD ?? 0) > 0,
      isNew: false,
    });
  }

  // ── Auto-provision free starter key + sandbox key ─────────────────────────
  const apiKey       = await generateApiKey(addr, "starter");
  const sandboxApiKey = await generateSandboxKey(addr, "starter");
  await setSubscription(addr, {
    paidAt:     new Date().toISOString(),
    apiKey,
    sandboxApiKey,
    plan:       "starter",
    txHash:     "provisioned",
    amountUSD:  0,
  });

  return NextResponse.json({ apiKey, sandboxApiKey, plan: "starter", hasPaid: false, isNew: true });
}
