import { NextRequest, NextResponse } from "next/server";
import { getRelayedTxs, getApiKeyRecord } from "@/app/lib/db";

export async function GET(req: NextRequest) {
  const apiKey = req.nextUrl.searchParams.get("apiKey");
  if (!apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 401 });

  const record = await getApiKeyRecord(apiKey);
  if (!record || !record.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  const lookupAddress = record.address;
  const txs = await getRelayedTxs(lookupAddress);

  // Count this month's usage
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthTxs = txs.filter(tx => new Date(tx.relayedAt) >= monthStart);

  return NextResponse.json({
    txs,
    thisMonthCount: thisMonthTxs.length,
    totalCount: txs.length,
  });
}
