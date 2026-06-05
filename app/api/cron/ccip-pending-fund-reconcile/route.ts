/**
 * GET /api/cron/ccip-pending-fund-reconcile
 *
 * Scan every `ccip_pending_fund:*` row and try to close it out:
 *   - Fetch the fund tx's receipt from the source chain
 *   - mined + status=1 → debit (gasUsed × effectiveGasPrice + value) and DEL
 *   - mined + reverted → DEL (no debit owed)
 *   - receipt absent + row younger than the per-tick "ignore" floor →
 *     leave it; the next tick + the user's own next bridge attempt
 *     both have another shot at the same reconciliation
 *   - receipt absent + row older than the orphan threshold → page ops
 *     and DEL (1h-old fund tx that still hasn't mined means something
 *     real went wrong; the row TTL would have swept it anyway)
 *
 * Money invariant: this cron exists ONLY to close the timing gap
 * between (a) the user's auto-fund tx being broadcast and (b) the
 * user's next bridge attempt that would have reconciled inline. With
 * the cron, relayer ETH can never sit on the Agent Wallet without the
 * user's Gas Tank being debited (provided ops sees the alerts).
 *
 * Cadence: 5min Render heartbeat — same trigger that drives
 * deposit-scan. Cheap (one getTransactionReceipt per pending row,
 * which is typically 0–1 rows in steady state).
 *
 * Auth: shared CRON_SECRET via Authorization header (requireCronAuth,
 * timing-safe; fail-closed when unset).
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { requireCronAuth } from "@/app/lib/cron-auth";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import {
  listPendingFundKeys,
  recordNativeBridgeUsage,
  type PendingFundRecord,
} from "@/app/lib/db";
import { getCCIPProvider, isCCIPChain, type CCIPChainKey } from "@/app/lib/ccip";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 30;

/** A row this old without confirmation is treated as stuck — ops alert + delete. */
const ORPHAN_THRESHOLD_MS = 60 * 60 * 1000;

interface ReconcileOutcome {
  key:      string;
  outcome:  "debited" | "reverted" | "still_pending" | "orphan" | "row_invalid" | "chain_invalid";
  detail?:  string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();
  let keys: string[];
  try {
    keys = await listPendingFundKeys();
  } catch (e) {
    await recordCronStatus(CRON_NAMES.CCIP_PENDING_FUND_RECONCILE, {
      lastStatus: "error",
      lastError:  `scan_failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "scan_failed" }, { status: 502 });
  }

  const outcomes: ReconcileOutcome[] = [];
  let debited = 0;
  let reverted = 0;
  let stillPending = 0;
  let orphans = 0;

  for (const key of keys) {
    const rec = await kv.get<PendingFundRecord>(key).catch(() => null);
    if (!rec || typeof rec.txHash !== "string" || typeof rec.chain !== "string") {
      outcomes.push({ key, outcome: "row_invalid" });
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      continue;
    }
    if (!isCCIPChain(rec.chain)) {
      outcomes.push({ key, outcome: "chain_invalid", detail: rec.chain });
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      continue;
    }

    const provider = getCCIPProvider(rec.chain as CCIPChainKey);
    const receipt = await provider.getTransactionReceipt(rec.txHash).catch(() => null);

    if (!receipt) {
      // Still pending. If it's older than the orphan threshold, page
      // ops and delete — at that age a missing receipt means the tx
      // was dropped, replaced, or never broadcast.
      const ageMs = Date.now() - (rec.submittedAt ?? 0);
      if (ageMs > ORPHAN_THRESHOLD_MS) {
        orphans++;
        outcomes.push({ key, outcome: "orphan", detail: `age=${Math.round(ageMs / 60_000)}min` });
        await kv.del(key).catch(() => { /* TTL will sweep */ });
        void sendOpsAlert(
          `<b>⚠ CCIP pending fund row orphaned</b>\n\n` +
          `Owner: <code>${rec.ownerLc}</code>\n` +
          `Chain: ${rec.chain}\n` +
          `Fund txHash: <code>${rec.txHash}</code>\n` +
          `Age: ${Math.round(ageMs / 60_000)} min\n\n` +
          `Receipt still missing after ${ORPHAN_THRESHOLD_MS / 60_000} min — tx was likely ` +
          `dropped or replaced. Row deleted; no debit recorded (relayer didn't pay).`,
          "warn",
        ).catch(() => { /* best-effort */ });
        continue;
      }
      stillPending++;
      outcomes.push({ key, outcome: "still_pending", detail: `age=${Math.round(ageMs / 60_000)}min` });
      continue;
    }

    if (receipt.status !== 1) {
      reverted++;
      outcomes.push({ key, outcome: "reverted", detail: rec.txHash });
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      continue;
    }

    // Mined + success. Compute the actual cost and debit.
    const gasWei  = (receipt.gasUsed ?? 0n) * (receipt.gasPrice ?? 0n);
    const valWei  = (() => { try { return BigInt(rec.fundDeltaWei); } catch { return 0n; } })();
    const debitEth = Number(valWei + gasWei) / 1e18;
    try {
      await recordNativeBridgeUsage(rec.ownerLc, rec.chain, debitEth);
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      debited++;
      outcomes.push({ key, outcome: "debited", detail: `${debitEth.toFixed(6)} native` });
    } catch (e) {
      // Leave the row in place for the next tick. Ops alert so a
      // persistent KV failure is visible.
      const err = e instanceof Error ? e.message : String(e);
      outcomes.push({ key, outcome: "still_pending", detail: `debit_failed: ${err.slice(0, 60)}` });
      void sendOpsAlert(
        `<b>🚨 CCIP pending-fund cron debit FAILED — row retained</b>\n\n` +
        `Owner: <code>${rec.ownerLc}</code>\n` +
        `Chain: ${rec.chain}\n` +
        `Fund txHash: <code>${rec.txHash}</code>\n` +
        `Debit owed: ${debitEth.toFixed(6)} native\n` +
        `Error: ${err.slice(0, 200)}\n\n` +
        `Cron will retry next tick. Manual fix: INCRBYFLOAT on ` +
        `bridge_native_used:${rec.ownerLc}.${rec.chain} + DEL ${key}.`,
        "error",
      ).catch(() => { /* best-effort */ });
    }
  }

  const durationMs = Date.now() - startedAt;
  await recordCronStatus(CRON_NAMES.CCIP_PENDING_FUND_RECONCILE, {
    lastStatus: "success",
    lastResult: {
      scanned:       keys.length,
      debited,
      reverted,
      stillPending,
      orphans,
    },
    durationMs,
  });
  return NextResponse.json({
    scanned:       keys.length,
    debited,
    reverted,
    stillPending,
    orphans,
    outcomes,
    durationMs,
    asOf: new Date().toISOString(),
  });
}
