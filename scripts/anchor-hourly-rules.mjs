/**
 * anchor-hourly-rules.mjs — one-shot migration: realign existing hourly:N
 * recurring rules to top-of-hour.
 *
 * Background: before this migration, `computeNextFireAt('hourly:N', from)`
 * returned `from + N*HOUR_MS` with the same mm:ss as `from`. If a rule's
 * first fire happened at xx:22 (e.g. created with cancelWindowHours=0
 * which fires immediately), every subsequent fire stayed at xx:22 even
 * though the Render heartbeat only runs at xx:00 — giving a ~38min delay
 * per cycle. The function now ceilings to the next :00, but already-
 * persisted `nextRunAt` values are still off-hour.
 *
 * This script:
 *   1. Iterates the recurring-action ZSET.
 *   2. For each rule with frequency starting "hourly:", ceils nextRunAt
 *      to the next top-of-hour ≥ the existing value (so we never pull
 *      forward; only push to alignment).
 *   3. Rewrites the rule JSON and re-scores the ZSET member.
 *
 * Idempotent: re-runs are no-ops once aligned.
 *
 * Usage:
 *   node --env-file=.env.local scripts/anchor-hourly-rules.mjs        # dry run
 *   node --env-file=.env.local scripts/anchor-hourly-rules.mjs --apply
 */

const KV_URL   = process.env.KV_REST_API_URL ?? "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN ?? "";
if (!KV_URL || !KV_TOKEN) {
  console.error("ERROR: KV_REST_API_URL + KV_REST_API_TOKEN env required.");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const ZSET = "aw:recurring:next-action";
const HOUR_MS = 60 * 60 * 1000;
const JITTER_MS = 60 * 1000;

async function kv(path, init) {
  const r = await fetch(`${KV_URL}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      ...init?.headers,
    },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`KV ${path} → HTTP ${r.status} ${JSON.stringify(body)}`);
  return body.result;
}

function ceilToHour(ms) {
  return Math.ceil((ms - JITTER_MS) / HOUR_MS) * HOUR_MS;
}

function ruleKey(owner, walletId, ruleId) {
  return `aw:recurring:${owner.toLowerCase()}:${walletId.toLowerCase()}:${ruleId}`;
}

function computeNextActionAt(rule) {
  if (rule.pendingFireAt === null || rule.pendingFireAt === undefined) {
    return rule.nextRunAt - (rule.cancelWindowHours ?? 0) * HOUR_MS;
  }
  return rule.nextRunAt;
}

async function main() {
  // ZRANGE over the entire ZSET. We don't byScore here — we want EVERY
  // member regardless of whether it's currently due, so future-scheduled
  // hourly rules also get realigned.
  const members = await kv(`zrange/${encodeURIComponent(ZSET)}/0/-1`);
  if (!Array.isArray(members) || members.length === 0) {
    console.log("ZSET empty — nothing to migrate.");
    return;
  }
  console.log(`Found ${members.length} ZSET member(s). Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  let scanned = 0;
  let aligned = 0;
  let skipped = 0;
  let nonHourly = 0;
  let missing = 0;

  for (const member of members) {
    scanned++;
    const parts = String(member).split("/");
    if (parts.length !== 3) {
      console.log(`  - malformed member ${member}, skip`);
      skipped++;
      continue;
    }
    const [ownerAddr, walletId, ruleId] = parts;
    const ruleRaw = await kv(`get/${ruleKey(ownerAddr, walletId, ruleId)}`);
    if (!ruleRaw) {
      console.log(`  - rule ${ruleId} not in KV (stale ZSET member), skip`);
      missing++;
      continue;
    }
    const rule = typeof ruleRaw === "string" ? JSON.parse(ruleRaw) : ruleRaw;
    if (!rule.frequency || !String(rule.frequency).startsWith("hourly:")) {
      nonHourly++;
      continue;
    }

    const before = rule.nextRunAt;
    const after  = ceilToHour(before);
    if (after === before) {
      // already on the hour (modulo JITTER tolerance)
      continue;
    }
    const driftMin = (after - before) / 60000;
    const beforeIso = new Date(before).toISOString();
    const afterIso  = new Date(after).toISOString();
    console.log(`  · ${ruleId.slice(0, 8)}… [${rule.frequency}] ${beforeIso} → ${afterIso} (+${driftMin.toFixed(1)}min)`);
    aligned++;

    if (!APPLY) continue;

    const next = { ...rule, nextRunAt: after };
    await kv(`set/${ruleKey(ownerAddr, walletId, ruleId)}`, {
      method: "POST",
      body: JSON.stringify(next),
    });
    const newScore = computeNextActionAt(next);
    await kv(`zadd/${encodeURIComponent(ZSET)}/${newScore}/${encodeURIComponent(member)}`, {
      method: "POST",
    });
  }

  console.log(`\nDone. scanned=${scanned} aligned=${aligned} already-aligned=${scanned - aligned - skipped - nonHourly - missing} non-hourly=${nonHourly} missing=${missing} malformed=${skipped}`);
  if (!APPLY && aligned > 0) {
    console.log(`\nRe-run with --apply to commit changes.`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
