import { NextRequest, NextResponse } from "next/server";
import { checkPaymentOnChain, planFromAmount } from "@/app/lib/blockchain";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" });

  const result = await checkPaymentOnChain(address);
  const plan = result.found ? planFromAmount(result.amountUSD ?? 0) : null;

  return NextResponse.json({
    TEST_MODE: process.env.TEST_MODE,
    TEST_MODE_type: typeof process.env.TEST_MODE,
    result,
    plan,
  });
}
