#!/usr/bin/env node
/**
 * seed-stats-summary.mjs — One-shot bootstrap for `stats:public:summary`.
 *
 * Mirrors /api/cron/stats-rollup so the public panel comes back online
 * immediately instead of waiting for the next scheduled cron firing
 * (daily 01:00 UTC). Same scan pattern, same aggregation, same write
 * target — duplicated here only because the cron requires CRON_SECRET
 * (Vercel-side) and we want a path that runs from local .env.local.
 *
 * Read-only on every other key; writes a single `stats:public:summary`.
 *
 * Usage
 *   node --env-file=.env.local scripts/seed-stats-summary.mjs
 */

import { kv } from "@vercel/kv";

const SCAN_COUNT = 500;
const MAX_ITERS = 100_000;
const SUMMARY_KEY = "stats:public:summary";

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
  console.log("seeding stats:public:summary from receipt:* …");
  console.log("scanning receipt keys …");
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

  const summary = {
    totalSettlements,
    uniquePayers: payers.size,
    uniqueRecipients: recipients.size,
    totalVolumeUsd,
    perChain,
    computedAt: new Date().toISOString(),
    scannedKeys: keys.length,
  };

  console.log("\n\n=== computed summary ===");
  console.log(JSON.stringify({ ...summary, perChain: Object.keys(perChain).length + " chains" }, null, 2));
  console.log("\n=== per-chain ===");
  for (const [c, v] of Object.entries(perChain)) {
    console.log(`  ${c.padEnd(12)} settlements=${v.settlements}  volumeUsd=${v.volumeUsd}`);
  }

  await kv.set(SUMMARY_KEY, summary);
  console.log(`\n✓ wrote ${SUMMARY_KEY}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
