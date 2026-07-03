import { ethers } from "ethers";
import { SUBSCRIPTION_ADDRESS } from "./wallets";

// Subscription payment scanner target — where user pays $29/$49/$149 subscription.
// Named SUBSCRIPTION (was historically misleadingly RELAYER from the v1.16 split).
// Always reflects the SUBSCRIPTION_ADDRESS constant (a 2-of-3 Safe multisig since
// v1.25); never name-shadowed by anything else in this module.
const SUBSCRIPTION = SUBSCRIPTION_ADDRESS;

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export interface PaymentResult {
  found: boolean;
  txHash?: string;
  amountUSD?: number;
  /** Q payments only: the raw Q amount transferred (18-dec, human units). Q is
   *  NOT a 1:1-USD stablecoin, so its gating is done on qAmount vs the intent's
   *  locked quotedQAmount, never on amountUSD. */
  qAmount?: number;
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
      { symbol: "USDC",  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT",  address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
      // Ripple USD (RLUSD) — NY DFS regulated. Ethereum-only. UUPS proxy.
      { symbol: "RLUSD", address: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD", decimals: 18 },
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
    // Injective supports native Circle USDC (CCTP, live since 2026-06) + USDT, both 6 dec.
    tokens: [
      { symbol: "USDC", address: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", decimals: 6 },
      { symbol: "USDT", address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6 },
    ],
  },
  {
    name: "Monad",
    rpcs: [
      "https://rpc.monad.xyz",
      "https://rpc1.monad.xyz",
      "https://rpc2.monad.xyz",
    ],
    blockWindow: 6000,   // Monad ~0.5s block, ~50 min window
    // Native Circle USDC via CCTP V2 + USDT0 (LayerZero OFT, same family as Mantle).
    tokens: [
      { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
      { symbol: "USDT", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6 },
    ],
  },
  {
    name: "Scroll",
    rpcs: [
      "https://rpc.scroll.io",
      "https://scroll-mainnet.public.blastapi.io",
      "https://scroll.drpc.org",
    ],
    blockWindow: 1200,   // Scroll ~3s block, ~60 min window
    // Native Circle USDC + canonical Tether on Scroll mainnet (addresses
    // confirmed with Scroll team), both 6 decimals.
    tokens: [
      { symbol: "USDC", address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6 },
      { symbol: "USDT", address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6 },
    ],
  },
  {
    name: "Arbitrum",
    rpcs: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.publicnode.com",
      "https://arbitrum.drpc.org",
    ],
    blockWindow: 5000,   // Arbitrum ~0.25s block, ~21 min window
    // Native Circle USDC (CCTP) + canonical Tether on Arbitrum One. The legacy
    // bridged USDC.e (0xFF970A61...) is NOT supported.
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    ],
  },
  {
    name: "Base",
    rpcs: [
      "https://mainnet.base.org",
      "https://base.publicnode.com",
      "https://base.drpc.org",
    ],
    blockWindow: 900,    // Base ~2s block, ~30 min window
    // Native Circle USDC + bridged Tether USD on Base, both 6 decimals.
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    ],
  },
];

/** Maps intent chain ids ("bnb","eth","avax","xlayer","stable","mantle","injective","monad","scroll","arbitrum","base") to CHAINS[].name */
export const INTENT_CHAIN_MAP: Record<string, string> = {
  bnb:       "BNB Chain",
  eth:       "Ethereum",
  avax:      "Avalanche",
  xlayer:    "X Layer",
  stable:    "Stable",
  mantle:    "Mantle",
  injective: "Injective",
  monad:     "Monad",
  scroll:    "Scroll",
  arbitrum:  "Arbitrum",
  base:      "Base",
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
    const filter = contract.filters.Transfer(fromAddress, SUBSCRIPTION);
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
          const filter = contract.filters.Transfer(fromAddress, SUBSCRIPTION);
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

// ── Q (QuackAI token) subscription payments ────────────────────────────────
// Q is a BNB-only ERC-20 (18 dec), NOT a 1:1-USD stablecoin, so it gets a
// DEDICATED scan path — adding Q to the CHAINS token list would let a large Q
// transfer dominate the stablecoin "largest amountUSD wins" candidate selection
// and hijack a normal USDC/USDT activation. The intent locks the exact Q amount
// (priced off the 30-min TWAP), and activate gates on qAmount vs that locked
// value, so no USD is re-derived on-chain here.
const Q_TOKEN = { symbol: "Q", address: "0xc07e1300dc138601FA6B0b59f8D0FA477e690589", decimals: 18 } as const;
const Q_BNB = CHAINS.find((c) => c.name === "BNB Chain")!;
function scanTimeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

/** Verify a specific tx is a Q transfer from `fromAddress` to the subscription
 *  Safe on BNB. Returns qAmount (raw Q, human units); no USD conversion. */
export async function verifyQPaymentTx(txHash: string, fromAddress: string): Promise<PaymentResult> {
  for (const rpc of Q_BNB.rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const receipt = await Promise.race([provider.getTransactionReceipt(txHash), scanTimeout(8000)]);
      if (!receipt) continue;
      const contract = new ethers.Contract(Q_TOKEN.address, ERC20_ABI, provider);
      const filter = contract.filters.Transfer(fromAddress, SUBSCRIPTION);
      const events = await Promise.race([
        contract.queryFilter(filter, receipt.blockNumber, receipt.blockNumber),
        scanTimeout(8000),
      ]);
      for (const ev of events) {
        if (ev.transactionHash.toLowerCase() !== txHash.toLowerCase()) continue;
        if (!("args" in ev)) continue;
        const qAmount = Number(ethers.formatUnits(ev.args.value, Q_TOKEN.decimals));
        return {
          found: true,
          txHash: ev.transactionHash,
          qAmount,
          token: "Q",
          chain: "BNB Chain",
          from: (ev.args.from as string)?.toLowerCase() ?? fromAddress.toLowerCase(),
        };
      }
      break; // receipt found on BNB — done
    } catch {
      // try next RPC
    }
  }
  return { found: false };
}

