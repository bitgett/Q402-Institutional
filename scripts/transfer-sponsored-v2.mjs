/**
 * transfer-sponsored-v2.mjs — admin one-shot
 *
 * Cleans up the previous (mis-targeted) sponsored grant on FROM_ADDR and
 * re-issues the same allotment to TO_ADDR.
 *
 * On FROM_ADDR (0x8266d8…):
 *   - Deactivate EVERY live api key bound to this address (the prior
 *     sponsored grant + the legacy starter key from the 2026-04-10 paid
 *     activation). Sandbox keys are left alone — they're harmless.
 *   - Delete sub:<addr>
 *   - Reset quota:<addr> to 0
 *
 * On TO_ADDR:
 *   - Mint a fresh q402_live_ key
 *   - Upsert sub:<addr> with sponsored sentinel (amountUSD=1, paidAt="")
 *   - INCRBY quota by AMOUNT
 *   - Preserve any existing sandboxApiKey
 */

import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";

// ── config ──────────────────────────────────────────────────────────────────
// Wallets come from env so personal/internal addresses stay out of tracked
// source. Set Q402_FROM_ADDR + Q402_TO_ADDR in your local env file.
const FROM_ADDR = (process.env.Q402_FROM_ADDR ?? "").trim();
const TO_ADDR   = (process.env.Q402_TO_ADDR   ?? "").trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(FROM_ADDR) || !/^0x[0-9a-fA-F]{40}$/.test(TO_ADDR)) {
  console.error("Set Q402_FROM_ADDR and Q402_TO_ADDR (40-hex 0x addresses) in your env file.");
  process.exit(1);
}
const AMOUNT    = 50000;
const PLAN      = "sponsored";

const fromAddr = FROM_ADDR.toLowerCase();
const toAddr   = TO_ADDR.toLowerCase();
const now      = new Date().toISOString();

// ── 1. Deactivate every live key bound to FROM_ADDR ─────────────────────────
console.log(`Cleaning up ${fromAddr}…`);
{
  let cursor = "0", deactivated = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match: "apikey:*", count: 200 });
    cursor = next;
    for (const k of keys) {
      const rec = await kv.get(k);
      if (!rec || rec.address !== fromAddr) continue;
      if (rec.isSandbox) continue;            // leave sandbox keys
      if (rec.active === false) continue;     // already deactivated
      await kv.set(k, { ...rec, active: false });
      console.log(`  deactivated ${k.slice(0, 25)}…  plan=${rec.plan}`);
      deactivated++;
    }
  } while (cursor !== "0");
  console.log(`  total live keys deactivated on FROM: ${deactivated}`);
}

// ── 2. Drop sub + reset quota on FROM_ADDR ──────────────────────────────────
await kv.del("sub:" + fromAddr);
await kv.set("quota:" + fromAddr, 0);
console.log(`  sub:${fromAddr} deleted`);
console.log(`  quota:${fromAddr} → 0`);

// ── 3. Mint fresh live key for TO_ADDR ──────────────────────────────────────
console.log(`\nGranting ${AMOUNT.toLocaleString()} sponsored credits to ${toAddr}…`);
const apiKey = `q402_live_${randomBytes(24).toString("hex")}`;
await kv.set("apikey:" + apiKey, {
  address:   toAddr,
  createdAt: now,
  active:    true,
  plan:      PLAN,
});

// ── 4. Upsert sub on TO_ADDR (preserve existing sandboxApiKey if present) ──
const existing = await kv.get("sub:" + toAddr);
await kv.set("sub:" + toAddr, {
  ...(existing ?? {}),
  apiKey,
  plan:        PLAN,
  paidAt:      "",     // verify route's expiry guard stays inactive
  amountUSD:   1,      // sentinel — passes dashboard's hasPaid > 0 gate
  quotaBonus:  AMOUNT,
});

// ── 5. INCRBY quota counter ─────────────────────────────────────────────────
const newTotal = await kv.incrby("quota:" + toAddr, AMOUNT);

console.log("\n✓ done");
console.log(`  to:             ${toAddr}`);
console.log(`  api key:        ${apiKey}`);
console.log(`  granted now:    ${AMOUNT.toLocaleString()}`);
console.log(`  total credits:  ${Number(newTotal).toLocaleString()}`);
console.log(`  plan:           ${PLAN}`);
