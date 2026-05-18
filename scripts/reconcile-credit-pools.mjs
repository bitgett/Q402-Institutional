#!/usr/bin/env node
/**
 * reconcile-credit-pools.mjs — Migrate Q402 credits from single-pool to
 * two-pool model BEFORE the matching code is deployed.
 *
 * Why eager (vs. lazy)
 *   - Hybrid legacy accounts (trial used + paid activated under the single-
 *     pool model) cannot be honestly split at read-time from current state
 *     alone — current `plan` says "starter" once paid lands, erasing the
 *     trial signal that's needed to attribute legacy quota correctly.
 *   - TX history (relaytx:{addr}:{YYYY-MM}) gives a deterministic split:
 *     trial relays happen before subscription.paidAt; paid relays happen
 *     after. That's the only honest way to assign the remaining legacy
 *     counter to the two scoped pools.
 *   - Running this BEFORE the new code deploys means by the time runtime
 *     reads/writes hit scoped keys, every account is already in the right
 *     state. The runtime safety-net seedFromLegacy() exists for missed
 *     accounts and fires an ops alert on hit — but on a clean reconciliation
 *     it should be unreachable.
 *
 * Pools written
 *   quota:trial:{addr}  — trial credits remaining
 *   quota:paid:{addr}   — paid credits remaining
 *   subscription.trialQuotaBonus / paidQuotaBonus — display mirrors
 *   subscription.quotaBonus — legacy sum mirror (kept for back-compat)
 *
 * Pools NOT touched
 *   quota:{addr} (legacy single-pool) — left in place until the
 *     cleanup-legacy-quota.mjs script runs +2 weeks post-deploy. Keeping it
 *     means any concurrent activate that races this script can still find a
 *     legacy value through the runtime safety-net path.
 *
 * Split rules
 *   trial-only legacy (hasTrialSignal && !hasPaidSignal):
 *     trial_seed = legacy, paid_seed = 0
 *   paid-only legacy (!hasTrialSignal && hasPaidSignal):
 *     trial_seed = 0, paid_seed = legacy
 *   hybrid (both signals): TX-history split
 *     trial_consumed = count of relaytx entries with relayedAt < paidAt
 *     trial_seed = max(0, TRIAL_CREDITS - trial_consumed)
 *     paid_seed  = max(0, legacy - trial_seed)
 *   neither signal: orphan — log + skip
 *
 * Idempotency
 *   Uses SET NX on scoped keys. Re-runs are no-ops for accounts where
 *   scoped keys already exist. Safe to run multiple times.
 *
 * Usage
 *   node scripts/reconcile-credit-pools.mjs --dry-run
 *   node scripts/reconcile-credit-pools.mjs --execute
 *   node scripts/reconcile-credit-pools.mjs --dry-run --address=0xbd359064...
 *   node scripts/reconcile-credit-pools.mjs --execute --json
 *
 * Environment
 *   KV_REST_API_URL + KV_REST_API_TOKEN (from .env.local — same as the app)
 */

import { kv } from "@vercel/kv";

const TRIAL_CREDITS = 2000;
const TRIAL_PLAN_NAME = "trial";

// ── argv ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  dryRun: !args.includes("--execute"),
  execute: args.includes("--execute"),
  json: args.includes("--json"),
  address: null,
};
for (const a of args) {
  if (a.startsWith("--address=")) flags.address = a.slice("--address=".length).toLowerCase();
}
if (flags.dryRun && flags.execute) {
  console.error("--dry-run and --execute are mutually exclusive (default is --dry-run).");
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────
const subKey            = (addr) => `sub:${addr.toLowerCase()}`;
const legacyQuotaKey    = (addr) => `quota:${addr.toLowerCase()}`;
const scopedQuotaKey    = (addr, scope) => `quota:${scope}:${addr.toLowerCase()}`;
const relayTxMonthKey   = (addr, month) => `relaytx:${addr.toLowerCase()}:${month}`;

function ym(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function recentMonths(count) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    return ym(d);
  });
}

