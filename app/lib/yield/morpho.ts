/**
 * Q402 Yield — Morpho (MetaMorpho ERC-4626) adapter (READ surface, Phase 0).
 *
 * Mirrors the Aave adapter's read surface for Morpho's MetaMorpho vaults,
 * which are ERC-4626: the vault share token IS the position token, and the
 * redeemable balance is `convertToAssets(shareBalanceOf(wallet))`. Moves NO
 * funds — listMarkets + getPositions only. Deposit/withdraw (Phase 1) ride a
 * separate executor (Permit2 -> Bundler3, distinct from Aave's EIP-7702
 * witness path) and are intentionally NOT implemented here.
 *
 * Morpho extends Q402 Yield to Base + Arbitrum (Aave covers BNB today).
 *
 * Two deliberate differences from the Aave adapter, both surfaced to callers
 * rather than faked:
 *   1. APY: MetaMorpho exposes no single on-chain "supply APY" getter (a
 *      vault's net rate is the allocation-weighted blend of its underlying
 *      Morpho Blue markets minus the performance fee). Computing that on-chain
 *      is out of scope for the read surface, so supplyApy is read from an
 *      optional on-chain rate hint when present and otherwise reported as 0
 *      ("unknown"), exactly like Aave's best-effort APY-on-error. A precise
 *      figure should come from the Morpho API or a rate oracle in a follow-up.
 *   2. Vault addresses are config-driven (ENV), NOT hardcoded — picking which
 *      curated vault to route into (Moonwell / Gauntlet / Steakhouse / ...) is
 *      an ops decision. With no vault configured a chain returns [] (no
 *      markets), so this adapter is inert until a vault is set. See MORPHO_ENV.
 */

