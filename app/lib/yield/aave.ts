/**
 * Q402 Yield — Aave V3 adapter (READ surface, Phase 0).
 *
 * Reads available stablecoin lending markets (live supply APY) and a
 * wallet's current positions (aToken balance = principal + accrued).
 * Moves NO funds. Deposit/withdraw (Phase 1) ride the EIP-7702 witness
 * executor (separate spec) and will add buildSupply/buildWithdraw here.
 *
 * Aave V3 is live on BNB Chain (Q402's home chain) plus Base / Ethereum
 * / Arbitrum / Avalanche / Scroll. Phase 0 ships BNB; the RESERVES map
 * is keyed by Q402 chain key so adding chains is config-only.
 *
 * aTokens REBASE: `balanceOf` already includes accrued interest (1:1
 * redeemable for the underlying). Accrued yield is computed off-chain as
 * balance − tracked principal (KV), since Aave exposes no "yield earned"
 * getter.
 *
 * Addresses from the canonical bgd-labs/aave-address-book; ENV-overridable
 * via AAVE_POOL_{CHAIN} etc. Live APY comes from
 * Pool.getReserveData(asset).currentLiquidityRate (ray APR → APY).
 */

import { createPublicClient, http, formatUnits, type Address } from "viem";
import { getPrimaryRpc, CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";
import type { YieldAdapter, YieldMarket, YieldPosition } from "./types";

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

interface ReserveCfg {
  asset: "USDC" | "USDT";
  underlying: Address;
  aToken: Address;
}

interface ChainAaveCfg {
  pool: Address;
  reserves: ReserveCfg[];
}

/**
 * Aave V3 deployment per Q402 chain. BNB only for Phase 0. Verify any
 * new chain against bgd-labs/aave-address-book before enabling.
 */
const AAVE: Partial<Record<string, ChainAaveCfg>> = {
  bnb: {
    pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
    reserves: [
      {
        asset: "USDC",
        underlying: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        aToken: "0x00901a076785e0906d1028c7d6372d247bec7d61",
      },
      {
        asset: "USDT",
        underlying: "0x55d398326f99059fF775485246999027B3197955",
        aToken: "0xa9251ca9DE909CB71783723713B21E4233fbf1B1",
      },
    ],
  },
};

const ERC20_BAL_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "scaledBalanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Aave V3 Pool.getReserveData → ReserveData struct. We only consume
// currentLiquidityRate; the full tuple is declared so viem decodes it.
const POOL_ABI = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
] as const;

function client(chain: string) {
  return createPublicClient({ transport: http(getPrimaryRpc(chain)) });
}

function tokenDecimals(chain: string, asset: "USDC" | "USDT"): number {
  const cfg = CHAIN_CONFIG[chain as ChainKey];
  const t = asset === "USDT" ? cfg?.usdt : cfg?.usdc;
  return t?.decimals ?? 18; // BNB stables are 18-dec
}

/** ray APR → compounded APY fraction. Best-effort; 0 on bad input. */
function rayRateToApy(rate: bigint): number {
  const apr = Number(rate) / Number(RAY);
  if (!Number.isFinite(apr) || apr <= 0) return 0;
  return (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;
}

export const aaveAdapter: YieldAdapter = {
  protocol: "aave",

  async listMarkets(chain: string): Promise<YieldMarket[]> {
    const cfg = AAVE[chain];
    if (!cfg) return [];
    const c = client(chain);
    const out: YieldMarket[] = [];
    for (const r of cfg.reserves) {
      let apy = 0;
      try {
        const data = (await c.readContract({
          address: cfg.pool,
          abi: POOL_ABI,
          functionName: "getReserveData",
          args: [r.underlying],
        })) as { currentLiquidityRate: bigint };
        apy = rayRateToApy(data.currentLiquidityRate);
      } catch {
        // Struct shape can drift across Aave minor versions — APY is
        // best-effort; the market is still listable (apy 0 = "unknown").
      }
      out.push({
        protocol: "aave",
        chain,
        asset: r.asset,
        assetAddress: r.underlying,
        positionToken: r.aToken,
        marketAddress: cfg.pool,
        supplyApy: apy,
        label: `Aave V3 ${r.asset}`,
      });
    }
    return out;
  },

  async getPositions(chain: string, walletAddress: string): Promise<YieldPosition[]> {
    const cfg = AAVE[chain];
    if (!cfg) return [];
    const c = client(chain);
    const wallet = walletAddress as Address;
    const positions: YieldPosition[] = [];
    for (const r of cfg.reserves) {
      const dec = tokenDecimals(chain, r.asset);
      let balRaw = 0n;
      try {
        balRaw = (await c.readContract({
          address: r.aToken,
          abi: ERC20_BAL_ABI,
          functionName: "balanceOf",
          args: [wallet],
        })) as bigint;
      } catch {
        continue; // RPC hiccup on this reserve — skip rather than fail all
      }
      if (balRaw === 0n) continue; // no position — omit
      // Live APY for context (best-effort, mirrors listMarkets).
      let apy = 0;
      try {
        const data = (await c.readContract({
          address: cfg.pool, abi: POOL_ABI, functionName: "getReserveData", args: [r.underlying],
        })) as { currentLiquidityRate: bigint };
        apy = rayRateToApy(data.currentLiquidityRate);
      } catch { /* best-effort */ }
      positions.push({
        protocol: "aave",
        chain,
        asset: r.asset,
        marketAddress: cfg.pool,
        positionToken: r.aToken,
        balance: formatUnits(balRaw, dec),
        balanceRaw: balRaw.toString(),
        // Principal tracking begins at Phase-1 deposit (KV aw:yield:*).
        // Phase 0 read has no record → principal/accrued null.
        principal: null,
        accrued: null,
        supplyApy: apy,
      });
    }
    return positions;
  },
};

/** Chains where Aave yield is available (config-driven). */
export function aaveSupportedChains(): string[] {
  return Object.keys(AAVE);
}
