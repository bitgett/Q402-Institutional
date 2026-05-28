import { kv } from "@vercel/kv";

const OWNER = "0xabd41cc1cd77247d51841ac8a377a024afa6c062";

console.log(`\n=== gas tank state for ${OWNER} ===\n`);

// Deposits (gasdep:{addr}) — list of {chain, amount, txHash, ts}
console.log("gasdep entries (LIST format):");
try {
  const list = await kv.lrange(`gasdep:${OWNER}`, 0, -1);
  console.log(`  count: ${list?.length ?? 0}`);
  if (list && list.length > 0) {
    for (const d of list.slice(-5)) console.log("   ", JSON.stringify(d));
  }
} catch (e) {
  console.log("  lrange error:", String(e).slice(0, 80));
}

console.log("\ngasdep (legacy string get):");
try {
  const v = await kv.get(`gasdep:${OWNER}`);
  console.log(`  value: ${JSON.stringify(v)?.slice(0, 300) ?? "(null)"}`);
} catch (e) {
  console.log("  get error:", String(e).slice(0, 80));
}

console.log("\ngasused hash (gasused:{addr}) — running total per chain:");
try {
  const h = await kv.hgetall(`gasused:${OWNER}`);
  console.log("  hash:", h);
} catch (e) {
  console.log("  hgetall error:", String(e).slice(0, 80));
}

console.log("\nsub record (relevant fields only):");
const sub = await kv.get(`sub:${OWNER}`);
if (sub) {
  const lite = {
    plan: sub.plan,
    paidAt: sub.paidAt,
    amountUSD: sub.amountUSD,
    trialExpiresAt: sub.trialExpiresAt,
    paidQuotaBonus: sub.paidQuotaBonus,
    trialQuotaBonus: sub.trialQuotaBonus,
    apiKey: sub.apiKey ? sub.apiKey.slice(0, 14) + "…" : null,
    trialApiKey: sub.trialApiKey ? sub.trialApiKey.slice(0, 14) + "…" : null,
  };
  console.log(" ", JSON.stringify(lite, null, 2));
} else {
  console.log("  (sub record not found — no subscription)");
}

console.log("\n=== which apiKey did the rule's last fire try? ===");
// Recurring rule itself doesn't carry the apiKey — the cron picks one
// from the owner's sub at fire time. So check both potential keys' record.
if (sub?.apiKey) {
  const k = await kv.get(`apikey:${sub.apiKey}`);
  console.log("  paid apiKey record:", k ? { plan: k.plan, active: k.active } : "(missing)");
}
if (sub?.trialApiKey) {
  const k = await kv.get(`apikey:${sub.trialApiKey}`);
  console.log("  trial apiKey record:", k ? { plan: k.plan, active: k.active } : "(missing)");
}
