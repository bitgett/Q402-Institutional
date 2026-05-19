#!/usr/bin/env node
/**
 * scan-clobbered-grants.mjs — Detect (and optionally repair) subscriptions
 * whose paid-side fields were silently overwritten by the trial-activate
 * route.
 *
 * Background
 *   admin-grant.mjs leaves amountUSD === 0 on purpose (cash accounting:
 *   the wallet did not pay). The trial-activate route's ALREADY_PAID
 *   guard used to check `amountUSD > 0` only, which let admin-granted
 *   wallets fall through. The activate path then overwrote plan, paidAt,
 *   txHash, and amountUSD with trial defaults — keys + paid pool stayed
 *   intact but the audit trail was wiped, and the dashboard's hasPaid
 *   gate (also amountUSD-based) regressed the Multichain card to 0.
 *
 *   Both gates now use hasMultichainScope() (db.ts) — a presence check
 *   across cash, grant timestamp, paid mirror slot, and admin_grant
 *   sentinel — so the bug cannot recur. This script handles the cleanup
 *   of any sub already in the clobbered state.
 *
 * Clobber signature
 *   plan === "trial"
 *   txHash === "trial"
 *   apiKey set (non-empty — admin-grant's paid key survived the spread)
 *   trialApiKey set (trial-activate added the trial-side key)
 *   apikey:{sub.apiKey} record exists AND record.plan !== "trial"
 *
 *   The first four conditions catch every known clobber shape including
 *   drained grants where paidQuotaBonus mirror has fallen to 0; the
 *   apikey-record plan check eliminates any residual false positive
 *   (a legacy pre-Phase-1 trial-in-apiKey-slot account would have its
 *   apikey record's plan === "trial" and be filtered out).
 *
 *   The previous narrower check (paidQuotaBonus > 0) missed drained
 *   clobbers; the broader alternative (typeof paidQuotaBonus === "number")
 *   false-positives on legitimate post-Phase-1 trial-only accounts that
 *   write paidQuotaBonus: 0 explicitly into the mirror.
 *
 * Restore plan
 *   plan      → "starter" (admin-grant default — overridable via --plan)
 *   amountUSD → 0  (preserve honest cash accounting)
 *   txHash    → "admin_grant:unknown" (original timestamp is unrecoverable)
 *   paidAt    → left as-is (current value is the trial-activate timestamp,
 *               close enough to grant time and still a real Multichain
 *               activation marker; "now" would be worse)
 *   apiKey, sandboxApiKey, paidQuotaBonus, trialApiKey, trialSandboxApiKey,
 *   trialQuotaBonus, trialExpiresAt — all left intact.
 *
 * Usage
 *   node --env-file=.env.local scripts/scan-clobbered-grants.mjs            # dry-run
 *   node --env-file=.env.local scripts/scan-clobbered-grants.mjs --execute
 *   node --env-file=.env.local scripts/scan-clobbered-grants.mjs --json
 *
 * Flags
 *   --execute        Apply restore writes. Default is dry-run (read-only).
 *   --plan=NAME      Plan to restore to (default: "starter")
 *   --json           Machine-parsable output
 *
 * Environment
 *   KV_REST_API_URL + KV_REST_API_TOKEN (same as the app)
 */

import { kv } from "@vercel/kv";

