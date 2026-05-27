/**
 * GET /api/cron/agentic-wallet-gc
 *
 * Vercel Cron sweep that hard-deletes Agent Wallet records once the
 * 7-day soft-delete grace has elapsed. Multi-wallet aware (v2 schema).
 *
 * Audit fix (P0 — backend correctness):
 *   Before hard-deleting, query the on-chain stablecoin balance. If
 *   the wallet still holds USDC/USDT above the dust threshold, SKIP
 *   the delete and fire a critical ops alert. The user forgot to
 *   sweep — destroying the encrypted private key now would permanently
 *   strand the funds. The alert hands the wallet back to ops who can
 *   reach out, extend the grace, or operator-sweep on the user's
 *   behalf.
 *
 * Authentication: shared CRON_SECRET via Authorization header.
 *
 * Scan pattern: kv.keys("aw:*") then filter to per-wallet record keys
 * (which now follow `aw:{owner}:{walletId}`). Legacy single-wallet
 * `aw:{owner}` keys are also picked up so any unmigrated owner is
 * still swept.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

import {
  hardDeleteAgenticWallet,
  SOFT_DELETE_GRACE_MS,
  type AgenticWalletRecord,
} from "@/app/lib/agentic-wallet";
import { fetchAgenticBalances } from "@/app/lib/agentic-wallet-balance";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { requireCronAuth } from "@/app/lib/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Skip delete if on-chain balance is at least this many USD-equivalent. */
const DUST_THRESHOLD_USD = 0.01;

interface ScanKey {
  key: string;
  owner: string;
  walletId: string;
  isLegacy: boolean;
}

/**
 * Classify a KV key:
 *   `aw:{owner}`              → legacy single-wallet record (v1)
 *   `aw:{owner}:{walletId}`   → multi-wallet record (v2)
 * Anything with more segments (export-log, daily-spend, batch, list,
 * default, register-tx, balance, send, agent-md) is skipped.
 */
