#!/usr/bin/env node
/**
 * scan-relaytx-types.mjs — Diagnose KV type drift on relaytx:* keys.
 *
 * /api/stats/public + /api/network/recent both expect every relaytx:*
 * key to be either a Redis LIST (modern format) or a STRING containing
 * a legacy JSON array. After the 2026-05-27 incident a chunk of these
 * keys were overwritten to a third type (hash / set / zset), which
 * (a) made their data unreadable through the existing fallbacks and
 * (b) was masking as data loss on the public stats panel (777 → 29
 * unique payers).
 *
 * This script SCANs `relaytx:*`, runs TYPE on each, and rolls up the
 * distribution. Read-only — no writes.
 *
 * Usage
 *   node --env-file=.env.local scripts/scan-relaytx-types.mjs
 *
 * Output
 *   type distribution + a sample of keys per non-list/string type so
 *   we know which addresses + months were clobbered.
 */

import { kv } from "@vercel/kv";

const SCAN_COUNT = 200;
const MAX_ITERS = 10_000;
const SAMPLE_PER_TYPE = 10;

async function scanAll(pattern) {
  const out = [];
  let cursor = 0;
  let iters = 0;
  do {
    const [next, batch] = await kv.scan(cursor, { match: pattern, count: SCAN_COUNT });
    cursor = next;
    out.push(...batch);
    iters++;
    if (String(cursor) === "0" || iters > MAX_ITERS) break;
  } while (true);
  return out;
}

async function typeOf(key) {
  // Upstash exposes TYPE through the underlying client
  return await kv.type(key);
}

async function main() {
  console.log("scanning relaytx:* …");
  const keys = await scanAll("relaytx:*");
  console.log(`found ${keys.length} keys\n`);

  const byType = new Map();
  const samples = new Map();
  let i = 0;

  for (const key of keys) {
    i++;
    if (i % 100 === 0) process.stdout.write(`  scanned ${i}/${keys.length}\r`);
    let t;
    try {
      t = await typeOf(key);
    } catch (err) {
      t = `error:${err?.message?.slice(0, 40) ?? "unknown"}`;
    }
    byType.set(t, (byType.get(t) ?? 0) + 1);
    if (!samples.has(t)) samples.set(t, []);
    const list = samples.get(t);
    if (list.length < SAMPLE_PER_TYPE) list.push(key);
  }

  console.log(`\n\n=== relaytx:* type distribution ===`);
  const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sorted) {
    console.log(`  ${t.padEnd(20)} ${n}`);
  }

  console.log(`\n=== samples ===`);
  for (const [t, list] of samples.entries()) {
    if (t === "list" || t === "string" || t === "none") continue;
    console.log(`\n  ${t} (${byType.get(t)} keys):`);
    for (const k of list) console.log(`    ${k}`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
