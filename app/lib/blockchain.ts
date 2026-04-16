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
  /** Sender address (lowercase) — used by activate to verify intent.address === TX sender */
  from?: string;
}

// ── Chain configs ──────────────────────────────────────────────────────────────
// Each chain: public RPC(s) + USDC + USDT addresses + block scan window
// rpcs: tried in order; first success wins
const CHAINS = [
  {
    name: "BNB Chain",
    rpcs: [
      "https://bsc.publicnode.com",
      "https://rpc.ankr.com/bsc",
      "https://bsc-dataseed2.binance.org/",
      "https://bsc-dataseed3.binance.org/",
      "https://bsc-dataseed4.binance.org/",
    ],
    blockWindow: 8000,   // ~7 hours (3s block)
    tokens: [
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    ],
  },
  {
    name: "Ethereum",
    rpcs: [
      "https://ethereum.publicnode.com",
      "https://rpc.ankr.com/eth",
      "https://eth.llamarpc.com",
    ],
    blockWindow: 500,    // ~1.7 hours (12s block)
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    ],
  },
  {
    name: "Avalanche",
    rpcs: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://rpc.ankr.com/avalanche",
      "https://avalanche.publicnode.com/ext/bc/C/rpc",
    ],
    blockWindow: 2000,   // ~1.1 hours (2s block)
    tokens: [
      { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
      { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    ],
  },
  {
    name: "X Layer",
    rpcs: [
      "https://rpc.xlayer.tech",
      "https://xlayerrpc.okx.com",
    ],
    blockWindow: 3000,   // ~1.7 hours (2s block)
    tokens: [
      { symbol: "USDC", address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
      { symbol: "USDT", address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
    ],
  },
  {
    name: "Stable",
    rpcs: [
      "https://rpc.stable.xyz",
    ],
    blockWindow: 5000,   // ~1 hour (0.7s block)
    tokens: [
      { symbol: "USDT0", address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    ],
  },
];

/** Maps intent chain ids ("bnb","eth","avax","xlayer","stable") to CHAINS[].name */
const INTENT_CHAIN_MAP: Record<string, string> = {
  bnb:    "BNB Chain",
  eth:    "Ethereum",
  avax:   "Avalanche",
  xlayer: "X Layer",
  stable: "Stable",
};

/**
 * Scan supported chains for USDC/USDT transfer from `fromAddress` to relayer.
 * If `intentChain` is provided (e.g. "bnb"), only that chain is scanned.
 * Checks remaining chains in parallel; returns the largest payment found.
 */
export async function checkPaymentOnChain(fromAddress: string, intentChain?: string): Promise<PaymentResult> {
  const targetName = intentChain ? INTENT_CHAIN_MAP[intentChain] : undefined;
  const chainsToScan = targetName ? CHAINS.filter(c => c.name === targetName) : CHAINS;

  const results = await Promise.allSettled(
    chainsToScan.map(chain => scanChain(chain, fromAddress))
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
  // Try each RPC in order; first one that fully succeeds wins
  for (const rpc of chain.rpcs) {
    try {
      const result = await scanChainWithRpc(chain, rpc, fromAddress);
      return result;
    } catch {
      // This RPC failed entirely — try next
    }
  }
  return { found: false };
}

async function scanChainWithRpc(
  chain: typeof CHAINS[number],
  rpc: string,
  fromAddress: string
): Promise<PaymentResult> {
  const provider = new ethers.JsonRpcProvider(rpc);

  const currentBlock = await Promise.race([
    provider.getBlockNumber(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("getBlockNumber timeout")), 8000)),
  ]);
  const fromBlock = currentBlock - chain.blockWindow;

  let best: PaymentResult = { found: false };
  let anyQuerySucceeded = false;

  for (const token of chain.tokens) {
    const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
    const filter = contract.filters.Transfer(fromAddress, RELAYER);
    try {
      const events = await Promise.race([
        contract.queryFilter(filter, fromBlock, currentBlock),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("queryFilter timeout")), 12000)),
      ]);
      anyQuerySucceeded = true;
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
            from: (ev.args.from as string)?.toLowerCase() ?? fromAddress.toLowerCase(),
          };
        }
      }
    } catch {
      // This token query failed on this RPC — continue to next token
    }
  }

  // If every token query failed (rate limit / error), throw so scanChain tries next RPC
  if (!anyQuerySucceeded) {
    throw new Error(`All token queries failed on ${rpc}`);
  }

  return best;
}

