import { NextRequest, NextResponse } from "next/server";
import { getSubscription, addQuotaBonus, getPlanQuota } from "@/app/lib/db";
import { checkAdminSecret } from "@/app/lib/admin-auth";

// Admin-only: Add quota bonus to a subscription.
// Requires x-admin-secret header.
export async function POST(req: NextRequest) {
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { address, additionalTxs } = await req.json();
  if (!address || !additionalTxs || typeof additionalTxs !== "number" || additionalTxs <= 0) {
    return NextResponse.json({ error: "address and additionalTxs (positive number) required" }, { status: 400 });
  }

  const sub = await getSubscription(address);
  if (!sub) {
    return NextResponse.json({ error: "No subscription found" }, { status: 404 });
  }

  await addQuotaBonus(address, additionalTxs);

  const baseQuota = getPlanQuota(sub.plan);
  const newTotal = baseQuota + (sub.quotaBonus ?? 0) + additionalTxs;

  return NextResponse.json({
    success: true,
    plan: sub.plan,
    addedTxs: additionalTxs,
    newTotalQuota: newTotal,
  });
}
