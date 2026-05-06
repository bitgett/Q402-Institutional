/**
 * grant-sponsored-credits.mjs — admin one-shot
 *
 * Grants a sponsored allotment of relay credits to a single address.
 *
 * Writes three KV records (matching the schema in app/lib/db.ts):
 *   1. `apikey:<key>`  — fresh q402_live_ key bound to ADDRESS
 *   2. `sub:<addr>`    — subscription record (paidAt="" + amountUSD=0,
 *                        which the verify route treats as non-paid /
 *                        no-expiry, mirroring the sandbox-key path)
 *   3. `quota:<addr>`  — INCRBY by AMOUNT (atomic; rerunning topups up)
 *
 * Usage:
 *   1. vercel env pull /tmp/.env.q402 --environment=production
 *   2. node --env-file=/tmp/.env.q402 scripts/grant-sponsored-credits.mjs
 *   3. (note the printed apiKey — that's what the recipient uses)
 *
 * Required env (KV credentials, present in production env):
 *   - KV_REST_API_URL
 *   - KV_REST_API_TOKEN
 */

import { kv } from "@vercel/kv";
import { randomBytes } from "node:crypto";

// ── config ──────────────────────────────────────────────────────────────────
const ADDRESS = "0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a";
const AMOUNT  = 50000;
const PLAN    = "sponsored";

// ── derived ─────────────────────────────────────────────────────────────────
const addr   = ADDRESS.toLowerCase();
const apiKey = `q402_live_${randomBytes(24).toString("hex")}`;
const now    = new Date().toISOString();

// ── execute ─────────────────────────────────────────────────────────────────
console.log(`Granting ${AMOUNT.toLocaleString()} sponsored credits to ${addr}…`);

// 1. Bind a fresh API key to this address.
await kv.set(`apikey:${apiKey}`, {
  address:   addr,
  createdAt: now,
  active:    true,
  plan:      PLAN,
});

// 2. Subscription record. paidAt="" + amountUSD=0 keeps the verify route
//    from imposing an expiry — same path sandbox-only / provisioned accounts
//    take. quotaBonus is mirrored on the subscription JSON for display only;
//    the atomic source of truth is the quota counter below.
await kv.set(`sub:${addr}`, {
  apiKey,
  plan:        PLAN,
  paidAt:      "",
  amountUSD:   0,
  quotaBonus:  AMOUNT,
});

// 3. Atomic credit counter. INCRBY so the script is rerunnable as a topup.
const newTotal = await kv.incrby(`quota:${addr}`, AMOUNT);

console.log("\n✓ done");
console.log(`  address:        ${addr}`);
console.log(`  api key:        ${apiKey}`);
console.log(`  granted now:    ${AMOUNT.toLocaleString()}`);
console.log(`  total credits:  ${Number(newTotal).toLocaleString()}`);
console.log(`  plan:           ${PLAN}`);
