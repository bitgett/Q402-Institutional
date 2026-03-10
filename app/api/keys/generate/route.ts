import { NextRequest, NextResponse } from "next/server";
import { getSubscription, generateApiKey, setSubscription } from "@/app/lib/db";

// Regenerate API key for already-paid address (e.g., user wants new key)
export async function POST(req: NextRequest) {
  const { address } = await req.json();
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const sub = getSubscription(address);
  if (!sub) {
    return NextResponse.json({ error: "No active subscription found" }, { status: 403 });
  }

  const newKey = generateApiKey(address, sub.plan);
  setSubscription(address, { ...sub, apiKey: newKey });

  return NextResponse.json({ apiKey: newKey, plan: sub.plan });
}