async function readRelayedTxs(addr) {
  // Same dual-format handling as app/lib/db.ts getRelayedTxs:
  // try Redis list (LRANGE), fall back to legacy JSON array.
  const months = recentMonths(12); // 12 months is more than enough for any window
  const lists = await Promise.all(months.map(async (m) => {
    const key = relayTxMonthKey(addr, m);
    try {
      const list = await kv.lrange(key, 0, -1);
      if (Array.isArray(list) && list.length > 0) return list;
    } catch { /* WRONGTYPE — legacy JSON */ }
    const arr = await kv.get(key);
    return Array.isArray(arr) ? arr : [];
  }));
  return lists.flat();
}

function classifyAccount(sub) {
  const now = new Date();
  const hasTrialSignal = !!sub?.trialApiKey
    && !!sub?.trialExpiresAt
    && new Date(sub.trialExpiresAt) > now;
  const hasPaidSignal = (sub?.amountUSD ?? 0) > 0
    && !!sub?.paidAt
    && sub?.plan !== TRIAL_PLAN_NAME;
  if (hasTrialSignal && !hasPaidSignal) return "trial-only";
  if (!hasTrialSignal && hasPaidSignal) return "paid-only";
  if (hasTrialSignal && hasPaidSignal)  return "hybrid";
  return "orphan";
}

async function computeSplit(addr, sub, legacy) {
  const klass = classifyAccount(sub);
  if (klass === "trial-only") {
    return { trial: legacy, paid: 0, class: klass, trialConsumed: null };
  }
  if (klass === "paid-only") {
    return { trial: 0, paid: legacy, class: klass, trialConsumed: null };
  }
  if (klass === "hybrid") {
    const txs = await readRelayedTxs(addr);
    const paidAt = sub?.paidAt ? new Date(sub.paidAt).getTime() : null;
    // Pre-paidAt TXs are by definition trial relays (under the old
    // single-pool model the user could only have been on trial before
    // paying). Sandbox TXs don't count.
    const trialConsumed = paidAt === null
      ? 0
      : txs.filter(tx => {
          if (!tx?.relayedAt) return false;
          const t = new Date(tx.relayedAt).getTime();
          if (!Number.isFinite(t)) return false;
          if (t >= paidAt) return false;
          if (tx.apiKey?.startsWith?.("q402_test_") || tx.apiKey?.startsWith?.("q402_sandbox_")) {
            return false;
          }
          return true;
        }).length;
    const trialSeed = Math.max(0, TRIAL_CREDITS - trialConsumed);
    const paidSeed  = Math.max(0, legacy - trialSeed);
    return { trial: trialSeed, paid: paidSeed, class: klass, trialConsumed };
  }
  // orphan — log + skip
  return { trial: 0, paid: 0, class: klass, trialConsumed: null };
}

