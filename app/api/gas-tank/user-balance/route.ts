import { NextRequest, NextResponse } from "next/server";
import { getGasBalance, getGasDeposits } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "user-balance", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const balances = await getGasBalance(address.toLowerCase());
  const deposits = await getGasDeposits(address.toLowerCase());

  return NextResponse.json({ balances, deposits });
}
