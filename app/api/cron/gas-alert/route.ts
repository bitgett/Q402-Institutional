import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * GET /api/cron/gas-alert
 *
 * Called by Vercel Cron (vercel.json) daily at 09:00 UTC.
 * Outer guard: Vercel-issued `Authorization: Bearer ${CRON_SECRET}` (fail-closed
 * if unset).
 *
 * The actual balance check + Telegram dispatch runs in `/api/gas-tank?check_alerts=1`.
 * That endpoint is gated by `x-admin-secret`, so this cron MUST forward the admin
 * secret — without it the fetch 401s and no alert ever fires.
 *
 * Returns the counters reported by gas-tank so failure modes are visible in the
 * Vercel cron log (0 alerted doesn't mean "no low tanks" if the upstream 401'd).
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

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return NextResponse.json(
      { error: "ADMIN_SECRET not configured — gas-tank alerts cannot fire" },
      { status: 500 }
    );
  }

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "https://q402-institutional.vercel.app";
  const res = await fetch(`${base}/api/gas-tank?check_alerts=1`, {
    headers: { "x-admin-secret": adminSecret },
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `gas-tank upstream returned ${res.status}` },
      { status: 502 }
    );
  }
  const data = await res.json();

  return NextResponse.json({
    checked:   data.tanks?.length ?? 0,
    flagged:   data.flagged ?? 0,
    alertSent: data.alertSent === true,
    timestamp: new Date().toISOString(),
  });
}
