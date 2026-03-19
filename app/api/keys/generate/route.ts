import { NextRequest, NextResponse } from "next/server";
import { getSubscription, generateApiKey, setSubscription, deactivateApiKey } from "@/app/lib/db";

function checkAdminSecret(req: NextRequest): boolean {
  const secret = req.headers.get("x-admin-secret");
  const expected = process.env.ADMIN_SECRET;
  return !!expected && secret === expected;
}

// Admin-only: Regenerate API key for a given address.
// Requires x-admin-secret header.
export async function POST(req: NextRequest) {
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { address } = await req.json();
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const sub = await getSubscription(address);
  if (!sub) {
    return NextResponse.json({ error: "No subscription found" }, { status: 404 });
  }

  // Revoke old key before issuing new one
  if (sub.apiKey) await deactivateApiKey(sub.apiKey);
  const newKey = await generateApiKey(address, sub.plan);
  await setSubscription(address, { ...sub, apiKey: newKey });

  return NextResponse.json({ success: true, plan: sub.plan });
}