// ── argv ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  execute: args.includes("--execute"),
  json:    args.includes("--json"),
  plan:    "starter",
  planExplicit: false,
};
for (const a of args) {
  if (a.startsWith("--plan=")) {
    flags.plan = a.slice("--plan=".length);
    flags.planExplicit = true;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Stage-1 candidate filter, all sub-record fields only. The apikey-record
// confirmation happens in the scan loop so we do not pay the extra KV read
// for every sub on the system.
function matchesClobberShape(sub) {
  if (!sub || typeof sub !== "object") return false;
  return (
    sub.plan === "trial" &&
    sub.txHash === "trial" &&
    typeof sub.apiKey === "string" &&
    sub.apiKey.length > 0 &&
    typeof sub.trialApiKey === "string" &&
    sub.trialApiKey.length > 0
  );
}

// ── Scan ──────────────────────────────────────────────────────────────────
// kv.keys is fine for prod scale (low-hundreds of sub:* keys). If the
// account count grows past ~10k, switch to a cursor-based scan.
const subKeys = await kv.keys("sub:*");

const findings = [];
for (const key of subKeys) {
  const sub = await kv.get(key);
  if (!matchesClobberShape(sub)) continue;

  // Stage-2: confirm the apiKey slot holds a paid-side key (record.plan
  // would be "starter", "sponsored", or any non-trial plan). A legacy
  // pre-Phase-1 trial-in-apiKey-slot account would have its apikey record's
  // plan === "trial" and be filtered out here.
  const keyRecord = await kv.get(`apikey:${sub.apiKey}`);
  if (!keyRecord || keyRecord.plan === "trial") continue;

  findings.push({
    key,
    address: key.replace(/^sub:/, ""),
    paidPoolMirror: sub.paidQuotaBonus ?? null,
    trialPoolMirror: sub.trialQuotaBonus ?? 0,
    currentPlan: sub.plan,
    currentTxHash: sub.txHash,
    currentPaidAt: sub.paidAt,
    apiKey: sub.apiKey,
    apiKeyRecordPlan: keyRecord.plan,
  });
}

// ── Output ────────────────────────────────────────────────────────────────
if (flags.json) {
  console.log(JSON.stringify({
    mode: flags.execute ? "execute" : "dry-run",
    scanned: subKeys.length,
    found: findings.length,
    findings,
  }, null, 2));
} else {
  console.log(`\n=== scan-clobbered-grants — ${flags.execute ? "EXECUTE" : "DRY-RUN"} ===`);
  console.log(`Scanned sub keys : ${subKeys.length}`);
  console.log(`Flagged          : ${findings.length}\n`);
  for (const f of findings) {
    console.log(`  ${f.address}`);
    console.log(`    paid pool mirror : ${f.paidPoolMirror}`);
    console.log(`    trial pool mirror: ${f.trialPoolMirror}`);
    console.log(`    paidAt (current) : ${f.currentPaidAt}`);
    console.log(`    apiKey           : ${f.apiKey.slice(0, 14)}…${f.apiKey.slice(-4)}`);
    console.log(`    apikey rec plan  : ${f.apiKeyRecordPlan}`);
  }
  if (findings.length === 0) {
    console.log("  (no clobbered subs detected)");
  }
  console.log();
}

if (findings.length === 0 || !flags.execute) {
  if (!flags.execute && findings.length > 0) {
    console.log("Re-run with --execute to apply restore writes.\n");
  }
  process.exit(0);
}

// ── Apply restore ─────────────────────────────────────────────────────────
let repaired = 0;
for (const f of findings) {
  const sub = await kv.get(f.key);
  if (!matchesClobberShape(sub)) {
    // Raced — someone fixed it between scan and apply. Skip silently.
    continue;
  }
  const keyRecord = await kv.get(`apikey:${sub.apiKey}`);
  if (!keyRecord || keyRecord.plan === "trial") {
    // Same race: apiKey rotated or apikey record updated mid-scan.
    continue;
  }
  // Restore plan from the apikey record's plan (the unforged paid-side
  // identifier) when the operator did not pass an explicit override. This
  // preserves "sponsored" vs "starter" tier accurately rather than
  // collapsing every clobbered grant into "starter".
  const restoredPlan = flags.planExplicit ? flags.plan : keyRecord.plan;
  const restored = {
    ...sub,
    plan: restoredPlan,
    amountUSD: 0,
    txHash: "admin_grant:unknown",
    // paidAt, apiKey, sandboxApiKey, paidQuotaBonus, trialApiKey,
    // trialSandboxApiKey, trialQuotaBonus, trialExpiresAt — preserved.
  };
  await kv.set(f.key, restored);
  repaired += 1;
  console.log(`✓ Restored ${f.address} — plan="${restoredPlan}", amountUSD=0, txHash="admin_grant:unknown"`);
}
console.log(`\nDone. ${repaired} sub(s) restored.\n`);
