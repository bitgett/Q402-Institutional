#!/usr/bin/env node
/**
 * probe-balance.mjs — replicate fetchAgenticBalances against a known
 * Agent Wallet address so we can see what the route would return.
 *
 * Usage: node scripts/probe-balance.mjs <walletAddr>
 */

import {
  createPublicClient,
  http,
  getAddress,
} from "viem";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const CHAINS = {
  bnb:       { id: 56,     name: "BNB Chain",   rpc: "https://bsc-dataseed.binance.org",        usdc: ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18], usdt: ["0x55d398326f99059fF775485246999027B3197955", 18] },
  eth:       { id: 1,      name: "Ethereum",    rpc: "https://ethereum.publicnode.com",         usdc: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6],  usdt: ["0xdAC17F958D2ee523a2206206994597C13D831ec7", 6]  },
  avax:      { id: 43114,  name: "Avalanche",   rpc: "https://api.avax.network/ext/bc/C/rpc",   usdc: ["0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", 6],  usdt: ["0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", 6]  },
  xlayer:    { id: 196,    name: "X Layer",     rpc: "https://rpc.xlayer.tech",                 usdc: ["0x74b7F16337b8972027F6196A17a631aC6dE26d22", 6],  usdt: ["0x1E4a5963aBFD975d8c9021ce480b42188849D41d", 6]  },
  stable:    { id: 988,    name: "Stable",      rpc: "https://rpc.stable.xyz",                  usdc: ["0x779ded0c9e1022225f8e0630b35a9b54be713736", 18], usdt: ["0x779ded0c9e1022225f8e0630b35a9b54be713736", 18] },
  mantle:    { id: 5000,   name: "Mantle",      rpc: "https://rpc.mantle.xyz",                  usdc: ["0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", 6],  usdt: ["0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", 6]  },
  injective: { id: 1776,   name: "Injective",   rpc: "https://sentry.evm-rpc.injective.network/", usdc: ["0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", 6], usdt: ["0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", 6] },
  monad:     { id: 143,    name: "Monad",       rpc: "https://rpc.monad.xyz",                   usdc: ["0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6],  usdt: ["0xe7cd86e13AC4309349F30B3435a9d337750fC82D", 6]  },
  scroll:    { id: 534352, name: "Scroll",      rpc: "https://rpc.scroll.io",                   usdc: ["0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", 6],  usdt: ["0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", 6]  },
  arbitrum:  { id: 42161,  name: "Arbitrum",    rpc: "https://arb1.arbitrum.io/rpc",            usdc: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6],  usdt: ["0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6]  },
};

function rawToUsd(raw, decimals) {
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(raw / divisor);
  const frac = Number(raw % divisor) / Number(divisor);
  return whole + frac;
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

async function readChain(name, cfg, addr) {
  const viemChain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  };
  const client = createPublicClient({ chain: viemChain, transport: http(cfg.rpc, { timeout: 8000 }) });
  const sameToken = cfg.usdc[0].toLowerCase() === cfg.usdt[0].toLowerCase();
  try {
    if (sameToken) {
      const raw = await client.readContract({ address: cfg.usdt[0], abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
      return { chain: name, usdt: { raw: raw.toString(), usd: rawToUsd(raw, cfg.usdt[1]) }, usdc: null };
    }
    const results = await client.multicall({
      contracts: [
        { address: cfg.usdc[0], abi: ERC20_ABI, functionName: "balanceOf", args: [addr] },
        { address: cfg.usdt[0], abi: ERC20_ABI, functionName: "balanceOf", args: [addr] },
      ],
      allowFailure: true,
    });
    const usdcRaw = results[0].status === "success" ? results[0].result : null;
    const usdtRaw = results[1].status === "success" ? results[1].result : null;
    return {
      chain: name,
      usdc: usdcRaw !== null ? { raw: usdcRaw.toString(), usd: rawToUsd(usdcRaw, cfg.usdc[1]) } : { error: String(results[0].error?.shortMessage ?? "usdc_fail") },
      usdt: usdtRaw !== null ? { raw: usdtRaw.toString(), usd: rawToUsd(usdtRaw, cfg.usdt[1]) } : { error: String(results[1].error?.shortMessage ?? "usdt_fail") },
    };
  } catch (e) {
    return { chain: name, error: e?.shortMessage ?? e?.message ?? String(e) };
  }
}

const walletAddr = process.argv[2];
if (!walletAddr) { console.error("usage: node scripts/probe-balance.mjs <0x address>"); process.exit(1); }
const addr = getAddress(walletAddr);

console.log(`Probing balance for ${addr} across 11 chains...\n`);
const perChain = await Promise.all(Object.entries(CHAINS).map(([n, c]) => readChain(n, c, addr)));
let total = 0;
for (const c of perChain) {
  if (c.error) { console.log(`  ${c.chain.padEnd(10)} ERROR: ${c.error}`); continue; }
  const usdc = c.usdc?.usd ?? 0;
  const usdt = c.usdt?.usd ?? 0;
  total += usdc + usdt;
  const usdcStr = c.usdc?.usd !== undefined ? `USDC $${c.usdc.usd.toFixed(6)}` : `USDC ${c.usdc?.error ?? "—"}`;
  const usdtStr = c.usdt?.usd !== undefined ? `USDT $${c.usdt.usd.toFixed(6)}` : `USDT ${c.usdt?.error ?? "—"}`;
  if ((usdc + usdt) > 0) console.log(`  ${c.chain.padEnd(10)} ${usdcStr.padEnd(28)} ${usdtStr}`);
  else                   console.log(`  ${c.chain.padEnd(10)} (empty) ${usdcStr.padEnd(28)} ${usdtStr}`);
}
console.log(`\n  TOTAL: $${total.toFixed(6)}`);
