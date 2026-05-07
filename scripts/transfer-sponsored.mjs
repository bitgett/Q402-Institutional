/**
 * transfer-sponsored.mjs — admin one-shot
 *
 * Reverses the sponsored grant on the original wallet (FROM_ADDR) and
 * re-issues the same allotment to a new wallet (TO_ADDR).
 *
 * On FROM_ADDR:
 *   - Deactivate the live API key (apikey:<key>.active = false)
 *   - Delete the subscription record (sub:<addr>)
 *   - Reset the quota counter (quota:<addr> = 0)
 *
 * On TO_ADDR:
 *   - Mint a fresh q402_live_ key (apikey:<key>)
 *   - Upsert sub:<addr> with sponsored sentinel (amountUSD=1, paidAt="")
 *   - INCRBY the quota counter by AMOUNT
 *   - Preserve any existing sandboxApiKey on the destination
 *
 * Usage:
 *   vercel env pull /tmp/.env.q402 --environment=production
 *   node --env-file=/tmp/.env.q402 scripts/transfer-sponsored.mjs
 */

import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";

// ── config ──────────────────────────────────────────────────────────────────
// Source/destination wallets are loaded from env to keep personal addresses
// out of tracked source. Set Q402_FROM_ADDR + Q402_TO_ADDR in your local
// env file before invoking. AMOUNT/PLAN keep their script-level defaults.
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

console.log(`Reverting grant on ${fromAddr}…`);

// 1. Deactivate the live key on the FROM record (don't kv.del so the
//    apikey record's audit trail survives — we just flip active=false).
const fromSub = await kv.get("sub:" + fromAddr);
if (fromSub?.apiKey) {
  const fromApi = await kv.get("apikey:" + fromSub.apiKey);
  if (fromApi) {
    await kv.set("apikey:" + fromSub.apiKey, { ...fromApi, active: false });
    console.log(`  apikey ${fromSub.apiKey.slice(0, 18)}… deactivated`);
  }
}

// 2. Drop the subscription record.
await kv.del("sub:" + fromAddr);
console.log(`  sub:${fromAddr} deleted`);

// 3. Reset quota counter.
await kv.set("quota:" + fromAddr, 0);
console.log(`  quota:${fromAddr} → 0`);

console.log(`\nGranting ${AMOUNT.toLocaleString()} sponsored credits to ${toAddr}…`);

// 4. Mint a fresh live key for TO_ADDR.
const apiKey = `q402_live_${randomBytes(24).toString("hex")}`;
await kv.set("apikey:" + apiKey, {
  address:   toAddr,
  createdAt: now,
  active:    true,
  plan:      PLAN,
});

// 5. Upsert sub record. Preserve sandboxApiKey if the dashboard already
//    auto-provisioned one for this wallet.
const existing = await kv.get("sub:" + toAddr);
await kv.set("sub:" + toAddr, {
  ...(existing ?? {}),
  apiKey,
  plan:        PLAN,
  paidAt:      "",      // keeps verify route's expiry guard inactive
  amountUSD:   1,       // sentinel — satisfies dashboard's hasPaid > 0 gate
  quotaBonus:  AMOUNT,
});

// 6. INCRBY quota.
const newTotal = await kv.incrby("quota:" + toAddr, AMOUNT);

console.log("\n✓ done");
console.log(`  to:             ${toAddr}`);
console.log(`  api key:        ${apiKey}`);
console.log(`  granted now:    ${AMOUNT.toLocaleString()}`);
console.log(`  total credits:  ${Number(newTotal).toLocaleString()}`);
console.log(`  plan:           ${PLAN}`);
