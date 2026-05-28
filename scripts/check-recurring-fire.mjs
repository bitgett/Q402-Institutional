import { kv } from "@vercel/kv";

const OWNER = "0xabd41cc1cd77247d51841ac8a377a024afa6c062";
const WALLET = "0x0f990b59f5f57b428da03d4d4e5242264978d5a7";

console.log("\n=== recurring rules ===");
const ids = await kv.lrange(`aw:recurring:list:${OWNER}:${WALLET}`, 0, -1);
console.log(`rule ids: ${JSON.stringify(ids)}`);

for (const id of ids ?? []) {
  const r = await kv.get(`aw:recurring:${OWNER}:${WALLET}:${id}`);
  console.log("\n  --- rule ---");
  console.log(JSON.stringify(r, null, 2));
}

console.log("\n=== fired markers for this wallet (last 24h) ===");
let cursor = 0;
const markers = [];
do {
  const [next, batch] = await kv.scan(cursor, { match: "aw:recurring:fired:*", count: 500 });
  cursor = next;
  for (const k of batch) markers.push(k);
  if (String(cursor) === "0") break;
} while (markers.length < 5000);
console.log(`total fired markers in KV: ${markers.length}`);
// Print a few — we don't know the ruleId so can't filter directly
for (const k of markers.slice(0, 8)) console.log(`  ${k}`);

console.log("\n=== recent relayed tx for this wallet (current month) ===");
const ym = new Date().toISOString().slice(0, 7);
const key = `relaytx:${WALLET}:${ym}`;
try {
  const list = await kv.lrange(key, -10, -1);
  console.log(`last 10 entries in ${key}:`);
  for (const tx of list ?? []) {
    console.log(`  ${tx.relayedAt} ${tx.fromUser} → ${tx.toUser} ${tx.tokenAmount} ${tx.tokenSymbol} hash=${tx.relayTxHash?.slice(0, 18) ?? "?"}…`);
  }
} catch (e) {
  console.log("  lrange failed:", String(e).slice(0, 100));
}
