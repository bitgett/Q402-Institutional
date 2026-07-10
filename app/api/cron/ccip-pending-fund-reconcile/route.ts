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
  acquirePendingFundReconcileLock,
  claimAndDebitNativeBridge,
  claimAndDebitLinkBridge,
  listOrphanFundKeys,
  listPendingFundKeys,
  listPendingClearDebitKeys,
  listPendingFeeDebitKeys,
  releasePendingFundReconcileLock,
  type OrphanFundRecord,
  type PendingFundRecord,
  type PendingClearDebitRecord,
  type PendingFeeDebitRecord,
  isCCIPLinkChain,
  isNativeBridgeFeeChain,
} from "@/app/lib/db";
import { getCCIPProvider, isCCIPChain, type CCIPChainKey } from "@/app/lib/ccip";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 30;

/** A row this old without confirmation is treated as stuck — ops alert + delete. */
const ORPHAN_THRESHOLD_MS = 60 * 60 * 1000;

interface ReconcileOutcome {
  key:      string;
  outcome:  "debited" | "reverted" | "still_pending" | "orphan" | "row_invalid" | "chain_invalid" | "skipped_inline_in_flight";
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
  // Rows the cron declined to touch because the inline reconciler in
  // /api/ccip/send was already holding the SETNX lock. Distinct from
  // stillPending — that bucket is "tx not yet mined", this bucket is
  // "we skipped on purpose". Ops dashboards alerting on stillPending
  // thresholds want these separated so a high-traffic hour doesn't
  // flood the alert channel.
  let skippedInlineInFlight = 0;

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

    // ── CAS lock against the inline /api/ccip/send reconciler ─────────
    // If the user fires another bridge attempt during this cron tick,
    // the route's inline reconcile block competes with us for the same
    // receipt → debit → del sequence. SETNX with 30s TTL ensures only
    // one writer proceeds; the cron skips this row this tick and the
    // next tick picks it up.
    const lockToken = await acquirePendingFundReconcileLock(rec.ownerLc, rec.chain);
    if (!lockToken) {
      skippedInlineInFlight++;
      outcomes.push({ key, outcome: "skipped_inline_in_flight" });
      continue;
    }

    const provider = getCCIPProvider(rec.chain as CCIPChainKey);
    try {
      // Distinguish "RPC errored" from "RPC returned null" (=tx not yet
      // mined). Previously both were collapsed into `null`, so an RPC
      // outage that ran longer than the orphan threshold would cause us
      // to delete rows for real, mined funds.
      let receipt: Awaited<ReturnType<typeof provider.getTransactionReceipt>> | null = null;
      let receiptRpcErrored = false;
      try {
        receipt = await provider.getTransactionReceipt(rec.txHash);
      } catch (rpcErr) {
        receiptRpcErrored = true;
        console.error("[ccip-pending-fund-reconcile] receipt RPC error", {
          key,
          chain: rec.chain,
          txHash: rec.txHash,
          err: rpcErr instanceof Error ? rpcErr.message.slice(0, 80) : "rpc_error",
        });
      }

      if (!receipt) {
        // If the RPC itself errored, we cannot distinguish "not mined"
        // from "mined but we can't see it." Skip this row this tick and
        // never count it toward the orphan-age threshold — wait for the
        // RPC to recover. Persistent failure (>3 ticks) gets a separate
        // alert via the still_pending detail string.
        if (receiptRpcErrored) {
          stillPending++;
          outcomes.push({ key, outcome: "still_pending", detail: "rpc_error" });
          continue;
        }
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
        // Atomic claim + INCRBYFLOAT in one Lua script. Closes BOTH
        // the inline-vs-cron race AND the "INCR response lost → RMW
        // retry stomps" gap. If the inline reconciler already settled
        // this hash, the script returns "already_claimed" and we just
        // DEL the pending row — the bucket is already correct.
        const debitResult = await claimAndDebitNativeBridge(rec.txHash, rec.ownerLc, rec.chain, debitEth);
        await kv.del(key).catch(() => { /* TTL will sweep */ });
        debited++;
        outcomes.push({
          key,
          outcome: "debited",
          detail: debitResult.debited
            ? `${debitEth.toFixed(6)} native`
            : "already_claimed_skipped",
        });
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
    } finally {
      // Always release the SETNX lock so the next tick (cron OR inline
      // /api/ccip/send retry) can pick up wherever this iteration left
      // off. continue + finally is well-defined in JS. The token-bound
      // release refuses to delete a lock another writer took after our
      // TTL expired (Lua compare-and-delete).
      await releasePendingFundReconcileLock(rec.ownerLc, rec.chain, lockToken);
    }
  }

