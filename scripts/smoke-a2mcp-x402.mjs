// End-to-end smoke: pay the x402 fee (real on-chain USD₮0 transferWithAuthorization
// on X Layer) and hit the prod /api/a2mcp/request endpoint. Self-pay (0xfc77 ->
// 0xfc77, 100 atomic) so it moves net-zero but exercises the FULL settle path.
// Loads RELAYER_PRIVATE_KEY from .env.local; never prints it.
import { ethers } from "ethers";
import fs from "node:fs";

function envFromFile(path, key) {
  const txt = fs.readFileSync(path, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
  }
  return null;
}

const PK = envFromFile(".env.local", "RELAYER_PRIVATE_KEY");
if (!PK) { console.log("RELAYER_PRIVATE_KEY not found in .env.local"); process.exit(1); }

const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAY_TO = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";
const wallet = new ethers.Wallet(PK);
console.log("payer/relayer:", wallet.address, "(expect 0xfc77…f466)");

const now = Math.floor(Date.now() / 1000);
const auth = {
  from: wallet.address,
  to: PAY_TO,
  value: "100",                 // 0.0001 USDT (6 dp)
  validAfter: "0",
  validBefore: String(now + 300),
  nonce: ethers.hexlify(ethers.randomBytes(32)),
};
const domain = { name: "USD₮0", version: "1", chainId: 196, verifyingContract: USDT };
const types = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
]};
const signature = await wallet.signTypedData(domain, types, auth);

const paymentPayload = { x402Version: 1, scheme: "exact", network: "eip155:196", payload: { signature, authorization: auth } };
const header = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

const res = await fetch("https://q402.quackai.ai/api/a2mcp/request", {
  method: "POST",
  headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
  body: JSON.stringify({ chain: "base", token: "USDC", amount: "1.0", recipient: PAY_TO, memo: "x402 smoke" }),
});
console.log("HTTP", res.status);
const payResp = res.headers.get("payment-response");
console.log("PAYMENT-RESPONSE:", payResp ? Buffer.from(payResp, "base64").toString("utf8") : "(none)");
const body = await res.text();
console.log("body:", body.slice(0, 400));
