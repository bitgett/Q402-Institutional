/**
 * agentic-wallet-balance.ts — 9-chain USDC + USDT balance reader.
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
  /** Aggregate across every chain that returned a value. */
  totalUsd: number;
  perChain: ChainBalance[];
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
  } as const;
  const client = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });

  // Some chains use the same address for both USDC and USDT (Stable's
  // USDT0, Injective's USDT-only mirror). Reading them twice would waste
  // an RPC; collapse to a single read in that case and split the result.
  const sameToken = cfg.tokens.USDC.address.toLowerCase() === cfg.tokens.USDT.address.toLowerCase();

  try {
    if (sameToken) {
      const raw = await client.readContract({
        address: cfg.tokens.USDT.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [walletAddr],
      }) as bigint;
      // Decide which token slot the chain actually settles. Injective is
      // USDT-only; Stable's USDT0 maps under both keys but USDT is the
      // canonical surface. We report under USDT and leave USDC null so
      // the UI doesn't double-count.
      const tb = tokenBalanceFromRaw(raw, cfg.tokens.USDT.decimals);
      return { chain, usdc: null, usdt: tb, totalUsd: tb.usd };
    }

    const reads = [
      {
        address: cfg.tokens.USDC.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf" as const,
        args: [walletAddr] as const,
      },
      {
        address: cfg.tokens.USDT.address,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf" as const,
        args: [walletAddr] as const,
      },
    ];

    // viem.multicall falls back to N individual calls if multicall3 isn't
    // deployed on the chain. The user pays one RPC instead of two on the
    // happy path and the same as today on the fallback path.
    const results = await client.multicall({ contracts: reads, allowFailure: true });

    const usdcResult = results[0];
    const usdtResult = results[1];

    const usdc =
      usdcResult.status === "success"
        ? tokenBalanceFromRaw(usdcResult.result as bigint, cfg.tokens.USDC.decimals)
        : null;
    const usdt =
      usdtResult.status === "success"
        ? tokenBalanceFromRaw(usdtResult.result as bigint, cfg.tokens.USDT.decimals)
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
      totalUsd: (usdc?.usd ?? 0) + (usdt?.usd ?? 0),
    };
  } catch (e) {
    return {
      chain,
      usdc: null,
      usdt: null,
      totalUsd: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Read every supported chain's USDC + USDT balance in parallel. Failing
 * chains are returned with `totalUsd: null` so the caller can render
 * "—" for those rows without poisoning the aggregate.
 */
export async function fetchAgenticBalances(walletAddr: string): Promise<AgenticBalances> {
  const addr = getAddress(walletAddr) as Address;
  const chains = Object.keys(AGENTIC_CHAINS) as AgenticChainKey[];
  const perChain = await Promise.all(chains.map((c) => readChainBalances(c, addr)));
  const totalUsd = perChain.reduce((sum, c) => sum + (c.totalUsd ?? 0), 0);
  return {
    asOf: Date.now(),
    totalUsd,
    perChain,
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
