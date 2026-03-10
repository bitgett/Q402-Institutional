import { NextRequest, NextResponse } from "next/server";
import { getRelayedTxs, getApiKeyRecord } from "@/app/lib/db";

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  // Also accept lookup by apiKey
  const apiKey = req.nextUrl.searchParams.get("apiKey");
  let lookupAddress = address;
  if (apiKey) {
    const record = getApiKeyRecord(apiKey);
    if (record) lookupAddress = record.address;
  }

  const txs = getRelayedTxs(lookupAddress);

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
