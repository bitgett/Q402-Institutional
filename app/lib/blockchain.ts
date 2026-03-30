import { ethers } from "ethers";

const RELAYER = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export interface PaymentResult {
  found: boolean;
  txHash?: string;
  amountUSD?: number;
  token?: string;
  chain?: string;
}

// ── Chain configs ──────────────────────────────────────────────────────────────
// Each chain: public RPC + USDC + USDT addresses + block scan window
const CHAINS = [
  {
    name: "BNB Chain",
    rpc: "https://bsc-dataseed1.binance.org/",
    blockWindow: 2000,   // ~1.7 hours (3s block)
    tokens: [
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    ],
  },
  {
    name: "Ethereum",
    rpc: "https://ethereum.publicnode.com",
    blockWindow: 500,    // ~1.7 hours (12s block)
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    ],
  },
  {
    name: "Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    blockWindow: 2000,   // ~1.1 hours (2s block)
    tokens: [
      { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
      { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    ],
  },
  {
    name: "X Layer",
    rpc: "https://rpc.xlayer.tech",
    blockWindow: 3000,   // ~1.7 hours (2s block)
    tokens: [
      { symbol: "USDC", address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
      { symbol: "USDT", address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
    ],
  },
  {
    name: "Stable",
    rpc: "https://rpc.stable.xyz",
    blockWindow: 5000,   // ~1 hour (0.7s block)
    tokens: [
      { symbol: "USDT0", address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    ],
  },
];

/**
 * Scan all supported chains for USDC/USDT transfer from `fromAddress` to relayer.
 * Checks chains in parallel; returns the first (largest) payment found.
 */
export async function checkPaymentOnChain(fromAddress: string): Promise<PaymentResult> {
  const results = await Promise.allSettled(
    CHAINS.map(chain => scanChain(chain, fromAddress))
  );

  let best: PaymentResult = { found: false };
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.found) {
      if (!best.found || (r.value.amountUSD ?? 0) > (best.amountUSD ?? 0)) {
        best = r.value;
      }
    }
  }
  return best;
}

async function scanChain(
  chain: typeof CHAINS[number],
  fromAddress: string
): Promise<PaymentResult> {
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - chain.blockWindow;

  let best: PaymentResult = { found: false };

  for (const token of chain.tokens) {
    const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
    const filter = contract.filters.Transfer(fromAddress, RELAYER);
    try {
      const events = await contract.queryFilter(filter, fromBlock, currentBlock);
      for (const ev of events) {
        if (!("args" in ev)) continue;
        const amount = Number(ethers.formatUnits(ev.args.value, token.decimals));
        if (!best.found || amount > (best.amountUSD ?? 0)) {
          best = {
            found: true,
            txHash: ev.transactionHash,
            amountUSD: amount,
            token: token.symbol,
            chain: chain.name,
          };
        }
      }
    } catch {
      // RPC timeout or error — skip this token
    }
  }
  return best;
}

// Map USD amount to plan
// Thresholds = payment/page.tsx VOLUMES basePrice (BNB 1.0x = cheapest chain)
//   starter       : $29   (500 txs)
//   basic         : $49   (1,000 txs)
//   growth        : $89   (5,000 txs)
//   pro           : $149  (10,000 txs)
//   scale         : $449  (50,000 txs)
//   business      : $799  (100,000 txs)
//   enterprise_flex: $1,999 (100K–500K txs)
export function planFromAmount(usd: number): string | null {
  if (usd >= 1999) return "enterprise_flex";
  if (usd >= 799)  return "business";
  if (usd >= 449)  return "scale";
  if (usd >= 149)  return "pro";
  if (usd >= 89)   return "growth";
  if (usd >= 49)   return "basic";
  if (usd >= 29)   return "starter";
  return null;
}