/** Block-window scan for the best unused Q transfer from `fromAddress` to the
 *  subscription Safe on BNB (fallback when the client can't supply a txHash). */
export async function checkQPaymentOnChain(fromAddress: string): Promise<PaymentResult> {
  for (const rpc of Q_BNB.rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const currentBlock = await Promise.race([provider.getBlockNumber(), scanTimeout(8000)]);
      const fromBlock = currentBlock - Q_BNB.blockWindow;
      const contract = new ethers.Contract(Q_TOKEN.address, ERC20_ABI, provider);
      const filter = contract.filters.Transfer(fromAddress, SUBSCRIPTION);
      const events = await Promise.race([contract.queryFilter(filter, fromBlock, currentBlock), scanTimeout(12000)]);
      const candidates: ScanCandidate[] = [];
      for (const ev of events) {
        if (!("args" in ev)) continue;
        candidates.push({
          txHash: ev.transactionHash,
          blockNumber: ev.blockNumber,
          amountUSD: Number(ethers.formatUnits(ev.args.value, Q_TOKEN.decimals)), // Q amount, used only for "largest" selection
          token: "Q",
          chain: "BNB Chain",
          from: (ev.args.from as string)?.toLowerCase() ?? fromAddress.toLowerCase(),
        });
      }
      if (candidates.length === 0) return { found: false };
      const { kv } = await import("@vercel/kv");
      const winner = await selectBestUnusedCandidate(candidates, async (h) => Boolean(await kv.get(`used_txhash:${h}`)));
      if (!winner) return { found: false };
      return { found: true, txHash: winner.txHash, qAmount: winner.amountUSD, token: "Q", chain: "BNB Chain", from: winner.from };
    } catch {
      // try next RPC
    }
  }
  return { found: false };
}

// ── Chain-aware pricing ────────────────────────────────────────────────────────
// Tier order: [500tx, 1K, 5K, 10K, 50K, 100K, 500K]
export const TIER_CREDITS = [500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000];
export const TIER_PLANS   = ["starter", "basic", "growth", "pro", "scale", "business", "enterprise_flex"];

// MCP v0.5.8 — every supported chain ships at the same tier prices.
// Previously Ethereum carried a 1.5× surcharge and Avalanche 1.1× to
// reflect their higher relayer-gas cost, but cross-chain tier confusion at the
// checkout was worse than the marginal margin. Server resolution stays
// identical because the dollar values are unchanged on the BNB path —
// the other chains just snapped down to match.
//
// Keep the per-chain map (not a single array) so future per-chain
// adjustments don't require restructuring callers + tests.
const UNIFIED_THRESHOLDS = [29, 49, 89, 149, 449, 799, 1999] as const;
const CHAIN_THRESHOLDS: Record<string, readonly number[]> = {
  //                  500  1K   5K    10K   50K   100K   500K
  "BNB Chain":  UNIFIED_THRESHOLDS,
  "X Layer":    UNIFIED_THRESHOLDS,
  "Stable":     UNIFIED_THRESHOLDS,
  "Mantle":     UNIFIED_THRESHOLDS,
  "Injective":  UNIFIED_THRESHOLDS,
  "Monad":      UNIFIED_THRESHOLDS,
  "Scroll":     UNIFIED_THRESHOLDS,
  "Avalanche":  UNIFIED_THRESHOLDS,
  "Ethereum":   UNIFIED_THRESHOLDS,
  "Arbitrum":   UNIFIED_THRESHOLDS,
  "Base":       UNIFIED_THRESHOLDS,
};
// Fallback = any chain (all rows equal now). Kept as a named export so
// callers don't have to know about the per-chain map being constant.
const DEFAULT_THRESHOLDS = UNIFIED_THRESHOLDS;

function getThresholds(chain?: string): readonly number[] {
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
// more within an active 30-day window. Under the previous per-chain pricing
// (AVAX 1.1×, ETH 1.5× of the BNB base), a $99 payment on AVAX represented
// less "value" than a $99 BNB payment, so cumulative tier math first
// normalized to BNB-equivalent USD via toBnbEquivUSD().
//
// MCP v0.5.8 unified per-chain pricing, so the normalization
// is a no-op (CHAIN_MULTIPLIERS all 1.0 → toBnbEquivUSD is identity). The
// function + table stay exported so the activate route's call-site doesn't
// need to change and so we have a single place to flip the values back if
// per-chain pricing returns later.

const CHAIN_MULTIPLIERS: Record<string, number> = {
  "BNB Chain": 1.0,
  "X Layer":   1.0,
  "Stable":    1.0,
  "Mantle":    1.0,
  "Injective": 1.0,
  "Monad":     1.0,
  "Scroll":    1.0,
  "Avalanche": 1.0,
  "Ethereum":  1.0,
  "Arbitrum":  1.0,
  "Base":      1.0,
};

/**
 * Convert a raw payment USD to BNB-equivalent USD by dividing out the chain's
 * price multiplier. With every chain at 1.0 multiplier this is currently the
 * identity function — kept for forward-compat with the cumulative-tier
 * machinery in /api/payment/activate.
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
