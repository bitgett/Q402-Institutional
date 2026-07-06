// Probe whether X Layer USD₮0 (0x779ded…) supports EIP-3009 (transferWithAuthorization)
// so we know how to settle the x402 fee. Read-only.
import { ethers } from "ethers";

const RPCS = ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com", "https://xlayer.drpc.org"];
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  // EIP-3009 domain/typehash getters some impls expose:
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
];

let provider;
for (const url of RPCS) {
  try {
    const p = new ethers.JsonRpcProvider(url);
    await p.getBlockNumber();
    provider = p;
    console.log("RPC ok:", url);
    break;
  } catch { /* next */ }
}
if (!provider) { console.log("no RPC reachable"); process.exit(1); }

const c = new ethers.Contract(USDT, ABI, provider);

async function tryCall(label, fn) {
  try { const v = await fn(); console.log(`  ${label}: ${v}`); return true; }
  catch (e) { console.log(`  ${label}: FAIL (${(e.shortMessage || e.message || "").slice(0, 80)})`); return false; }
}

console.log("=== USD₮0 on X Layer:", USDT, "===");
await tryCall("name", () => c.name());
await tryCall("symbol", () => c.symbol());
await tryCall("decimals", () => c.decimals());
await tryCall("version", () => c.version());
await tryCall("DOMAIN_SEPARATOR", () => c.DOMAIN_SEPARATOR());
const has3009 = await tryCall("authorizationState(0,0)  [EIP-3009 marker]", () => c.authorizationState(ethers.ZeroAddress, ethers.ZeroHash));
await tryCall("TRANSFER_WITH_AUTHORIZATION_TYPEHASH", () => c.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());

console.log("\n=> EIP-3009 (transferWithAuthorization) supported:", has3009 ? "YES" : "NO / not exposed");
