/**
 * audit-trial-recurring-rules.mjs — find recurring rules that will
 * terminal-stop under the post-9bb7dcc policy (recurring = paid Multichain
 * on every chain, including BNB).
 *
 * Why this exists: before commit 9bb7dcc the recurring scheduler accepted
 * trial-tier subscriptions for BNB-only schedules, and the cron picked
 * `sub.trialApiKey` over `sub.apiKey` on the BNB path. Both gates are
 * closed now. Any rule attached to a sub that does NOT have multichain
 * scope will fail its next fire with "Recurring requires an active paid
 * Multichain subscription" and transition to fired-cap-exceeded.
 *
 * Surface them in advance so operations can:
 *   1. notify each affected owner before their next fire
 *   2. decide between (a) pause-and-notify, (b) leave terminal-stop in
 *      place and let the dashboard error message + "Resume after paid"
 *      drive the upgrade, or (c) cancel + refund any pre-paid window
 *
 * Read-only — does NOT mutate any rule, ZSET, or subscription. Pure scan
 * + report to stdout + optional JSON file via --out=path.
 *
 * Usage:
 *   node --env-file=.env.local scripts/audit-trial-recurring-rules.mjs
 *   node --env-file=.env.local scripts/audit-trial-recurring-rules.mjs --out=./scripts/trial-recurring.json
 */

import { writeFileSync } from "node:fs";

const KV_URL   = process.env.KV_REST_API_URL ?? "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN ?? "";
if (!KV_URL || !KV_TOKEN) {
  console.error("ERROR: KV_REST_API_URL + KV_REST_API_TOKEN env required.");
  process.exit(1);
}

const OUT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--out="));
  return arg ? arg.slice("--out=".length) : null;
})();

const ZSET = "aw:recurring:next-action";

async function kv(path, init) {
  const r = await fetch(`${KV_URL}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KV_TOKEN}`, ...init?.headers },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`KV ${path} → HTTP ${r.status} ${JSON.stringify(body)}`);
  return body.result;
}

function ruleKey(owner, walletId, ruleId) {
  return `aw:recurring:${owner.toLowerCase()}:${walletId.toLowerCase()}:${ruleId}`;
}

function subKey(owner) {
  return `sub:${owner.toLowerCase()}`;
}

/**
 * Mirrors `hasMultichainScope` from app/lib/db.ts. We don't import the
 * server module here because this script is plain-mjs / no bundler;
 * keep the rule in lockstep when that helper changes.
 */
function hasMultichainScope(sub) {
  if (!sub) return false;
  // Active paid subscription = plan present + not in trial state + expiry in future.
  // Trial-only subs (plan === "trial" with no upgrade) lack the live apiKey path
  // we now require, so we approximate "has multichain" as "has a non-empty
  // sub.apiKey that doesn't start with the test prefix".
  if (typeof sub.apiKey !== "string" || sub.apiKey.length === 0) return false;
  if (sub.apiKey.startsWith("q402_test_")) return false;
  // Optional further gate: sub.plan check. If you change the server-side
  // hasMultichainScope to require a specific plan, mirror that here.
  return true;
}

async function main() {
  console.log(`Scanning ${ZSET} for active recurring rules…`);
  const members = await kv(`zrange/${encodeURIComponent(ZSET)}/0/-1`);
  if (!Array.isArray(members) || members.length === 0) {
    console.log("ZSET empty — no active recurring rules. Nothing to migrate.");
    return;
  }
  console.log(`  ${members.length} ZSET member(s).\n`);

  const affected = [];
  const byOwner = new Map();
  let scanned = 0;
  let skippedMalformed = 0;
  let skippedNoRule = 0;
  let okPaid = 0;

  for (const member of members) {
    scanned++;
    const parts = String(member).split("/");
    if (parts.length !== 3) {
      skippedMalformed++;
      continue;
    }
    const [ownerAddr, walletId, ruleId] = parts;
    const ruleRaw = await kv(`get/${ruleKey(ownerAddr, walletId, ruleId)}`);
    if (!ruleRaw) {
      skippedNoRule++;
      continue;
    }
    const rule = typeof ruleRaw === "string" ? JSON.parse(ruleRaw) : ruleRaw;
    // Skip rules already in a terminal / paused state — those won't fire
    // and don't need re-notification.
    if (rule.status === "cancelled" || rule.status === "fired-cap-exceeded") {
      continue;
    }

    const subRaw = await kv(`get/${subKey(ownerAddr)}`);
    const sub = subRaw
      ? (typeof subRaw === "string" ? JSON.parse(subRaw) : subRaw)
      : null;

    if (hasMultichainScope(sub)) {
      okPaid++;
      continue;
    }

    const entry = {
      ownerAddr,
      walletId,
      ruleId,
      chain: rule.chain,
      frequency: rule.frequency,
      token: rule.token,
      amountUsd: rule.recipients?.reduce((acc, r) => acc + Number(r.amount || 0), 0) ?? null,
      recipientCount: rule.recipients?.length ?? 0,
      nextRunAt: rule.nextRunAt,
      status: rule.status,
      subPlan: sub?.plan ?? null,
      hasTrialKey: typeof sub?.trialApiKey === "string" && sub.trialApiKey.length > 0,
      hasPaidKey: typeof sub?.apiKey === "string" && sub.apiKey.length > 0,
    };
    affected.push(entry);
    if (!byOwner.has(ownerAddr)) byOwner.set(ownerAddr, []);
    byOwner.get(ownerAddr).push(entry);
  }

  console.log(`scanned=${scanned} ok-paid=${okPaid} affected=${affected.length} ` +
    `skipped-malformed=${skippedMalformed} skipped-no-rule=${skippedNoRule}\n`);

  if (affected.length === 0) {
    console.log("✓ No active rules will be impacted by the paid-only policy. All clear.");
    if (OUT) writeFileSync(OUT, JSON.stringify({ asOf: new Date().toISOString(), affected: [], byOwner: {} }, null, 2));
    return;
  }

  console.log(`=== Owners whose next fire will terminal-stop (${byOwner.size}) ===`);
  for (const [owner, rules] of byOwner) {
    console.log(`  ${owner}  →  ${rules.length} rule(s)`);
    for (const r of rules) {
      const next = new Date(r.nextRunAt).toISOString();
      console.log(`    · ${r.ruleId.slice(0, 8)}…  [${r.frequency}] ${r.chain.toUpperCase()} ` +
        `${r.token} $${(r.amountUsd ?? 0).toFixed(2)} · next: ${next} · ` +
        `plan=${r.subPlan ?? "none"} trial=${r.hasTrialKey} paid=${r.hasPaidKey}`);
    }
  }

  if (OUT) {
    const out = {
      asOf: new Date().toISOString(),
      policy: "recurring is paid Multichain only on every chain (post-9bb7dcc)",
      counts: { scanned, okPaid, affected: affected.length, ownersAffected: byOwner.size },
      affected,
      byOwner: Object.fromEntries(byOwner),
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`\n✓ Wrote ${OUT}`);
  }

  console.log("\nOperational options for the affected owners:");
  console.log("  (a) email/notify them now; let next fire terminal-stop and surface " +
    "'fired-cap-exceeded' in the dashboard. They re-subscribe + click Resume.");
  console.log("  (b) preemptively `applyUserStatusAction(... \"pause\")` so the rule");
  console.log("       sits at status=paused instead of fired-cap-exceeded — cleaner");
  console.log("       UX, but loses the inline 'why this stopped' message.");
  console.log("  (c) for trial subs that have ALREADY consumed N fires and you want");
  console.log("       to leave them alone, do nothing — the cron will handle them.");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