async function applyMigration(addr, plan) {
  const { trial, paid } = plan;
  // SET NX so re-running is safe + concurrent activate's seed-from-legacy
  // can't be overwritten.
  await kv.set(scopedQuotaKey(addr, "trial"), trial, { nx: true });
  await kv.set(scopedQuotaKey(addr, "paid"),  paid,  { nx: true });
  const sub = await kv.get(subKey(addr));
  if (sub) {
    await kv.set(subKey(addr), {
      ...sub,
      trialQuotaBonus: trial,
      paidQuotaBonus:  paid,
      quotaBonus:      trial + paid,
    });
  }
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("Missing KV_REST_API_URL / KV_REST_API_TOKEN env vars.");
    console.error("Source .env.local first or set them in the shell:");
    console.error("  export $(grep -v '^#' .env.local | xargs)");
    process.exit(1);
  }

  const mode = flags.execute ? "EXECUTE" : "DRY-RUN";
  if (!flags.json) {
    console.error(`\n=== Q402 credit pool reconciliation — ${mode} ===`);
    if (flags.address) console.error(`Target address: ${flags.address}`);
    console.error("");
  }

  // Enumerate sub:* keys
  let cursor = 0;
  const subAddresses = [];
  do {
    const [next, keys] = await kv.scan(cursor, { match: "sub:*", count: 200 });
    cursor = Number(next);
    for (const k of keys) {
      const addr = k.slice("sub:".length).toLowerCase();
      if (flags.address && addr !== flags.address) continue;
      subAddresses.push(addr);
    }
  } while (cursor !== 0);

  if (!flags.json) {
    console.error(`Discovered ${subAddresses.length} subscription record(s).\n`);
  }

  const results = [];
  for (const addr of subAddresses) {
    const [sub, legacy, existingTrial, existingPaid] = await Promise.all([
      kv.get(subKey(addr)),
      kv.get(legacyQuotaKey(addr)),
      kv.get(scopedQuotaKey(addr, "trial")),
      kv.get(scopedQuotaKey(addr, "paid")),
    ]);

    const alreadyMigrated = existingTrial !== null || existingPaid !== null;
    const legacyNum = typeof legacy === "number" && Number.isFinite(legacy) ? legacy : 0;

    if (alreadyMigrated) {
      results.push({
        addr,
        action: "skip",
        reason: "already_migrated",
        existingTrial,
        existingPaid,
        legacy: legacyNum,
      });
      continue;
    }
    if (legacyNum <= 0) {
      results.push({
        addr,
        action: "skip",
        reason: "no_legacy_credits",
        legacy: legacyNum,
      });
      continue;
    }

    const plan = await computeSplit(addr, sub, legacyNum);

    if (plan.class === "orphan") {
      results.push({
        addr,
        action: "skip",
        reason: "orphan_no_signal",
        legacy: legacyNum,
        sub_plan: sub?.plan,
        sub_amountUSD: sub?.amountUSD,
      });
      continue;
    }

    const entry = {
      addr,
      action: flags.execute ? "applied" : "would_apply",
      class: plan.class,
      legacy: legacyNum,
      trial_seed: plan.trial,
      paid_seed:  plan.paid,
      sum_matches_legacy: plan.trial + plan.paid === legacyNum,
    };
    if (plan.trialConsumed !== null) entry.trial_consumed = plan.trialConsumed;

    if (flags.execute) {
      await applyMigration(addr, plan);
    }
    results.push(entry);
  }

  // ── output ─────────────────────────────────────────────────────────────
  if (flags.json) {
    console.log(JSON.stringify({ mode, total: results.length, results }, null, 2));
    return;
  }

  const skipMigrated = results.filter(r => r.action === "skip" && r.reason === "already_migrated").length;
  const skipNoLegacy = results.filter(r => r.action === "skip" && r.reason === "no_legacy_credits").length;
  const skipOrphan   = results.filter(r => r.action === "skip" && r.reason === "orphan_no_signal").length;
  const actions     = results.filter(r => r.action === "applied" || r.action === "would_apply");

  console.error("─── Summary ────────────────────────────────────────");
  console.error(`Total subs scanned     : ${results.length}`);
  console.error(`Skipped (already done) : ${skipMigrated}`);
  console.error(`Skipped (no legacy)    : ${skipNoLegacy}`);
  console.error(`Skipped (orphan)       : ${skipOrphan}`);
  console.error(`Migrations ${flags.execute ? "applied" : "to apply"} : ${actions.length}`);
  console.error("");

  if (actions.length > 0) {
    console.error("─── Per-account split ─────────────────────────────");
    for (const r of actions) {
      const cls = r.class.padEnd(10);
      const legacy = String(r.legacy).padStart(7);
      const trial = String(r.trial_seed).padStart(7);
      const paid  = String(r.paid_seed).padStart(7);
      const tc = r.trial_consumed != null ? ` (trial_consumed=${r.trial_consumed})` : "";
      const match = r.sum_matches_legacy ? "✓" : "⚠ MISMATCH";
      console.error(`  ${r.addr}  [${cls}]  legacy=${legacy}  →  trial=${trial}  paid=${paid}  ${match}${tc}`);
    }
    console.error("");
  }

  if (skipOrphan > 0) {
    console.error("─── Orphan accounts (manual review) ───────────────");
    for (const r of results.filter(r => r.reason === "orphan_no_signal")) {
      console.error(`  ${r.addr}  legacy=${r.legacy}  plan=${r.sub_plan}  amountUSD=${r.sub_amountUSD}`);
    }
    console.error("");
  }

  if (!flags.execute && actions.length > 0) {
    console.error("Re-run with --execute to apply.");
  } else if (flags.execute) {
    console.error("Done. Verify a couple of accounts on the dashboard before pushing the deploy.");
  }
}

main().catch(err => {
  console.error(`\nFATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
