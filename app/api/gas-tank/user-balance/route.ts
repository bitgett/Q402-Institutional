import { NextRequest, NextResponse } from "next/server";
import { getGasBalance, getGasDeposits } from "@/app/lib/db";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const balances = await getGasBalance(address);
  const deposits = await getGasDeposits(address);

  return NextResponse.json({ balances, deposits });
}
