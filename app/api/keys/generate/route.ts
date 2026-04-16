import { NextRequest, NextResponse } from "next/server";
import { getSubscription, generateApiKey, setSubscription, deactivateApiKey } from "@/app/lib/db";
import { checkAdminSecret } from "@/app/lib/admin-auth";

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

  // Safe ordering (matches rotateApiKey in db.ts):
  //   1. Create new key          — if this fails, old key still works
  //   2. Point subscription at it — if this fails, old key still works
  //   3. Deactivate old key      — best-effort; dangling-active > lockout
  const oldKey = sub.apiKey;
  const newKey = await generateApiKey(address, sub.plan);
  await setSubscription(address, { ...sub, apiKey: newKey });
  if (oldKey) {
    deactivateApiKey(oldKey).catch(e =>
      console.error(`[admin:generate] old key deactivation failed (non-fatal): ${e}`)
    );
  }

  return NextResponse.json({ success: true, plan: sub.plan });
}
