import { NextRequest, NextResponse } from "next/server";
import { checkPaymentOnChain, planFromAmount } from "@/app/lib/blockchain";
import { getSubscription, setSubscription, generateApiKey } from "@/app/lib/db";

export async function POST(req: NextRequest) {
  const { address } = await req.json();
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  // Already activated? Skip only if not expired (within 30 days)
  const existing = await getSubscription(address);
  if (existing) {
    const expiresAt = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    if (new Date() < expiresAt) {
      return NextResponse.json({ status: "already_active", apiKey: existing.apiKey });
    }
    // Expired — fall through to allow renewal with new on-chain payment
  }

  // Verify on-chain
  const result = await checkPaymentOnChain(address);
  if (!result.found) {
    return NextResponse.json({ error: "No payment found on-chain" }, { status: 402 });
  }

  const plan = planFromAmount(result.amountUSD ?? 0);
  if (!plan) {
    return NextResponse.json({ error: "Payment amount too low" }, { status: 402 });
  }

  // Issue API key and save
  const apiKey = await generateApiKey(address, plan);
  await setSubscription(address, {
    paidAt: new Date().toISOString(),
    apiKey,
    plan,
    txHash: result.txHash!,
    amountUSD: result.amountUSD!,
  });

  return NextResponse.json({ status: "activated", apiKey, plan });
}
