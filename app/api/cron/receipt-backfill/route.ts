import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  listBackfillQueue,
  processBackfillEntry,
} from "@/app/lib/receipt-backfill";

/**
 * GET /api/cron/receipt-backfill
 *
 * Drains the receipt-backfill-queue Set, taking a per-tx KV lock for each
 * entry so concurrent cron invocations (or admin manual triggers) don't
 * double-process the same row.
 *
 * Outer guard: Vercel-issued `Authorization: Bearer ${CRON_SECRET}`. Same
 * pattern + same fail-closed behavior as gas-alert / usage-alert.
 *
 * Per-entry result: success → entry removed from queue. Failure → attempts
 * counter is bumped; entries that exceed MAX_ATTEMPTS are dropped with a
 * log line so a permanently-broken record doesn't pin the cron forever.
 *
 * The cron schedule lives in vercel.json. On Hobby plans (daily cap) we
 * run once a day; on Pro it can be every 30 minutes for a tighter SLA.
 * Either way, the backfill is the safety net behind the inline retry —
 * the bulk of relays produce a receipt synchronously.
 */
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  const expected   = cronSecret ? `Bearer ${cronSecret}` : "";
  if (
    !cronSecret ||
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const queue = await listBackfillQueue();

  let succeeded = 0;
  let retried   = 0;
  let givenUp   = 0;
  const errors: { txHash: string; reason: string }[] = [];

  for (const entry of queue) {
    const result = await processBackfillEntry(entry);
    if (result.ok) {
      succeeded++;
    } else if (result.givenUp) {
      givenUp++;
      errors.push({ txHash: entry.txHash, reason: result.reason });
    } else {
      retried++;
      errors.push({ txHash: entry.txHash, reason: result.reason });
    }
  }

  return NextResponse.json({
    queued:    queue.length,
    succeeded,
    retried,
    givenUp,
    errors:    errors.slice(0, 20),       // truncate to keep the response small
    timestamp: new Date().toISOString(),
  });
}
