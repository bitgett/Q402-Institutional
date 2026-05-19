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
 *   paidQuotaBonus > 0
 *   apiKey set (the admin-grant paid key survived)
 *
 *   Real trial-only subscriptions miss the paidQuotaBonus condition;
 *   pre-clobber admin-grants (plan === "starter") miss the plan/txHash
 *   conditions. The signature is tight.
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
};
for (const a of args) {
  if (a.startsWith("--plan=")) flags.plan = a.slice("--plan=".length);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function isClobbered(sub) {
  if (!sub || typeof sub !== "object") return false;
  return (
    sub.plan === "trial" &&
    sub.txHash === "trial" &&
    typeof sub.paidQuotaBonus === "number" &&
    sub.paidQuotaBonus > 0 &&
    typeof sub.apiKey === "string" &&
    sub.apiKey.length > 0
  );
}

// ── Scan ──────────────────────────────────────────────────────────────────
// kv.keys is fine for prod scale (low-hundreds of sub:* keys). If the
// account count grows past ~10k, switch to a cursor-based scan.
const subKeys = await kv.keys("sub:*");

const findings = [];
for (const key of subKeys) {
  const sub = await kv.get(key);
  if (!isClobbered(sub)) continue;
  findings.push({
    key,
    address: key.replace(/^sub:/, ""),
    paidPoolMirror: sub.paidQuotaBonus,
    trialPoolMirror: sub.trialQuotaBonus ?? 0,
    currentPlan: sub.plan,
    currentTxHash: sub.txHash,
    currentPaidAt: sub.paidAt,
    apiKey: sub.apiKey,
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
  if (!isClobbered(sub)) {
    // Raced — someone fixed it between scan and apply. Skip silently.
    continue;
  }
  const restored = {
    ...sub,
    plan: flags.plan,
    amountUSD: 0,
    txHash: "admin_grant:unknown",
    // paidAt, apiKey, sandboxApiKey, paidQuotaBonus, trialApiKey,
    // trialSandboxApiKey, trialQuotaBonus, trialExpiresAt — preserved.
  };
  await kv.set(f.key, restored);
  repaired += 1;
  console.log(`✓ Restored ${f.address} — plan="${flags.plan}", amountUSD=0, txHash="admin_grant:unknown"`);
}
console.log(`\nDone. ${repaired} sub(s) restored.\n`);