/**
 * Verify a specific TX hash — no block window dependency.
 * Checks that the TX is a USDC/USDT transfer from `fromAddress` to the relayer.
 */
export async function verifyPaymentTx(txHash: string, fromAddress: string): Promise<PaymentResult> {
  // Try BNB first (most common), then Ethereum, then others
  for (const chain of CHAINS) {
    for (const rpc of chain.rpcs) {
      try {
        const provider = new ethers.JsonRpcProvider(rpc);
        const receipt = await Promise.race([
          provider.getTransactionReceipt(txHash),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ]);
        if (!receipt) continue;

        for (const token of chain.tokens) {
          const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
          const filter = contract.filters.Transfer(fromAddress, RELAYER);
          const events = await Promise.race([
            contract.queryFilter(filter, receipt.blockNumber, receipt.blockNumber),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
          ]);
          for (const ev of events) {
            if (ev.transactionHash.toLowerCase() !== txHash.toLowerCase()) continue;
            if (!("args" in ev)) continue;
            const amount = Number(ethers.formatUnits(ev.args.value, token.decimals));
            return {
              found: true,
              txHash: ev.transactionHash,
              amountUSD: amount,
              token: token.symbol,
              chain: chain.name,
              from: (ev.args.from as string)?.toLowerCase() ?? fromAddress.toLowerCase(),
            };
          }
        }
        break; // receipt found on this chain — no need to try other chains
      } catch {
        // try next RPC
      }
    }
  }
  return { found: false };
}

// ── Chain-aware pricing ────────────────────────────────────────────────────────
// Mirrors calcPrice() in payment/page.tsx: Math.round(basePrice * multiplier / 10) * 10
// Thresholds = calcPrice - 1  (floor that any correct payment comfortably exceeds)
//
// Tier order: [500tx, 1K, 5K, 10K, 50K, 100K, 300K]
const TIER_CREDITS = [500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000];
const TIER_PLANS   = ["starter", "basic", "growth", "pro", "scale", "business", "enterprise_flex"];

// calcPrice output per chain per tier (pre-computed from payment/page.tsx formula)
const CHAIN_THRESHOLDS: Record<string, number[]> = {
  //                  500  1K   5K    10K   50K   100K   300K
  "BNB Chain":  [  29,  49,  89,  149,  449,   799,  1999 ],
  "X Layer":    [  29,  49,  89,  149,  449,   799,  1999 ],
  "Stable":     [  29,  49,  89,  149,  449,   799,  1999 ],
  "Avalanche":  [  29,  49,  99,  159,  489,   879,  2199 ],
  "Ethereum":   [  39,  69, 129,  219,  669,  1199,  2999 ],
};
// Fallback = cheapest chain (BNB)
const DEFAULT_THRESHOLDS = CHAIN_THRESHOLDS["BNB Chain"];

function getThresholds(chain?: string): number[] {
  if (!chain) return DEFAULT_THRESHOLDS;
  return CHAIN_THRESHOLDS[chain] ?? DEFAULT_THRESHOLDS;
}

/**
 * Returns the plan tier for the given payment.
 * Chain name comes from checkPaymentOnChain().chain (e.g. "Ethereum", "BNB Chain").
 * First payment only — subsequent payments don't change the plan.
 */
export function planFromAmount(usd: number, chain?: string): string | null {
  const t = getThresholds(chain);
  for (let i = TIER_PLANS.length - 1; i >= 0; i--) {
    if (usd >= t[i]) return TIER_PLANS[i];
  }
  return null;
}

/**
 * Returns TX credits granted for this payment amount on this chain.
 * Used for both initial activation and top-up purchases.
 */
export function txQuotaFromAmount(usd: number, chain?: string): number {
  const t = getThresholds(chain);
  for (let i = TIER_CREDITS.length - 1; i >= 0; i--) {
    if (usd >= t[i]) return TIER_CREDITS[i];
  }
  return 0;
}
