import { NextRequest, NextResponse } from "next/server";
import { getSubscription, setSubscription, generateApiKey } from "@/app/lib/db";

/**
 * POST /api/keys/provision
 *
 * Auto-provision an API key for a wallet address.
 * - If the address already has a key, returns it.
 * - If not, creates a free "starter" key.
 *
 * Paywall has been removed; all connected wallets can get a key.
 */
export async function POST(req: NextRequest) {
  const { address } = await req.json();
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const addr = address.toLowerCase();

  // Return existing key if present
  const existing = await getSubscription(addr);
  if (existing?.apiKey) {
    return NextResponse.json({ apiKey: existing.apiKey, plan: existing.plan, isNew: false });
  }

  // Auto-provision free starter key
  const apiKey = await generateApiKey(addr, "starter");
  await setSubscription(addr, {
    paidAt: new Date().toISOString(),
    apiKey,
    plan: "starter",
    txHash: "provisioned",
    amountUSD: 0,
  });

  return NextResponse.json({ apiKey, plan: "starter", isNew: true });
}
