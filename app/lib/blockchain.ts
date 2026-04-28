import { ethers } from "ethers";
import { SUBSCRIPTION_ADDRESS } from "./wallets";

// Subscription payment scanner target — where user pays $29/$49/$149 subscription.
const RELAYER = SUBSCRIPTION_ADDRESS;

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
  {
    name: "Mantle",
    rpcs: [
      "https://rpc.mantle.xyz",
      "https://mantle-rpc.publicnode.com",
    ],
    blockWindow: 2000,   // ~1.1 hours (2s block)
    tokens: [
      { symbol: "USDC", address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
      // USDT on Mantle = USDT0 OFT (0x779Ded...) per 2025-11 ecosystem migration.
      { symbol: "USDT", address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    ],
  },
  {
    name: "Injective",
    rpcs: [
      "https://sentry.evm-rpc.injective.network/",
      "https://1776.rpc.thirdweb.com",
    ],
    blockWindow: 1500,   // ~30 min (~1s effective block time on Injective EVM)
    // USDT only on Injective for now. Native CCTP USDC is announced for Q2 2026
    // — Q402 defers USDC integration until then to avoid the legacy/migration cycle
    // Mantle had to do for USDT0. The IBC-bridged USDC at 0x2a25fbD6... is not Q402-supported.
    tokens: [
      { symbol: "USDT", address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    ],
  },
];

/** Maps intent chain ids ("bnb","eth","avax","xlayer","stable","mantle","injective") to CHAINS[].name */
export const INTENT_CHAIN_MAP: Record<string, string> = {
  bnb:       "BNB Chain",
  eth:       "Ethereum",
  avax:      "Avalanche",
  xlayer:    "X Layer",
  stable:    "Stable",
  mantle:    "Mantle",
  injective: "Injective",
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

export type ScanCandidate = {
  txHash:      string;
  blockNumber: number;
  amountUSD:   number;
  token:       string;
  chain:       string;
  from:        string;
};

/**
 * Pick the best unused candidate from scanned Transfer events.
 *
 * "Best" = largest amount; ties broken by newest block. Already-consumed
 * tx hashes (those whose `used_txhash:{hash}` key is set in KV) are skipped.
 *
 * Why the skip matters: a wallet that pays the same tier twice — e.g.
 * the user's first $29 activation, then a refund-and-redo, or a top-up
 * for the same plan — produces multiple Transfer events of identical
 * amount in the scan window. Without the used-skip, the scanner would
 * deterministically keep returning the FIRST $29 it sees (event order is
 * chronological), which is the already-consumed one. The activate route's
 * `used_txhash` guard then rejects it, leaving the new on-chain payment
 * stuck even though it succeeded. Skipping at scan time makes the second
 * (and third, etc.) payment route to its own fresh hash.
 */
export async function selectBestUnusedCandidate(
  candidates: ScanCandidate[],
  isUsed:     (txHash: string) => Promise<boolean>,
): Promise<ScanCandidate | null> {
  let best: ScanCandidate | null = null;
  for (const c of candidates) {
    if (await isUsed(c.txHash)) continue;
    if (
      !best ||
      c.amountUSD > best.amountUSD ||
      (c.amountUSD === best.amountUSD && c.blockNumber > best.blockNumber)
    ) {
      best = c;
    }
  }
  return best;
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

  const candidates: ScanCandidate[] = [];
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
        candidates.push({
          txHash:      ev.transactionHash,
          blockNumber: ev.blockNumber,
          amountUSD:   amount,
          token:       token.symbol,
          chain:       chain.name,
          from:        (ev.args.from as string)?.toLowerCase() ?? fromAddress.toLowerCase(),
        });
      }
    } catch {
      // This token query failed on this RPC — continue to next token
    }
  }

  // If every token query failed (rate limit / error), throw so scanChain tries next RPC
  if (!anyQuerySucceeded) {
    throw new Error(`All token queries failed on ${rpc}`);
  }

  if (candidates.length === 0) return { found: false };

  const { kv } = await import("@vercel/kv");
  const winner = await selectBestUnusedCandidate(candidates, async (h) => {
    return Boolean(await kv.get(`used_txhash:${h}`));
  });

  if (!winner) return { found: false };
  return {
    found:     true,
    txHash:    winner.txHash,
    amountUSD: winner.amountUSD,
    token:     winner.token,
    chain:     winner.chain,
    from:      winner.from,
  };
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
export const TIER_CREDITS = [500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000];
export const TIER_PLANS   = ["starter", "basic", "growth", "pro", "scale", "business", "enterprise_flex"];

// calcPrice output per chain per tier (pre-computed from payment/page.tsx formula)
const CHAIN_THRESHOLDS: Record<string, number[]> = {
  //                  500  1K   5K    10K   50K   100K   300K
  "BNB Chain":  [  29,  49,  89,  149,  449,   799,  1999 ],
  "X Layer":    [  29,  49,  89,  149,  449,   799,  1999 ],
  "Stable":     [  29,  49,  89,  149,  449,   799,  1999 ],
  "Mantle":     [  29,  49,  89,  149,  449,   799,  1999 ],
  "Injective":  [  29,  49,  89,  149,  449,   799,  1999 ],
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
 * Pass "BNB Chain" when the amount has already been normalized to BNB-equivalent
 * (see toBnbEquivUSD below) for cumulative tier checks across multi-chain payments.
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

// ── Cumulative tier helpers (v1.18) ────────────────────────────────────────
// The activate route uses these to let users reach a higher tier by paying
// more within an active 30-day window. Payments on non-BNB chains cost more
// nominal USD (AVAX 1.1×, ETH 1.5×) but represent the same "value"; we
// normalize to BNB-equivalent so cumulative thresholds are fair.

const CHAIN_MULTIPLIERS: Record<string, number> = {
  "BNB Chain": 1.0,
  "X Layer":   1.0,
  "Stable":    1.0,
  "Mantle":    1.0,
  "Injective": 1.0,
  "Avalanche": 1.1,
  "Ethereum":  1.5,
};

/**
 * Convert a raw payment USD to BNB-equivalent USD by dividing out the chain's
 * price multiplier. Used to sum cross-chain payments against BNB-base tier
 * thresholds.
 */
export function toBnbEquivUSD(usd: number, chain?: string): number {
  if (!chain) return usd;
  const m = CHAIN_MULTIPLIERS[chain] ?? 1.0;
  return m > 0 ? usd / m : usd;
}

/**
 * Rank of a plan tier (higher = better). Unknown / null = -1.
 */
export function tierRank(plan: string | null | undefined): number {
  if (!plan) return -1;
  return TIER_PLANS.indexOf(plan.toLowerCase());
}

/**
 * Return the higher-ranked of two tiers. Null-safe.
 */
export function maxTier(a: string | null | undefined, b: string | null | undefined): string | null {
  const ra = tierRank(a);
  const rb = tierRank(b);
  if (ra < 0 && rb < 0) return null;
  return ra >= rb ? (a ?? null) : (b ?? null);
}
