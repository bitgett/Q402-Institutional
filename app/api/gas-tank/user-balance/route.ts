import { NextRequest, NextResponse } from "next/server";
import { getGasBalance, getGasDeposits, getApiKeyRecord } from "@/app/lib/db";

export async function GET(req: NextRequest) {
  const apiKey = req.nextUrl.searchParams.get("apiKey");
  if (!apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 401 });

  const record = await getApiKeyRecord(apiKey);
  if (!record || !record.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  const address = record.address;
  const balances = await getGasBalance(address);
  const deposits = await getGasDeposits(address);

  return NextResponse.json({ balances, deposits });
}
