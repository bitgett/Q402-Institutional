import { NextRequest, NextResponse } from "next/server";
import { checkPaymentOnChain, planFromAmount } from "@/app/lib/blockchain";
import { getSubscription } from "@/app/lib/db";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  // Already activated?
  const existing = await getSubscription(address);
  if (existing) {
    const expiresAt = new Date(new Date(existing.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    const isExpired = new Date() >= expiresAt;
    return NextResponse.json({
      status: isExpired ? "expired" : "already_paid",
      subscription: existing,
      expiresAt: expiresAt.toISOString(),
      isExpired,
    });
  }

  // Check on-chain
  const result = await checkPaymentOnChain(address);
  if (!result.found) {
    return NextResponse.json({ status: "not_found" });
  }

  const plan = planFromAmount(result.amountUSD ?? 0);
  if (!plan) {
    return NextResponse.json({
      status: "amount_too_low",
      amountUSD: result.amountUSD,
      message: "Minimum $29 USDC/USDT required for Starter plan",
    });
  }

  return NextResponse.json({
    status: "payment_found",
    txHash: result.txHash,
    amountUSD: result.amountUSD,
    token: result.token,
    chain: result.chain,
    plan,
  });
}
