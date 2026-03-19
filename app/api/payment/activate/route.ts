import { NextRequest, NextResponse } from "next/server";
import { checkPaymentOnChain, planFromAmount } from "@/app/lib/blockchain";
import { getSubscription, setSubscription, generateApiKey, deactivateApiKey } from "@/app/lib/db";

export async function POST(req: NextRequest) {
  const { address } = await req.json();
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  // Already activated and not expired?
  const existing = await getSubscription(address);
  if (existing) {
    const expiresAt = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    if (new Date() < expiresAt) {
      // Return status only — no apiKey exposed
      return NextResponse.json({ status: "already_active", plan: existing.plan });
    }
  }

  // Verify on-chain payment
  const result = await checkPaymentOnChain(address);
  if (!result.found) {
    return NextResponse.json({ error: "No payment found on-chain" }, { status: 402 });
  }

  const plan = planFromAmount(result.amountUSD ?? 0);
  if (!plan) {
    return NextResponse.json({ error: "Payment amount too low" }, { status: 402 });
  }

  // Revoke old key before issuing new one
  if (existing?.apiKey) await deactivateApiKey(existing.apiKey);
  const apiKey = await generateApiKey(address, plan);
  await setSubscription(address, {
    paidAt: new Date().toISOString(),
    apiKey,
    plan,
    txHash: result.txHash!,
    amountUSD: result.amountUSD!,
  });

  // Return status only — apiKey is only available via /api/keys/provision
  return NextResponse.json({ status: "activated", plan });
}
