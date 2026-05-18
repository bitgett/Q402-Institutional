#!/usr/bin/env node
/**
 * cleanup-legacy-quota.mjs — Delete `quota:{addr}` for accounts whose scoped
 * pools are already populated. Run +2 weeks AFTER the two-pool migration is
 * deployed and after a clean ops monitoring window with no
 * `seedFromLegacy` safety-net alerts.
 *
 * Why a separate phase
 *   - The reconciliation script (reconcile-credit-pools.mjs) seeds the scoped
 *     pools but intentionally leaves quota:{addr} in place. Keeping the legacy
 *     key around for a couple of weeks means any account the script missed
 *     (concurrent edit during the reconcile run, KV eviction race, etc.)
 *     still has its credits accessible through the runtime safety-net
 *     `seedFromLegacy()`.
 *   - Once the safety net has been silent for the soak window, the legacy key
 *     is provably dead state — every relevant account is reading and writing
 *     scoped keys. At that point the legacy key is safe to delete.
 *
 * Safety
 *   - Skips accounts whose scoped pools are NOT populated (would orphan
 *     legacy credits if we deleted blindly).
 *   - Skips accounts where the scoped pool sum is materially less than the
 *     legacy value (potential reconciliation drift — surface for ops review
 *     rather than silently dropping credits).
 *   - --dry-run is the default; --execute is required to mutate.
 *
 * Usage
 *   node scripts/cleanup-legacy-quota.mjs --dry-run
 *   node scripts/cleanup-legacy-quota.mjs --execute
 *   node scripts/cleanup-legacy-quota.mjs --dry-run --address=0xbd359064...
 *   node scripts/cleanup-legacy-quota.mjs --execute --json
 *
 * Environment
 *   KV_REST_API_URL + KV_REST_API_TOKEN
 */

import { kv } from "@vercel/kv";

const args = process.argv.slice(2);
const flags = {
  dryRun:  !args.includes("--execute"),
  execute:  args.includes("--execute"),
  json:     args.includes("--json"),
  address:  null,
};
for (const a of args) {
  if (a.startsWith("--address=")) flags.address = a.slice("--address=".length).toLowerCase();
}
if (flags.dryRun && flags.execute) {
  console.error("--dry-run and --execute are mutually exclusive (default is --dry-run).");
  process.exit(1);
}

const legacyQuotaKey = (addr) => `quota:${addr.toLowerCase()}`;
const scopedQuotaKey = (addr, scope) => `quota:${scope}:${addr.toLowerCase()}`;

async function scanSubAddresses() {
  const addrs = [];
  let cursor = "0";
  do {
    const [next, keys] = await kv.scan(cursor, { match: "sub:0x*", count: 500 });
    cursor = String(next);
    for (const k of keys) {
      const addr = k.slice("sub:".length);
      if (/^0x[0-9a-f]{40}$/i.test(addr)) addrs.push(addr.toLowerCase());
    }
  } while (cursor !== "0");
  return Array.from(new Set(addrs));
}

async function planForAddress(addr) {
  const [legacy, trial, paid] = await Promise.all([
    kv.get(legacyQuotaKey(addr)),
    kv.get(scopedQuotaKey(addr, "trial")),
    kv.get(scopedQuotaKey(addr, "paid")),
  ]);
  const legacyN = typeof legacy === "number" ? legacy : null;
  const trialN  = typeof trial  === "number" ? trial  : null;
  const paidN   = typeof paid   === "number" ? paid   : null;

  if (legacyN === null) {
    return { action: "skip", reason: "no legacy key" };
  }
  if (trialN === null && paidN === null) {
    // Scoped pools never seeded — would orphan the legacy credits.
    return { action: "skip", reason: "scoped pools not populated (run reconcile-credit-pools.mjs first)" };
  }
  const scopedSum = (trialN ?? 0) + (paidN ?? 0);
  // If the scoped sum is materially less than legacy, something's drifted.
  // Surface rather than delete. Allow a small slack (1 credit) for the race
  // window where a legacy decrement landed but scoped seed hadn't caught up.
  if (legacyN > 0 && scopedSum + 1 < legacyN) {
    return {
      action: "skip",
      reason: `scoped sum (${scopedSum}) < legacy (${legacyN}); review before deletion`,
      legacy: legacyN, trial: trialN, paid: paidN,
    };
  }
  return {
    action: "delete",
    legacy: legacyN, trial: trialN ?? 0, paid: paidN ?? 0,
  };
}

async function execute(addr, plan) {
  if (plan.action !== "delete") return;
  await kv.del(legacyQuotaKey(addr));
}

async function main() {
  const addrs = flags.address ? [flags.address] : await scanSubAddresses();
  const out = [];
  let deleted = 0, skipped = 0;

  for (const addr of addrs) {
    const plan = await planForAddress(addr);
    out.push({ address: addr, ...plan });
    if (plan.action === "delete") {
      if (flags.execute) {
        await execute(addr, plan);
      }
      deleted++;
    } else {
      skipped++;
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({
      mode: flags.execute ? "execute" : "dry-run",
      total: addrs.length,
      deleted,
      skipped,
      entries: out,
    }, null, 2));
    return;
  }

  const verb = flags.execute ? "DELETED" : "WOULD DELETE";
  console.log(`\nLegacy quota cleanup — ${flags.execute ? "EXECUTE" : "DRY-RUN"}`);
  console.log("─".repeat(72));
  for (const e of out) {
    if (e.action === "delete") {
      console.log(`  ${verb}  ${e.address}  legacy=${e.legacy} trial=${e.trial} paid=${e.paid}`);
    } else {
      console.log(`  SKIP    ${e.address}  ${e.reason}`);
    }
  }
  console.log("─".repeat(72));
  console.log(`Total: ${addrs.length}  ${verb}: ${deleted}  SKIP: ${skipped}`);
  if (!flags.execute && deleted > 0) {
    console.log(`\nRe-run with --execute to actually delete legacy quota keys.`);
  }
}

main().catch((err) => {
  console.error("cleanup-legacy-quota failed:", err);
  process.exit(1);
});
