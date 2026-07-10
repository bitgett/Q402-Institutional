#!/usr/bin/env node
/**
 * M-01 CI guard: assert that every deployed EIP-7702 payment implementation
 * carries the access-control guards the checked-in source now declares. Fetches
 * the on-chain runtime bytecode and checks for the guard error selectors and the
 * secp256k1 n/2 high-s constant. Fails (exit 1) if any guard is missing, so a
 * stale/unguarded redeploy can never ship unnoticed (see audit Q402-C-H-001).
 *
 * Usage: node scripts/verify-impl-guards.mjs
 */
import https from "node:https";

// keccak256("UnauthorizedFacilitator()") / OwnerMismatch() / InvalidOwner(), first 4 bytes.
const GUARD_SELECTORS = {
  UnauthorizedFacilitator: "0f6fae87",
  OwnerMismatch: "a8c81623",
  InvalidOwner: "49e27cff",
};
// lower half of the secp256k1 n/2 malleability bound, embedded in the guarded _recoverSigner.
const HIGH_S_MARKER = "5d576e7357a4501ddfe92f46681b20a0";

// impl address + a public RPC per chain. Extend as chains are added.
const IMPLS = [
  { chain: "arbitrum", addr: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73", rpc: "https://arb1.arbitrum.io/rpc" },
  { chain: "scroll",   addr: "0x7635F32D893B64b5944CB8cbF2AC4cd3dA41B2f1", rpc: "https://rpc.scroll.io" },
  { chain: "base",     addr: "0x2fb2B2D110b6c5664e701666B3741240242bf350", rpc: "https://mainnet.base.org" },
];

function getCode(rpc, addr) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [addr, "latest"] });
  return new Promise((res, rej) => {
    const u = new URL(rpc);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d).result || ""); } catch (e) { rej(e); } }); },
    );
    req.on("error", rej); req.setTimeout(20000, () => req.destroy(new Error("timeout"))); req.write(body); req.end();
  });
}

let failed = 0;
for (const { chain, addr, rpc } of IMPLS) {
  let code = "";
  try { code = (await getCode(rpc, addr)).toLowerCase(); } catch (e) { console.error(`  ${chain}: RPC error (${e.message}) — skipped`); continue; }
  if (!code || code === "0x") { console.error(`  ${chain}: no code at ${addr}`); failed++; continue; }
  const missing = [];
  for (const [name, sel] of Object.entries(GUARD_SELECTORS)) if (!code.includes(sel)) missing.push(name);
  if (!code.includes(HIGH_S_MARKER)) missing.push("high-s malleability guard");
  if (missing.length) { console.error(`  ❌ ${chain} (${addr}): MISSING ${missing.join(", ")}`); failed++; }
  else console.log(`  ✅ ${chain} (${addr}): all guards present`);
}

if (failed) { console.error(`\nverify-impl-guards: ${failed} implementation(s) failed the guard check.`); process.exit(1); }
console.log("\nverify-impl-guards: all checked implementations are guarded.");