  // ── Pending clear-delegation debit reconciliation (FIX 68b) ────────
  // Same shape as the fund reconciliation but the row stores the
  // estimated gas cost (no value transfer). We fetch the receipt to
  // get the ACTUAL cost (gasUsed × effectiveGasPrice) and debit that.
  let clearKeys: string[] = [];
  let clearDebited = 0;
  let clearStillPending = 0;
  let clearOrphans = 0;
  try {
    clearKeys = await listPendingClearDebitKeys();
  } catch (e) {
    console.error("[ccip-pending-fund-reconcile] clear-debit scan failed", e);
  }
  for (const key of clearKeys) {
    const rec = await kv.get<PendingClearDebitRecord>(key).catch(() => null);
    if (!rec || typeof rec.txHash !== "string" || typeof rec.chain !== "string") {
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      continue;
    }
    if (!isCCIPChain(rec.chain)) {
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      continue;
    }
    const provider = getCCIPProvider(rec.chain as CCIPChainKey);
    let receipt: Awaited<ReturnType<typeof provider.getTransactionReceipt>> | null = null;
    let rpcErrored = false;
    try {
      receipt = await provider.getTransactionReceipt(rec.txHash);
    } catch {
      rpcErrored = true;
    }
    if (rpcErrored) {
      clearStillPending++;
      continue;
    }
    if (!receipt) {
      const ageMs = Date.now() - (rec.submittedAt ?? 0);
      if (ageMs > ORPHAN_THRESHOLD_MS) {
        clearOrphans++;
        await kv.del(key).catch(() => { /* TTL will sweep */ });
        void sendOpsAlert(
          `<b>⚠ Pending clear-delegation debit row orphaned</b>\n\n` +
          `Owner: <code>${rec.ownerLc}</code>\n` +
          `Chain: ${rec.chain}\n` +
          `Clear txHash: <code>${rec.txHash}</code>\n` +
          `Age: ${Math.round(ageMs / 60_000)} min\n\n` +
          `Receipt missing after ${ORPHAN_THRESHOLD_MS / 60_000} min — manual review.`,
          "warn",
        ).catch(() => { /* best-effort */ });
        continue;
      }
      clearStillPending++;
      continue;
    }
    if (receipt.status !== 1) {
      // Clear tx reverted — no debit owed.
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      continue;
    }
    const gasWei = (receipt.gasUsed ?? 0n) * (receipt.gasPrice ?? 0n);
    const debitEth = Number(gasWei) / 1e18;
    try {
      if (debitEth > 0) {
        // Atomic claim + INCRBYFLOAT (Lua). Closes the same race the
        // fund path closes — clear-delegation route may have already
        // debited inline; this prevents double-debit if its KV DEL of
        // the pending row failed silently.
        await claimAndDebitNativeBridge(rec.txHash, rec.ownerLc, rec.chain, debitEth);
      }
      await kv.del(key).catch(() => { /* TTL will sweep */ });
      clearDebited++;
    } catch (e) {
      // Leave row for next tick.
      const err = e instanceof Error ? e.message : String(e);
      void sendOpsAlert(
        `<b>🚨 Pending clear-debit cron INCRBYFLOAT failed — row retained</b>\n\n` +
        `Owner: <code>${rec.ownerLc}</code>\n` +
        `Chain: ${rec.chain}\n` +
        `Clear txHash: <code>${rec.txHash}</code>\n` +
        `Debit owed: ${debitEth.toFixed(6)} native\n` +
        `Error: ${err.slice(0, 200)}`,
        "error",
      ).catch(() => { /* best-effort */ });
    }
  }

  // ── Orphan-fund reconciliation pass ────────────────────────────────
  // Orphan rows are written when the regular `setPendingFund` 3-retry
  // budget exhausted AFTER the funding tx broadcasted. They have NO
  // TTL — they sit forever until we credit them here. Without this
  // pass, the audit's "orphan records are stored but never processed"
  // finding would mean every degraded-KV event leaks user gas.
  //
  // Shape matches the fund reconcile loop. Different list key.
  let orphanKeys: string[] = [];
  let orphanDebited = 0;
  let orphanStillPending = 0;
  let orphanReverted = 0;
  try {
    orphanKeys = await listOrphanFundKeys();
  } catch (e) {
    console.error("[ccip-pending-fund-reconcile] orphan scan failed", e);
  }
  for (const key of orphanKeys) {
    const rec = await kv.get<OrphanFundRecord>(key).catch(() => null);
    if (!rec || typeof rec.txHash !== "string" || typeof rec.chain !== "string") {
      await kv.del(key).catch(() => { /* swallow */ });
      continue;
    }
    if (!isCCIPChain(rec.chain)) {
      await kv.del(key).catch(() => { /* swallow */ });
      continue;
    }
    const provider = getCCIPProvider(rec.chain as CCIPChainKey);
    let receipt: Awaited<ReturnType<typeof provider.getTransactionReceipt>> | null = null;
    try {
      receipt = await provider.getTransactionReceipt(rec.txHash);
    } catch {
      orphanStillPending++;
      continue;
    }
    if (!receipt) {
      // Orphan rows are by definition POST-broadcast. If the receipt
      // doesn't exist after we've already written the orphan row, the
      // tx was likely dropped/replaced. Leave the row; ops will triage
      // (orphan rows have no TTL, no auto-sweep).
      orphanStillPending++;
      continue;
    }
    if (receipt.status !== 1) {
      // Reverted — no debit owed. DEL the orphan row.
      orphanReverted++;
      await kv.del(key).catch(() => { /* swallow */ });
      continue;
    }
    try {
      const gasWei  = (receipt.gasUsed ?? 0n) * (receipt.gasPrice ?? 0n);
      const valWei  = (() => { try { return BigInt(rec.fundDeltaWei); } catch { return 0n; } })();
      const debitEth = Number(valWei + gasWei) / 1e18;
      await claimAndDebitNativeBridge(rec.txHash, rec.ownerLc, rec.chain, debitEth);
      await kv.del(key).catch(() => { /* swallow */ });
      orphanDebited++;
    } catch (e) {
      orphanStillPending++;
      void sendOpsAlert(
        `<b>🚨 Orphan-fund debit FAILED — row retained</b>\n\n` +
        `Owner: <code>${rec.ownerLc}</code>\n` +
        `Chain: ${rec.chain}\n` +
        `Fund txHash: <code>${rec.txHash}</code>\n` +
        `Error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}\n\n` +
        `Will retry next tick. Reason this row exists: ${rec.reason}`,
        "error",
      ).catch(() => { /* best-effort */ });
    }
  }

