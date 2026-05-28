import { kv } from "@vercel/kv";
const s = await kv.get("stats:public:summary");
console.log(JSON.stringify(s, null, 2));
