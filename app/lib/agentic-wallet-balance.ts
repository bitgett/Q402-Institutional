/**
 * agentic-wallet-balance.ts — 12-chain USDC + USDT balance reader
 * (Robinhood Chain contributes USDG, its only stablecoin).
 *
 * Reads the Agent Wallet's stablecoin balances across every supported
 * EVM chain in parallel. Each chain uses viem's multicall so the two
 * `balanceOf` calls (USDC + USDT) fly together — one RPC round-trip per
 * chain instead of two. Chains that fail (RPC outage, multicall3
 * missing, network down) are silently zeroed out so the aggregate
 * remains useful even when one chain is unreachable.
 *
 * USD conversion: USDC and USDT are treated as 1:1 with USD. For the
 * dashboard "available balance" surface that's accurate enough — the
 * peg drift is measured in basis points and doesn't change the user's
 * decision to send.
 */

import { createPublicClient, http, getAddress, type Address, type Hex } from "viem";
import { AGENTIC_CHAINS, type AgenticChainKey } from "./agentic-wallet-sign";

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

export interface TokenBalance {
  /** Raw uint256 balance, atomic units. Serialised as decimal string so
   *  the route response stays JSON-safe. */
  raw: string;
  /** USD value derived from raw / 10^decimals (USDC/USDT pegged 1:1). */
  usd: number;
  /** Token decimals — kept on the wire so the UI can render without
   *  re-deriving from chain config. */
  decimals: number;
}

export interface ChainBalance {
  chain: AgenticChainKey;
  usdc: TokenBalance | null;
  usdt: TokenBalance | null;
  /** QuackAI Q token (BNB-only). Tracked in TOKEN UNITS (`amount`), NOT USD —
   *  Q is not 1:1 pegged, so it is deliberately excluded from `totalUsd`.
   *  null on chains without Q configured or when the read failed. */
  quack: { raw: string; amount: number } | null;
  /** Sum of usdc + usdt usd. `null` when the chain RPC failed (so the
   *  UI can render "—" instead of misleading "$0"). */
  totalUsd: number | null;
  /** Populated when the chain read raised — kept for debugging, not
   *  surfaced to the user. */
  error?: string;
}

export interface AgenticBalances {
  /** ms-epoch when the snapshot was taken. */
  asOf: number;
  /** Aggregate across every chain that returned a value. Chains that
   *  errored (RPC down, multicall3 missing, USDC contract revert) are
   *  EXCLUDED from this sum — see `unreachableChains` for the safety
   *  flag any fail-closed caller MUST consult. */
  totalUsd: number;
  /** Chain keys whose USDC+USDT read failed entirely. Empty when all
   *  chains responded. The GC cron uses this to refuse hard-delete
   *  whenever it's non-empty — without it, an RPC outage on a chain
   *  that holds funds would let the cron treat balance as 0 and burn
   *  the keystore. */
  unreachableChains: string[];
  perChain: ChainBalance[];
  /** Aggregate Q token balance across chains (TOKEN UNITS, not USD). Q is
   *  BNB-only today so this is effectively the BNB Q balance, but kept as a
   *  sum for forward-compat. Separate from totalUsd by design (not pegged). */
  quackTotal: number;
}

function tokenBalanceFromRaw(raw: bigint, decimals: number): TokenBalance {
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(raw / divisor);
  const frac = Number(raw % divisor) / Number(divisor);
  return {
    raw: raw.toString(),
    usd: whole + frac,
    decimals,
  };
}

/** Canonical Multicall3 address — deployed at the same address on every
 *  chain Q402 supports. Required for viem's `multicall()` helper to find
 *  the aggregator without us paying two round-trips per chain. */
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

