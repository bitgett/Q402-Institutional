import { NextRequest, NextResponse } from "next/server";
import { getSubscription, addQuotaBonus, getPlanQuota } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { checkAdminSecret } from "@/app/lib/admin-auth";

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "admin-topup", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { address, additionalTxs } = await req.json();
  if (
    !address ||
    typeof additionalTxs !== "number" ||
    !Number.isInteger(additionalTxs) ||
    additionalTxs <= 0 ||
    additionalTxs > 10_000_000
  ) {
    return NextResponse.json({ error: "address and additionalTxs (positive integer, max 10M) required" }, { status: 400 });
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
