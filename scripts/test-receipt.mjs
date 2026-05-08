/**
 * test-receipt.mjs — End-to-end Trust Receipt smoke test against production.
 *
 *   node scripts/test-receipt.mjs --chain <bnb|avax|eth|xlayer|stable|mantle|injective> \
 *                                 [--token USDC|USDT] [--amount 0.10] [--to 0x...]
 *
 * Unlike test-eip7702.mjs (which broadcasts the Type-4 TX directly to the
 * chain RPC, bypassing Q402), this script POSTs to q402.quackai.ai/api/relay
 * so the canonical settlement path runs end-to-end:
 *
 *   payer signs TransferAuthorization + EIP-7702 authorization
 *     → POST /api/relay
 *     → Q402 broadcasts the Type-4 TX, charges its gas tank
 *     → Q402 creates a Trust Receipt + signs it with RELAYER_PRIVATE_KEY
 *     → response includes receiptId + receiptUrl
 *
 * Use this as the demo-asset producer: the receiptUrl it prints is a real,
 * publicly-shareable receipt page anchored to a real on-chain TX.
 *
 * Required .env.local:
 *   TEST_PAYER_KEY      — payer (token owner) private key, with USDC/USDT
 *                         on the chosen chain
 *   Q402_API_KEY        — your q402_live_… key
 *
 * Optional:
 *   Q402_RELAY_BASE     — defaults to https://q402.quackai.ai
 */

import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const envVars = Object.fromEntries(
  readFileSync(resolve(__dir, "../.env.local"), "utf-8")
    .split("\n").filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
    .filter(p => p[0])
);

const PAYER_KEY    = envVars.TEST_PAYER_KEY;
const Q402_API_KEY = envVars.Q402_API_KEY;
const RELAY_BASE   = envVars.Q402_RELAY_BASE ?? "https://q402.quackai.ai";

if (!PAYER_KEY)    { console.error("Missing TEST_PAYER_KEY in .env.local"); process.exit(1); }
if (!Q402_API_KEY) { console.error("Missing Q402_API_KEY in .env.local");    process.exit(1); }

// ── CLI args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith("--") ? [[a.slice(2), arr[i + 1]]] : []
  )
);
const chainKey = args.chain;
const tokenSym = (args.token ?? "USDC").toUpperCase();
const amountIn = args.amount ?? "0.10";
const toArg    = args.to;
const noOpen   = process.argv.includes("--no-open");

// Cross-platform "open this URL in the default browser". Skip silently if
// not supported (CI / headless environments).
function openInBrowser(url) {
  const cmd = process.platform === "win32"  ? `start "" "${url}"`
           :  process.platform === "darwin" ? `open "${url}"`
           :                                  `xdg-open "${url}"`;
  exec(cmd, () => { /* best-effort; ignore failures */ });
}