function classifyRecordKey(key: string): ScanKey | null {
  if (!key.startsWith("aw:")) return null;
  // Exclude all non-record families up front.
  for (const prefix of [
    "aw:export-log:",
    "aw:daily-spend:",
    "aw:batch:",
    "aw:send:",
    "aw:list:",
    "aw:default:",
    "aw:register-tx:",
    "aw:balance:",
    "aw:agent-md:",
  ]) {
    if (key.startsWith(prefix)) return null;
  }
  const rest = key.slice("aw:".length);
  const parts = rest.split(":");
  if (parts.length === 1) {
    // Legacy single-wallet record. walletId is implicit (the address
    // lives on the record itself, not in the key).
    return { key, owner: parts[0], walletId: "", isLegacy: true };
  }
  if (parts.length === 2 && /^0x[0-9a-fA-F]{40}$/.test(parts[1])) {
    return { key, owner: parts[0], walletId: parts[1], isLegacy: false };
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  // Cursor-based SCAN instead of `kv.keys("aw:*")`. The old approach
  // pulled every `aw:*` key into a single in-memory array — fine at
  // current scale but unbounded; at ~100k records the 60s function
  // timeout would burn before we got to candidate filtering. SCAN
  // pages in chunks so the worker can iterate in steady-state memory.
  //
  // We still process synchronously per record (the balance check is
  // the slow part, not the scan), but a single oversized batch can't
  // OOM the runtime anymore.
  const SCAN_COUNT = 200;
  const now = Date.now();
  const deleted: string[] = [];
  const skipped: { key: string; reason: string; balanceUsd?: number | null }[] = [];
  let scanned = 0;
  let cursor: string | number = 0;
  let scanIters = 0;

  do {
    let page: string[];
    try {
      // @vercel/kv types `scan` as returning `[string | number, string[]]`
      // but TS infers union widths poorly through the loop's mutated
      // `cursor` var — annotate explicitly.
      const res: [string | number, string[]] = await kv.scan(cursor, {
        match: "aw:*",
        count: SCAN_COUNT,
      });
      cursor = res[0];
      page = res[1];
    } catch (e) {
      console.error("[agentic-wallet-gc] kv.scan failed:", e);
      return NextResponse.json({ error: "kv_scan_failed" }, { status: 502 });
    }
    scanIters++;
    scanned += page.length;

    for (const key of page) {
      const cls = classifyRecordKey(key);
      if (!cls) continue;

      const record = await kv.get<AgenticWalletRecord>(key);
    if (!record) continue;
    if (!record.deletedAt) continue;

    const elapsed = now - record.deletedAt;
    if (elapsed < SOFT_DELETE_GRACE_MS) {
      skipped.push({ key, reason: "within_grace" });
      continue;
    }

    // ── Balance check (P0 audit fix v2) ──────────────────────────────
    // Even after grace, refuse to destroy the keystore if the wallet
    // still holds funds OR if we can't prove it doesn't. Two failure
    // modes covered:
    //
    //   (a) `fetchAgenticBalances` throws → outer catch → skip.
    //   (b) `fetchAgenticBalances` returns BUT some chain failed —
    //       the per-chain catch suppressed the error, contributed 0
    //       to `totalUsd`. Without this guard a chain whose RPC was
    //       down, or whose multicall3 wasn't deployed (Stable /
    //       Injective / Monad / Mantle / Scroll have community-deploy
    //       canonical-address gaps), would let the cron see "$0" and
    //       hard-delete a wallet whose funds live on that chain.
    //
    // Fail closed on either path: skip the delete + page ops.
    let balanceUsd: number | null = null;
    let unreachableChains: string[] = [];
    try {
      const balances = await fetchAgenticBalances(record.address);
      balanceUsd = balances.totalUsd;
      unreachableChains = balances.unreachableChains;
    } catch (e) {
      console.error(`[agentic-wallet-gc] balance check failed for ${record.address}:`, e);
      void sendOpsAlert(
        `agentic-wallet-gc balance check threw for ${record.ownerAddr} ` +
          `(walletId=${cls.isLegacy ? "(legacy)" : cls.walletId}, address=${record.address}). ` +
          `Hard-delete deferred — investigate balance manually before retrying.`,
        "warn",
      );
      skipped.push({ key, reason: "balance_check_failed", balanceUsd: null });
      continue;
    }

    if (unreachableChains.length > 0) {
      // Per-chain RPC suppressed an error; cannot prove the wallet is
      // empty on those chains. Skip + alert — funds on the unreachable
      // chain would be permanently stranded if we proceeded.
      void sendOpsAlert(
        `agentic-wallet-gc: chain(s) unreachable for ${record.address} ` +
          `(owner ${record.ownerAddr}). Cannot verify zero balance on: ` +
          `${unreachableChains.join(", ")}. Hard-delete deferred. ` +
          `Likely cause: RPC outage or missing Multicall3 deployment ` +
          `on a community-deploy chain.`,
        "critical",
      );
      skipped.push({ key, reason: "chain_unreachable", balanceUsd });
      continue;
    }

    if (balanceUsd !== null && balanceUsd >= DUST_THRESHOLD_USD) {
      void sendOpsAlert(
        `agentic-wallet-gc: HOLDING WALLET — refusing to hard-delete ${record.address} ` +
          `(owner ${record.ownerAddr}, grace elapsed ${Math.floor(elapsed / 86_400_000)}d). ` +
          `On-chain USDC+USDT balance ≈ $${balanceUsd.toFixed(2)}. ` +
          `User forgot to sweep before grace expired. Either extend the grace (manual KV ` +
          `update of deletedAt) or have ops execute a withdraw on the user's behalf.`,
        "critical",
      );
      skipped.push({ key, reason: "balance_above_dust", balanceUsd });
      continue;
    }

    try {
      if (cls.isLegacy) {
        // Legacy single-wallet record. The library no longer surfaces a
        // matching delete signature — fall back to a direct KV delete
        // for the record key + the legacy export log. Lazy migration
        // would have moved this record on first call, but if the user
        // hasn't touched their account since the v2 deploy it might
        // still be sitting here.
        await kv.del(key);
        await kv.del(`aw:export-log:${cls.owner.toLowerCase()}`);
      } else {
        await hardDeleteAgenticWallet(record.ownerAddr, cls.walletId);
      }
      deleted.push(`${record.ownerAddr}${cls.walletId ? `/${cls.walletId}` : ""}`);
    } catch (e) {
      console.error(`[agentic-wallet-gc] hardDelete failed for ${record.ownerAddr}:`, e);
      skipped.push({ key, reason: "delete_failed" });
    }
    } // end for(page)
    // SCAN returns cursor === "0" / 0 once the iteration is complete.
    // Stop both when the cursor wraps AND defensively when we've spent
    // an absurd number of iterations (e.g. KV reports an infinite
    // cursor due to a server-side bug) so the function timeout
    // doesn't burn here.
    if (String(cursor) === "0" || scanIters > 10_000) break;
  } while (true);

  return NextResponse.json({
    scannedKeys: scanned,
    scanIterations: scanIters,
    deleted,
    skipped,
    asOf: new Date(now).toISOString(),
  });
}
