/**
 * GET /api/cron/agentic-wallet-gc
 *
 * Vercel Cron sweep that hard-deletes Agent Wallet records once the
 * 7-day soft-delete grace has elapsed. Soft-delete only sets
 * `deletedAt`; the record (including the encrypted private key) stays
 * in KV until this cron prunes it.
 *
 * Authentication: shared CRON_SECRET via the Authorization header, per
 * the convention used by /api/cron/gas-alert + /api/cron/usage-alert.
 * Fail-closed when unset.
 *
 * Scan pattern: kv.keys("aw:*") then filter to record keys (not
 * export-log or daily-spend keys, which carry their own TTLs). Scales
 * with wallet count and runs daily, so this stays cheap.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import {
  hardDeleteAgenticWallet,
  SOFT_DELETE_GRACE_MS,
  type AgenticWalletRecord,
} from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";

function isOwnerRecordKey(key: string): boolean {
  // Owner record keys are `aw:{ownerAddr}` — strictly 2 colons total.
  // export-log + daily-spend keys carry extra `:` segments and are
  // skipped.
  if (!key.startsWith("aw:")) return false;
  if (key.startsWith("aw:export-log:")) return false;
  if (key.startsWith("aw:daily-spend:")) return false;
  if (key.startsWith("aw:batch:")) return false;
  // Final guard: exactly one colon after the prefix.
  const rest = key.slice("aw:".length);
  return !rest.includes(":");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET unset — refusing to run." },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let keys: string[];
  try {
    keys = await kv.keys("aw:*");
  } catch (e) {
    console.error("[agentic-wallet-gc] kv.keys failed:", e);
    return NextResponse.json({ error: "kv_scan_failed" }, { status: 502 });
  }

  const now = Date.now();
  const deleted: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const key of keys) {
    if (!isOwnerRecordKey(key)) continue;
    const record = await kv.get<AgenticWalletRecord>(key);
    if (!record) continue;
    if (!record.deletedAt) {
      continue; // active wallet, leave alone
    }
    const elapsed = now - record.deletedAt;
    if (elapsed < SOFT_DELETE_GRACE_MS) {
      skipped.push({ key, reason: "within_grace" });
      continue;
    }
    try {
      await hardDeleteAgenticWallet(record.ownerAddr);
      deleted.push(record.ownerAddr);
    } catch (e) {
      console.error(`[agentic-wallet-gc] hardDelete failed for ${record.ownerAddr}:`, e);
      skipped.push({ key, reason: "delete_failed" });
    }
  }

  return NextResponse.json({
    scannedKeys: keys.length,
    deleted,
    skipped,
    asOf: new Date(now).toISOString(),
  });
}
