import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord } from "@/app/lib/db";

export async function POST(req: NextRequest) {
  const { apiKey } = await req.json();
  if (!apiKey) {
    return NextResponse.json({ valid: false, error: "apiKey required" }, { status: 400 });
  }

  const record = await getApiKeyRecord(apiKey);
  if (!record || !record.active) {
    return NextResponse.json({ valid: false });
  }

  return NextResponse.json({
    valid: true,
    address: record.address,
    plan: record.plan,
    createdAt: record.createdAt,
  });
}
