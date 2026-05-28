import { kv } from "@vercel/kv";

const TARGET = (process.argv[2] || "").toLowerCase();
if (!TARGET || !TARGET.startsWith("0x")) {
  console.error("usage: node scripts/find-wallet-owner.mjs <0xWalletAddress>");
  process.exit(1);
}

console.log(`scanning aw:* for wallet ${TARGET} ...`);
let cursor = 0;
let found = null;
let iters = 0;
do {
  const [next, batch] = await kv.scan(cursor, { match: "aw:*", count: 500 });
  cursor = next;
  for (const key of batch) {
    // Skip non-record keys (list / export-log / recurring etc.)
    if (key.startsWith("aw:export-log:") || key.startsWith("aw:list:") || key.startsWith("aw:default:") ||
        key.startsWith("aw:recurring:") || key.startsWith("aw:lock:") || key.startsWith("aw:claim:")) continue;
    let rec;
    try { rec = await kv.get(key); } catch { continue; }
    if (!rec || typeof rec !== "object") continue;
    if (typeof rec.address === "string" && rec.address.toLowerCase() === TARGET) {
      found = { key, rec };
      break;
    }
  }
  if (found) break;
  iters++;
  if (String(cursor) === "0" || iters > 200) break;
} while (true);

if (!found) {
  console.log("\nNOT FOUND in aw:* — this address is not a managed Agent Wallet.");
  console.log("It could still be (a) an external EOA that used Q402 directly (Mode A),");
  console.log("or (b) someone else's Agent Wallet on a server we don't see.");
  process.exit(0);
}

console.log("\n=== matching wallet record ===");
console.log(`key: ${found.key}`);
const lite = {
  address:        found.rec.address,
  ownerAddr:      found.rec.ownerAddr,
  walletId:       found.rec.walletId,
  createdAt:      found.rec.createdAt ? new Date(found.rec.createdAt).toISOString() : null,
  deletedAt:      found.rec.deletedAt ? new Date(found.rec.deletedAt).toISOString() : null,
  hasEncryptedPK: !!found.rec.encryptedPK,
  label:          found.rec.label ?? null,
  erc8004AgentId: found.rec.erc8004AgentId ?? null,
};
console.log(JSON.stringify(lite, null, 2));