// ANSI 8 hyperlink escape — clickable in Windows Terminal / iTerm2 /
// VS Code terminal, falls back to plain text in dumb terminals.
function clickable(url, label = url) {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

// ── Chain config (mirrors public/q402-sdk.js Q402_CHAIN_CONFIG) ────────────────
const CHAINS = {
  bnb: {
    id: 56, name: "BNB Chain", domainName: "Q402 BNB Chain",
    rpc: "https://bsc-dataseed1.binance.org/",
    impl: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    USDC: { addr: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    USDT: { addr: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  },
  avax: {
    id: 43114, name: "Avalanche", domainName: "Q402 Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    impl: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    USDC: { addr: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    USDT: { addr: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
  },
  eth: {
    id: 1, name: "Ethereum", domainName: "Q402 Ethereum",
    rpc: "https://ethereum.publicnode.com",
    impl: "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    USDC: { addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    USDT: { addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  },
  xlayer: {
    id: 196, name: "X Layer", domainName: "Q402 X Layer",
    rpc: "https://rpc.xlayer.tech",
    impl: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    USDC: { addr: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
    USDT: { addr: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
  },
  stable: {
    id: 988, name: "Stable", domainName: "Q402 Stable",
    rpc: "https://rpc.stable.xyz",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    USDC: { addr: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    USDT: { addr: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
  },
  mantle: {
    id: 5000, name: "Mantle", domainName: "Q402 Mantle",
    rpc: "https://rpc.mantle.xyz",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    USDC: { addr: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
    USDT: { addr: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
  },
  injective: {
    id: 1776, name: "Injective", domainName: "Q402 Injective",
    rpc: "https://sentry.evm-rpc.injective.network/",
    impl: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    USDT: { addr: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
  },
};

if (!chainKey || !CHAINS[chainKey]) {
  console.error(`Usage: node scripts/test-receipt.mjs --chain <${Object.keys(CHAINS).join("|")}> [--token USDC|USDT] [--amount N] [--to 0x...]`);
  process.exit(1);
}
const cfg      = CHAINS[chainKey];
const tokenCfg = cfg[tokenSym];
if (!tokenCfg) {
  console.error(`Token ${tokenSym} not supported on ${chainKey}. Available: ${Object.keys(cfg).filter(k => k === "USDC" || k === "USDT").join(", ")}`);
  process.exit(1);
}

const TRANSFER_AUTH_TYPES = {
  TransferAuthorization: [
    { name: "owner",       type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token",       type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "uint256" },
    { name: "deadline",    type: "uint256" },
  ],
};

async function main() {
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const payer    = new ethers.Wallet(PAYER_KEY.startsWith("0x") ? PAYER_KEY : `0x${PAYER_KEY}`, provider);

  // ── 1. Fetch facilitator (Q402 relayer) address ───────────────────────────────
  console.log("=".repeat(60));
  console.log(`Q402 Trust Receipt smoke test — ${cfg.name} / ${tokenSym}`);
  console.log("=".repeat(60));
  console.log(`Payer:        ${payer.address}`);
  console.log(`Token:        ${tokenSym} (${tokenCfg.addr})`);
  console.log(`Amount:       ${amountIn} ${tokenSym}`);
  console.log(`Relay base:   ${RELAY_BASE}\n`);

  const infoResp = await fetch(`${RELAY_BASE}/api/relay/info`);
  if (!infoResp.ok) { console.error("Failed to fetch /api/relay/info"); process.exit(1); }
  const { facilitator } = await infoResp.json();
  console.log(`Facilitator:  ${facilitator}`);

  const recipient  = toArg ?? facilitator;
  const amountRaw  = ethers.parseUnits(amountIn, tokenCfg.decimals);
  const deadline   = BigInt(Math.floor(Date.now() / 1000) + 600);
  const paymentNonce = ethers.toBigInt(ethers.randomBytes(32));

  console.log(`Recipient:    ${recipient}\n`);

  // ── 2. EIP-712 TransferAuthorization signature ────────────────────────────────
  console.log("[1/3] Signing TransferAuthorization (EIP-712)...");
  const witnessSig = await payer.signTypedData(
    {
      name:              cfg.domainName,
      version:           "1",
      chainId:           cfg.id,
      verifyingContract: payer.address,    // EIP-7702 delegation: address(this) = payer EOA
    },
    TRANSFER_AUTH_TYPES,
    {
      owner:       payer.address,
      facilitator,
      token:       tokenCfg.addr,
      recipient,
      amount:      amountRaw,
      nonce:       paymentNonce,
      deadline,
    },
  );
  console.log(`        ${witnessSig.slice(0, 30)}...`);

  // ── 3. EIP-7702 authorization (real spec hash via ethers Wallet.authorize) ───
  console.log("[2/3] Signing EIP-7702 authorization...");
  const payerNonce = await provider.getTransactionCount(payer.address);
  const auth = await payer.authorize({
    chainId: cfg.id,
    address: cfg.impl,
    nonce:   payerNonce,
  });
  // ethers v6.13+: auth.signature has yParity / r / s
  const authorization = {
    chainId: Number(auth.chainId),
    address: auth.address,
    nonce:   Number(auth.nonce),
    yParity: auth.signature.yParity,
    r:       auth.signature.r,
    s:       auth.signature.s,
  };
  console.log(`        nonce=${authorization.nonce}, yParity=${authorization.yParity}`);

  // ── 4. POST /api/relay ────────────────────────────────────────────────────────
  console.log("[3/3] POST /api/relay ...\n");
  const body = {
    apiKey:        Q402_API_KEY,
    chain:         chainKey,
    token:         tokenSym,
    from:          payer.address,
    to:            recipient,
    amount:        amountRaw.toString(),
    deadline:      Number(deadline),
    nonce:         paymentNonce.toString(),
    witnessSig,
    authorization,
    facilitator,
  };

  const resp = await fetch(`${RELAY_BASE}/api/relay`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await resp.json();

  console.log("=".repeat(60));
  if (!resp.ok) {
    console.error(`HTTP ${resp.status} — relay rejected`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log("RELAY SUCCESS");
  console.log("=".repeat(60));
  console.log(JSON.stringify(data, null, 2));
  console.log();

  if (data.receiptUrl) {
    console.log("📜 Trust Receipt:");
    console.log(`   ${clickable(data.receiptUrl)}`);
    console.log();
    if (noOpen) {
      console.log("   (--no-open passed; not opening browser)");
    } else {
      console.log("   Opening in your default browser…");
      openInBrowser(data.receiptUrl);
    }
  } else {
    console.warn("⚠ Response did not include receiptUrl. Receipt creation may have");
    console.warn("  failed inline; the cron backfill will pick it up. Check");
    console.warn(`  ${RELAY_BASE}/api/cron/receipt-backfill (auth-gated) for queue state.`);
  }
}

main().catch(e => { console.error("Error:", e.message ?? e); process.exit(1); });
