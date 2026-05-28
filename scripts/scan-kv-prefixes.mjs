#!/usr/bin/env node
/**
 * scan-kv-prefixes.mjs — Roll up KV namespace by prefix.
 *
 * Counts keys for each top-level prefix (`sub:`, `apikey:`, `relaytx:`,
 * `gasdep:`, `gasused:`, `aw:`, `rl:`, etc.). Lets us tell at a glance
 * whether a missing-data incident wiped one prefix or the whole DB.
 *
 * Read-only.
 *
 * Usage
 *   node --env-file=.env.local scripts/scan-kv-prefixes.mjs
 */

import { kv } from "@vercel/kv";

const SCAN_COUNT = 500;
const MAX_ITERS = 100_000;

async function main() {
  console.log("scanning entire KV namespace …");
  const byPrefix = new Map();
  let cursor = 0;
  let total = 0;
  let iters = 0;

  do {
    const [next, batch] = await kv.scan(cursor, { match: "*", count: SCAN_COUNT });
    cursor = next;
    for (const key of batch) {
      total++;
      const colonIdx = key.indexOf(":");
      const prefix = colonIdx >= 0 ? key.slice(0, colonIdx) : "(no-colon)";
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
    iters++;
    if (iters % 20 === 0) process.stdout.write(`  scanned ${total} so far\r`);
    if (String(cursor) === "0" || iters > MAX_ITERS) break;
  } while (true);

  console.log(`\n\ntotal keys: ${total}\n`);
  console.log("=== distribution by top-level prefix ===");
  const sorted = [...byPrefix.entries()].sort((a, b) => b[1] - a[1]);
  for (const [p, n] of sorted) {
    console.log(`  ${p.padEnd(28)} ${n}`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