async function readChainBalances(
  chain: AgenticChainKey,
  walletAddr: Address,
): Promise<ChainBalance> {
  const cfg = AGENTIC_CHAINS[chain];
  const viemChain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
    contracts: {
      multicall3: { address: MULTICALL3_ADDRESS },
    },
  } as const;
  const client = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });

  // USDG-only chains (Robinhood Chain) carry neither Circle USDC nor Tether
  // USDT — only Paxos Global Dollar. Read USDG and report it under the `usdt`
  // slot (canonical stablecoin surface for the UI's totalUsd math), leaving
  // usdc null so the dashboard doesn't double-count. USDG is 1:1 USD like the
  // other stablecoins, so folding it into totalUsd is correct.
  const usdgOnly = !cfg.tokens.USDC && !cfg.tokens.USDT && !!cfg.tokens.USDG;
  if (usdgOnly) {
    const usdg = cfg.tokens.USDG!;
    try {
      const raw = await client.readContract({
        address: usdg.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [walletAddr],
      }) as bigint;
      const tb = tokenBalanceFromRaw(raw, usdg.decimals);
      return { chain, usdc: null, usdt: tb, quack: null, totalUsd: tb.usd };
    } catch (e) {
      return {
        chain,
        usdc: null,
        usdt: null,
        quack: null,
        totalUsd: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Some chains use the same address for both USDC and USDT (e.g. Stable's
  // USDT0). Reading them twice would waste an RPC; collapse to a single
  // read in that case and split the result.
  const usdcCfg = cfg.tokens.USDC!;
  const usdtCfg = cfg.tokens.USDT!;
  const sameToken = usdcCfg.address.toLowerCase() === usdtCfg.address.toLowerCase();

  try {
    if (sameToken) {
      const raw = await client.readContract({
        address: usdtCfg.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [walletAddr],
      }) as bigint;
      // Decide which token slot the chain actually settles. Stable's USDT0
      // maps under both keys but USDT is the canonical surface. We report
      // under USDT and leave USDC null so
      // the UI doesn't double-count.
      const tb = tokenBalanceFromRaw(raw, usdtCfg.decimals);
      return { chain, usdc: null, usdt: tb, quack: null, totalUsd: tb.usd };
    }

    const reads = [
      {
        address: usdcCfg.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf" as const,
        args: [walletAddr] as const,
      },
      {
        address: usdtCfg.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf" as const,
        args: [walletAddr] as const,
      },
    ];
    // Q (QuackAI token) is configured on BNB only — read it alongside the
    // stablecoins when present. It is NOT 1:1 USD-pegged, so it is tracked in
    // token units (`quack`) and never folded into totalUsd; USD valuation
    // comes from the Q/USDT TWAP at spend time.
    const qCfg = cfg.tokens.Q;
    if (qCfg) {
      reads.push({
        address: qCfg.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf" as const,
        args: [walletAddr] as const,
      });
    }

    // viem.multicall falls back to N individual calls if multicall3 isn't
    // deployed on the chain. The user pays one RPC instead of N on the
    // happy path and the same as today on the fallback path.
    const results = await client.multicall({ contracts: reads, allowFailure: true });

    const usdcResult = results[0];
    const usdtResult = results[1];
    const quackResult = qCfg ? results[2] : null;

    const usdc =
      usdcResult.status === "success"
        ? tokenBalanceFromRaw(usdcResult.result as bigint, usdcCfg.decimals)
        : null;
    const usdt =
      usdtResult.status === "success"
        ? tokenBalanceFromRaw(usdtResult.result as bigint, usdtCfg.decimals)
        : null;
    // Reuse tokenBalanceFromRaw's raw->amount math (its `usd` field IS the
    // token amount); relabel as `amount` so nothing reads Q as USD.
    const quack =
      qCfg && quackResult && quackResult.status === "success"
        ? (() => {
            const b = tokenBalanceFromRaw(quackResult.result as bigint, qCfg.decimals);
            return { raw: b.raw, amount: b.usd };
          })()
        : null;

    if (!usdc && !usdt) {
      const errorMessage = (e: unknown): string => {
        if (e instanceof Error) {
          const m = e as Error & { shortMessage?: string };
          return m.shortMessage ?? m.message;
        }
        return String(e);
      };
      return {
        chain,
        usdc: null,
        usdt: null,
        quack,
        totalUsd: null,
        error:
          (usdcResult.status === "failure" ? errorMessage(usdcResult.error) : "") ||
          (usdtResult.status === "failure" ? errorMessage(usdtResult.error) : "") ||
          "all_reads_failed",
      };
    }

    return {
      chain,
      usdc,
      usdt,
      quack,
      totalUsd: (usdc?.usd ?? 0) + (usdt?.usd ?? 0),
    };
  } catch (e) {
    return {
      chain,
      usdc: null,
      usdt: null,
      quack: null,
      totalUsd: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Read every supported chain's USDC + USDT balance in parallel. Failing
 * chains are returned with `totalUsd: null` so the dashboard can
 * render "—" for those rows without poisoning the aggregate — AND
 * surfaced in `unreachableChains` so fail-closed callers (the GC
 * hard-delete cron) can refuse to treat null-as-zero.
 *
 * A chain counts as "unreachable" when either:
 *   - the per-chain try/catch hit the outer fallback (RPC throw,
 *     multicall3 missing, viem transport error), OR
 *   - both per-token reads inside the per-chain branch returned a
 *     `failure` status (caught at the `usdc===null && usdt===null`
 *     guard inside `readChainBalances`).
 * In both cases `c.totalUsd === null` is the load-bearing signal.
 */
export async function fetchAgenticBalances(walletAddr: string): Promise<AgenticBalances> {
  const addr = getAddress(walletAddr) as Address;
  const chains = Object.keys(AGENTIC_CHAINS) as AgenticChainKey[];
  const perChain = await Promise.all(chains.map((c) => readChainBalances(c, addr)));
  const totalUsd = perChain.reduce((sum, c) => sum + (c.totalUsd ?? 0), 0);
  // Q is token-unit, not USD — summed separately and kept out of totalUsd.
  const quackTotal = perChain.reduce((sum, c) => sum + (c.quack?.amount ?? 0), 0);
  const unreachableChains = perChain
    .filter((c) => c.totalUsd === null)
    .map((c) => c.chain);
  return {
    asOf: Date.now(),
    totalUsd,
    unreachableChains,
    perChain,
    quackTotal,
  };
}

/** Re-export for tests that want to assert specific token math. */
export const __test = { tokenBalanceFromRaw };

// Re-export the chain key set so route + UI don't have to reach into
// agentic-wallet-sign just for the tuple.
export type { AgenticChainKey, AgenticToken } from "./agentic-wallet-sign";
export { AGENTIC_CHAINS } from "./agentic-wallet-sign";

// Ergonomic helper used by the dashboard card.
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Convenience predicate.
export function isErc20Address(s: unknown): s is Hex {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}
