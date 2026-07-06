// Self-audit evidence for the x402 fee settlement:
//  A. verify the smoke settlement tx is a real, successful transferWithAuthorization
//  B. REPLAY: settling the same signed authorization twice must fail the 2nd time
//  C. FORGERY: a bogus signature is rejected off-chain (HTTP 400, no on-chain tx)
import { ethers } from "ethers";
import fs from "node:fs";

const envFromFile = (p, k) => {
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
  }
  return null;
};
const PK = envFromFile(".env.local", "RELAYER_PRIVATE_KEY");
const provider = new ethers.JsonRpcProvider("https://rpc.xlayer.tech");
const wallet = new ethers.Wallet(PK, provider);
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAY_TO = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";
const URL = "https://q402.quackai.ai/api/a2mcp/request";
const domain = { name: "USD₮0", version: "1", chainId: 196, verifyingContract: USDT };
const types = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const body = JSON.stringify({ chain: "base", token: "USDC", amount: "1.0", recipient: PAY_TO });

async function post(header) {
  const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header }, body });
  const txt = await res.text();
  let err; try { err = JSON.parse(txt).error; } catch {}
  return { status: res.status, err, hasPayResp: !!res.headers.get("payment-response") };
}
function mkAuth() {
  const now = Math.floor(Date.now() / 1000);
  return { from: wallet.address, to: PAY_TO, value: "100", validAfter: "0", validBefore: String(now + 300), nonce: ethers.hexlify(ethers.randomBytes(32)) };
}
const enc = (auth, signature) => Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "eip155:196", payload: { signature, authorization: auth } })).toString("base64");

// A) verify the earlier smoke tx
console.log("=== A. settlement tx 0xb731f5… ===");
const r = await provider.getTransactionReceipt("0xb731f5449dfe3fe48fa3cd6833709663c819ae5771c7b84b8c43127482093b5a");
console.log("  status:", r?.status, "| to(contract):", r?.to, "| ok:", r?.status === 1 && r?.to?.toLowerCase() === USDT);

// B) REPLAY
console.log("=== B. replay (same signed auth twice) ===");
const auth = mkAuth();
const sig = await wallet.signTypedData(domain, types, auth);
const h = enc(auth, sig);
const first = await post(h);
console.log("  1st:", first.status, first.status === 201 ? "settled+served" : first.err);
const second = await post(h);
console.log("  2nd:", second.status, second.err || "", "=> replay blocked:", second.status !== 201);

// C) FORGERY (tamper the signature -> off-chain reject, no tx)
console.log("=== C. forged signature ===");
const auth2 = mkAuth();
const goodSig = await wallet.signTypedData(domain, types, auth2);
const badSig = goodSig.slice(0, -4) + "dead"; // corrupt last bytes
const forged = await post(enc(auth2, badSig));
console.log("  status:", forged.status, "| err:", forged.err, "=> rejected off-chain (400):", forged.status === 400);