  // ── Pending CCIP fee-debit reconciliation pass ─────────────────────
  // Bridge runner writes one of these rows when the post-bridge fee
  // debit throws AFTER the bridge tx already mined. The atomic
  // claim+debit primitive makes the retry safe (same txHash claim
  // refuses double-debit), but the cron is what actually fires the
  // retry. Same row TTL as pending-fund (1h), same 5-min cadence.
  let feeKeys: string[] = [];
  let feeDebited = 0;
  let feeStillPending = 0;
  try {
    feeKeys = await listPendingFeeDebitKeys();
  } catch (e) {
    console.error("[ccip-pending-fund-reconcile] fee-debit scan failed", e);
  }
  for (const key of feeKeys) {
    const rec = await kv.get<PendingFeeDebitRecord>(key).catch(() => null);
    if (!rec || typeof rec.txHash !== "string" || typeof rec.chain !== "string") {
      await kv.del(key).catch(() => { /* swallow */ });
      continue;
    }
    // Native fee rows span the CCIP triangle + the OFT rail (mantle/monad/xlayer);
    // LINK rows only exist on the triangle. Guarding native rows on isCCIPChain
    // would delete mantle/monad/xlayer OFT fee rows without ever debiting them.
    const chainOk = rec.feeToken === "LINK" ? isCCIPLinkChain(rec.chain) : isNativeBridgeFeeChain(rec.chain);
    if (!chainOk || typeof rec.amount !== "number" || rec.amount <= 0) {
      await kv.del(key).catch(() => { /* swallow */ });
      continue;
    }
    try {
      if (rec.feeToken === "LINK") {
        await claimAndDebitLinkBridge(rec.txHash, rec.ownerLc, rec.chain, rec.amount);
      } else {
        await claimAndDebitNativeBridge(rec.txHash, rec.ownerLc, rec.chain, rec.amount);
      }
      await kv.del(key).catch(() => { /* swallow */ });
      feeDebited++;
    } catch (e) {
      feeStillPending++;
      void sendOpsAlert(
        `<b>🚨 Pending fee-debit cron retry FAILED — row retained</b>\n\n` +
        `Owner: <code>${rec.ownerLc}</code>\n` +
        `Chain: ${rec.chain} · feeToken: ${rec.feeToken}\n` +
        `Bridge txHash: <code>${rec.txHash}</code>\n` +
        `messageId: <code>${rec.messageId}</code>\n` +
        `Amount owed: ${rec.amount.toFixed(6)} ${rec.feeToken === "LINK" ? "LINK" : "native"}\n` +
        `Error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}\n\n` +
        `Will retry next tick. Manual debit: INCRBYFLOAT ` +
        `${rec.feeToken === "LINK" ? "link_used" : "bridge_native_used"}` +
        `:${rec.ownerLc}.${rec.chain} by ${rec.amount.toFixed(6)} ` +
        `(claim bridge_debit_claim:${rec.txHash.toLowerCase()} first).`,
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
      skippedInlineInFlight,
      orphans,
      clearScanned:     clearKeys.length,
      clearDebited,
      clearStillPending,
      clearOrphans,
      orphanScanned:    orphanKeys.length,
      orphanDebited,
      orphanReverted,
      orphanStillPending,
      feeScanned:       feeKeys.length,
      feeDebited,
      feeStillPending,
    },
    durationMs,
  });
  return NextResponse.json({
    scanned:       keys.length,
    debited,
    reverted,
    stillPending,
    skippedInlineInFlight,
    orphans,
    clearScanned:     clearKeys.length,
    clearDebited,
    clearStillPending,
    clearOrphans,
    orphanScanned:    orphanKeys.length,
    orphanDebited,
    orphanReverted,
    orphanStillPending,
    feeScanned:       feeKeys.length,
    feeDebited,
    feeStillPending,
    outcomes,
    durationMs,
    asOf: new Date().toISOString(),
  });
}