import { createPublicClient, http, formatUnits, isAddress, type Address } from "viem";
import { kv } from "@vercel/kv";
import { getPrimaryRpc, CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";
import type { YieldAdapter, YieldMarket, YieldPosition } from "./types";

interface VaultCfg {
  asset: "USDC" | "USDT";
  /** The MetaMorpho ERC-4626 vault. Both marketAddress and positionToken. */
  vault: Address;
}

interface ChainMorphoCfg {
  vaults: VaultCfg[];
}

/**
 * Per-chain MetaMorpho vault configuration, sourced from ENV so the chosen
 * curated vault is an ops/audit decision, never a guessed hardcode. Set:
 *
 *   MORPHO_VAULT_BASE_USDC      = 0x...   (a Base USDC MetaMorpho vault)
 *   MORPHO_VAULT_ARBITRUM_USDC  = 0x...   (an Arbitrum USDC MetaMorpho vault)
 *
 * A chain with no valid vault env returns [] from every read. Invalid/non-
 * address values are ignored (treated as unset) so a typo can't 500 the panel.
 */
export const MORPHO_ENV = {
  base: "MORPHO_VAULT_BASE_USDC",
  arbitrum: "MORPHO_VAULT_ARBITRUM_USDC",
} as const;

function envVault(varName: string): Address | null {
  const v = (process.env[varName] ?? "").trim();
  return v && isAddress(v) ? (v as Address) : null;
}

function morphoConfig(chain: string): ChainMorphoCfg | null {
  const envName = (MORPHO_ENV as Record<string, string>)[chain];
  if (!envName) return null;
  const vault = envVault(envName);
  if (!vault) return null;
  return { vaults: [{ asset: "USDC", vault }] };
}

// ERC-4626 (MetaMorpho) read surface: the underlying asset, the wallet's
// share balance, and shares -> assets conversion (redeemable underlying).
const ERC4626_ABI = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

function client(chain: string) {
  return createPublicClient({ transport: http(getPrimaryRpc(chain)) });
}

function tokenDecimals(chain: string, asset: "USDC" | "USDT"): number {
  const cfg = CHAIN_CONFIG[chain as ChainKey];
  const t = asset === "USDT" ? cfg?.usdt : cfg?.usdc;
  return t?.decimals ?? 6; // Base/Arbitrum USDC are 6-dec
}

/** Read a vault's underlying asset address. Throws on RPC error. */
async function readAsset(c: ReturnType<typeof client>, vault: Address): Promise<Address> {
  return (await c.readContract({ address: vault, abi: ERC4626_ABI, functionName: "asset", args: [] })) as Address;
}

/** Read a wallet's share balance in a vault. Throws on RPC error. */
async function readShares(c: ReturnType<typeof client>, vault: Address, wallet: Address): Promise<bigint> {
  return (await c.readContract({ address: vault, abi: ERC4626_ABI, functionName: "balanceOf", args: [wallet] })) as bigint;
}

/** Convert vault shares to redeemable underlying assets. Throws on RPC error. */
async function sharesToAssets(c: ReturnType<typeof client>, vault: Address, shares: bigint): Promise<bigint> {
  if (shares === 0n) return 0n;
  return (await c.readContract({ address: vault, abi: ERC4626_ABI, functionName: "convertToAssets", args: [shares] })) as bigint;
}

async function marketRow(c: ReturnType<typeof client>, chain: string, v: VaultCfg): Promise<YieldMarket> {
  const assetAddress = await readAsset(c, v.vault);
  return {
    protocol: "morpho",
    chain,
    asset: v.asset,
    assetAddress,
    positionToken: v.vault, // ERC-4626: the vault share token is the vault itself
    marketAddress: v.vault,
    supplyApy: 0, // MetaMorpho exposes no on-chain APY getter — see file header
    label: `Morpho ${v.asset} vault`,
  };
}

/** Off-chain principal mirror, keyed `{chain}:{asset}` (human units). Shared
 *  KV layout with the Aave adapter (aw:yield:{wallet}). Best-effort. */
async function readPrincipalMap(walletAddress: string): Promise<Record<string, number>> {
  try {
    return (await kv.get<Record<string, number>>(`aw:yield:${walletAddress.toLowerCase()}`)) ?? {};
  } catch {
    return {};
  }
}

function positionRow(
  chain: string,
  v: VaultCfg,
  assetsRaw: bigint,
  sharesRaw: bigint,
  principalHuman: number | undefined,
): YieldPosition {
  const balance = formatUnits(assetsRaw, tokenDecimals(chain, v.asset));
  let principal: string | null = null;
  let accrued: string | null = null;
  // Mirror the Aave adapter: only a POSITIVE tracked principal is "known"; a
  // recorded 0 leaves both null rather than mis-claiming the live balance as
  // earnings.
  if (principalHuman != null && Number.isFinite(principalHuman) && principalHuman > 0) {
    principal = String(principalHuman);
    accrued = String(Math.max(0, Number(balance) - principalHuman));
  }
  return {
    protocol: "morpho",
    chain,
    asset: v.asset,
    marketAddress: v.vault,
    positionToken: v.vault,
    balance,
    balanceRaw: sharesRaw.toString(), // raw on-chain unit is the share balance
    principal,
    accrued,
    supplyApy: 0,
  };
}

export const morphoAdapter: YieldAdapter = {
  protocol: "morpho",

  async listMarkets(chain: string): Promise<YieldMarket[]> {
    const cfg = morphoConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const out: YieldMarket[] = [];
    for (const v of cfg.vaults) {
      try {
        out.push(await marketRow(c, chain, v));
      } catch {
        // Vault unreadable (RPC blip / wrong address) — skip rather than
        // publish a phantom market. Strict variant surfaces the error instead.
      }
    }
    return out;
  },

  async listMarketsStrict(chain: string): Promise<YieldMarket[]> {
    const cfg = morphoConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const out: YieldMarket[] = [];
    for (const v of cfg.vaults) {
      out.push(await marketRow(c, chain, v));
    }
    return out;
  },

  async getPositions(chain: string, walletAddress: string): Promise<YieldPosition[]> {
    const cfg = morphoConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const wallet = walletAddress as Address;
    const principals = await readPrincipalMap(walletAddress);
    const out: YieldPosition[] = [];
    for (const v of cfg.vaults) {
      let shares = 0n;
      try {
        shares = await readShares(c, v.vault, wallet);
      } catch {
        continue; // RPC hiccup on this vault — skip rather than fail all
      }
      if (shares === 0n) continue; // no position — omit
      let assets = 0n;
      try {
        assets = await sharesToAssets(c, v.vault, shares);
      } catch {
        continue;
      }
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:${v.asset}`]));
    }
    return out;
  },

  async getPositionsStrict(chain: string, walletAddress: string): Promise<YieldPosition[]> {
    const cfg = morphoConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const wallet = walletAddress as Address;
    const principals = await readPrincipalMap(walletAddress);
    const out: YieldPosition[] = [];
    for (const v of cfg.vaults) {
      const shares = await readShares(c, v.vault, wallet);
      if (shares === 0n) continue; // no position — omit
      const assets = await sharesToAssets(c, v.vault, shares);
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:${v.asset}`]));
    }
    return out;
  },
};

/** Chains where a Morpho vault is configured (ENV-driven). */
export function morphoSupportedChains(): string[] {
  return Object.keys(MORPHO_ENV).filter((chain) => morphoConfig(chain) !== null);
}

/**
 * Total redeemable Morpho position value (vault shares -> assets) in human
 * units. THROWS on RPC failure so policy can fail closed (mirrors
 * aaveTotalPositionValueStrict).
 */
export async function morphoTotalPositionValueStrict(chain: string, walletAddress: string): Promise<number> {
  const cfg = morphoConfig(chain);
  if (!cfg) return 0;
  const c = client(chain);
  const wallet = walletAddress as Address;
  let total = 0;
  for (const v of cfg.vaults) {
    const shares = await readShares(c, v.vault, wallet);
    const assets = await sharesToAssets(c, v.vault, shares);
    total += Number(formatUnits(assets, tokenDecimals(chain, v.asset)));
  }
  return total;
}
