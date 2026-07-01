// One-off: provision a Q402-sponsored trial key to back the A2MCP /pay relay.
// Fresh EOA -> challenge -> sign -> /api/trial/activate. Writes the key to a
// gitignored temp file (never stdout) so it can be piped into Vercel env.
import { ethers } from "ethers";
import { writeFileSync } from "fs";

const BASE = process.env.A2MCP_PROVISION_BASE || "https://q402.quackai.ai";

const wallet = ethers.Wallet.createRandom();
const addr = wallet.address.toLowerCase();

const chRes = await fetch(`${BASE}/api/auth/challenge?address=${addr}`);
const chJson = await chRes.json();
if (!chJson.challenge) { console.error("challenge failed:", chJson); process.exit(1); }

const msg = `Q402 Institutional\nAuthorize sensitive action (key rotation / payment activation).\n\nAddress: ${addr}\nChallenge: ${chJson.challenge}`;
const signature = await wallet.signMessage(msg);

const actRes = await fetch(`${BASE}/api/trial/activate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: addr, challenge: chJson.challenge, signature }),
});
const act = await actRes.json();
if (!actRes.ok || !act.trialApiKey) { console.error("activate failed:", actRes.status, act); process.exit(1); }

writeFileSync(".a2mcp-relay-key.txt", act.trialApiKey, "utf8");
writeFileSync(".a2mcp-owner.txt", `${addr}\n${wallet.privateKey}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  owner: addr,
  plan: act.plan,
  credits: act.credits,
  trialExpiresAt: act.trialExpiresAt,
  keyPrefix: act.trialApiKey.slice(0, 12) + "…",
  wroteKeyTo: ".a2mcp-relay-key.txt",
}, null, 2));
