import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * GET /api/cron/gas-alert
 *
 * Called by Vercel Cron (vercel.json) every 6 hours.
 * Checks all Gas Tank balances and sends Telegram alert if any are low/empty.
 *
 * Protected by CRON_SECRET env var. Fail-closed: rejects if unset.
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = cronSecret ? `Bearer ${cronSecret}` : "";
  if (
    !cronSecret ||
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "https://q402-institutional.vercel.app";
  const res = await fetch(`${base}/api/gas-tank?check_alerts=1`);
  const data = await res.json();

  const lowCount = data.tanks?.filter((t: { low: boolean; empty: boolean }) => t.low || t.empty).length ?? 0;

  return NextResponse.json({
    checked: data.tanks?.length ?? 0,
    alerted: lowCount,
    timestamp: new Date().toISOString(),
  });
}
