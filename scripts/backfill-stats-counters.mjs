#!/usr/bin/env node
/**
 * backfill-stats-counters.mjs — Seed the materialized public-stats
 * counters from the receipt:* source of truth.
 *
 * The /api/relay after() hook now increments six counters on every
 * successful live settlement, and /api/stats/public reads those
 * counters directly. But before the new code ships the counters are
 * all zero, so a fresh deployment would briefly show the public
 * panel as 0 settlements / 0 payers / 0 USD until enough new relays
 * caught it up.
 *
 * This script bootstraps the counters from the durable receipt:*
 * namespace (1-year TTL, ~21k rows today). After it runs:
 *
 *   stats:counter:settlements = totalSettlements seen in receipts
 *   stats:counter:volumeUsd    = totalVolumeUsd
 *   stats:set:payers           = union of all non-sandbox payers
 *   stats:set:recipients       = union of all non-sandbox recipients
 *   stats:hash:perChain        = per-chain {settlements,volumeUsd}
 *
 * Idempotency
 *   Each run DELetes the five target keys before re-seeding, so
 *   re-running is safe and matches the latest receipt-derived
 *   truth. Live relay increments that land during the backfill
 *   window will add to the new keys (SADD dedups payers/recipients
 *   for free; the counters double-count for whatever fraction of
 *   the new traffic lands between DEL and the final SADD). The
 *   incident-recovery cost — at most one re-run of this script —
 *   is acceptable.
 *
 * Usage
 *   node --env-file=.env.local scripts/backfill-stats-counters.mjs
 *   node --env-file=.env.local scripts/backfill-stats-counters.mjs --dry-run
 */

import { kv } from "@vercel/kv";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

const SCAN_COUNT = 500;
const MAX_ITERS = 100_000;

const STATS_COUNTER_SETTLEMENTS = "stats:counter:settlements";
const STATS_COUNTER_VOLUME_USD  = "stats:counter:volumeUsd";
const STATS_SET_PAYERS          = "stats:set:payers";
const STATS_SET_RECIPIENTS      = "stats:set:recipients";
const STATS_HASH_PER_CHAIN      = "stats:hash:perChain";

function rowAmountUsd(rcpt) {
  const value = typeof rcpt.tokenAmount === "string" ? Number(rcpt.tokenAmount) : rcpt.tokenAmount;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function scanReceiptKeys() {
  const out = [];
  let cursor = 0;
  let iters = 0;
  do {
    const [next, batch] = await kv.scan(cursor, { match: "receipt:rct_*", count: SCAN_COUNT });
    cursor = next;
    out.push(...batch);
    iters++;
    if (iters % 5 === 0) process.stdout.write(`  scanned ${out.length} keys so far\r`);
    if (String(cursor) === "0" || iters > MAX_ITERS) break;
  } while (true);
  return out;
}

async function main() {
  console.log(`backfilling stats counters from receipt:* ${DRY_RUN ? "(DRY-RUN)" : ""}`);
  const keys = await scanReceiptKeys();
  console.log(`\nfound ${keys.length} receipt keys`);

  let totalSettlements = 0;
  let totalVolumeUsd = 0;
  const payers = new Set();
  const recipients = new Set();
  const perChain = {};

  const BATCH = 100;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const rows = await Promise.all(slice.map(async (k) => {
      try { return await kv.get(k); } catch { return null; }
    }));
    for (const rcpt of rows) {
      if (!rcpt || typeof rcpt !== "object") continue;
      if (rcpt.sandbox) continue;
      const chain = typeof rcpt.chain === "string" && rcpt.chain.length > 0 ? rcpt.chain : "unknown";
      const payer = typeof rcpt.payer === "string" ? rcpt.payer.toLowerCase() : "";
      const recipient = typeof rcpt.recipient === "string" ? rcpt.recipient.toLowerCase() : "";
      const usd = rowAmountUsd(rcpt);
      totalSettlements += 1;
      totalVolumeUsd += usd;
      if (payer) payers.add(payer);
      if (recipient) recipients.add(recipient);
      const bucket = perChain[chain] ?? { settlements: 0, volumeUsd: 0 };
      bucket.settlements += 1;
      bucket.volumeUsd += usd;
      perChain[chain] = bucket;
    }
    if (i % 1000 === 0 && i > 0) {
      process.stdout.write(`  processed ${i + slice.length}/${keys.length}\r`);
    }
  }

  totalVolumeUsd = Math.round(totalVolumeUsd * 100) / 100;
  for (const k of Object.keys(perChain)) {
    perChain[k].volumeUsd = Math.round(perChain[k].volumeUsd * 100) / 100;
  }

  console.log("\n\n=== computed ===");
  console.log(`  totalSettlements : ${totalSettlements}`);
  console.log(`  totalVolumeUsd   : ${totalVolumeUsd}`);
  console.log(`  uniquePayers     : ${payers.size}`);
  console.log(`  uniqueRecipients : ${recipients.size}`);
  console.log(`  perChain:`);
  for (const [c, v] of Object.entries(perChain)) {
    console.log(`    ${c.padEnd(12)} settlements=${v.settlements}  volumeUsd=${v.volumeUsd}`);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: no writes performed.");
    return;
  }

  console.log("\nwriting counters …");
  // DEL existing keys first so a re-run replaces (not accumulates onto) the
  // previous backfill. Concurrent live relay increments that land between
  // these DELs and the final SADDs will double-count toward the new keys —
  // acceptable for an opt-in repair tool.
  await Promise.all([
    kv.del(STATS_COUNTER_SETTLEMENTS),
    kv.del(STATS_COUNTER_VOLUME_USD),
    kv.del(STATS_SET_PAYERS),
    kv.del(STATS_SET_RECIPIENTS),
    kv.del(STATS_HASH_PER_CHAIN),
  ]);

  // Counters & hash — single SETs.
  await kv.set(STATS_COUNTER_SETTLEMENTS, totalSettlements);
  await kv.set(STATS_COUNTER_VOLUME_USD, totalVolumeUsd);
  const hashPayload = {};
  for (const [c, v] of Object.entries(perChain)) {
    hashPayload[`${c}:settlements`] = v.settlements;
    hashPayload[`${c}:volumeUsd`]   = v.volumeUsd;
  }
  if (Object.keys(hashPayload).length > 0) {
    await kv.hset(STATS_HASH_PER_CHAIN, hashPayload);
  }

  // SETs — batch SADD so a single round trip writes hundreds of members.
  const payersList = [...payers];
  const recipientsList = [...recipients];
  const SADD_BATCH = 500;
  for (let i = 0; i < payersList.length; i += SADD_BATCH) {
    const slice = payersList.slice(i, i + SADD_BATCH);
    if (slice.length === 1) await kv.sadd(STATS_SET_PAYERS, slice[0]);
    else                    await kv.sadd(STATS_SET_PAYERS, slice[0], ...slice.slice(1));
  }
  for (let i = 0; i < recipientsList.length; i += SADD_BATCH) {
    const slice = recipientsList.slice(i, i + SADD_BATCH);
    if (slice.length === 1) await kv.sadd(STATS_SET_RECIPIENTS, slice[0]);
    else                    await kv.sadd(STATS_SET_RECIPIENTS, slice[0], ...slice.slice(1));
  }

  console.log("✓ counters seeded");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
