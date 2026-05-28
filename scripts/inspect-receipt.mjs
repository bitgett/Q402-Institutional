import { kv } from "@vercel/kv";

const receiptId = process.argv[2] || "rct_0b182122e6846c957c8b216a";
const r = await kv.get(`receipt:${receiptId}`);
if (!r) {
  console.log(`receipt:${receiptId} not found`);
  process.exit(1);
}

console.log("=== receipt ===");
console.log(JSON.stringify(r, null, 2));

console.log("\n=== counter set membership ===");
const payerLc = (r.payer || "").toLowerCase();
const recipientLc = (r.recipient || "").toLowerCase();
const [payerIn, recipientIn] = await Promise.all([
  kv.sismember("stats:set:payers", payerLc),
  kv.sismember("stats:set:recipients", recipientLc),
]);
console.log(`  payer    ${payerLc} in stats:set:payers     ? ${payerIn ? "YES ✓" : "NO ✗"}`);
console.log(`  recipient ${recipientLc} in stats:set:recipients ? ${recipientIn ? "YES ✓" : "NO ✗"}`);
