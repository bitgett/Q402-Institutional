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
 * Two notes vs the Aave adapter:
 *   1. APY: MetaMorpho exposes no single on-chain "supply APY" getter (a
 *      vault's net rate is the allocation-weighted blend of its underlying
 *      Morpho Blue markets minus the performance fee). So supplyApy is read
 *      from the Morpho API (the canonical source), best-effort with a short
 *      timeout — a network/shape error yields 0 ("unknown") and the market
 *      still lists, exactly like Aave's best-effort APY-on-error.
 *   2. Vaults: Base ships a curated DEFAULT (Gauntlet USDC Prime, the largest
 *      listed Base USDC vault), overridable via MORPHO_VAULT_BASE_USDC. Other
 *      chains (Arbitrum) are ENV-only — no default, inert until set. Picking a
 *      different curator is an ops decision; see MORPHO_DEFAULT_VAULT / MORPHO_ENV.
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
 *   MORPHO_VAULT_BASE_USDC      = 0x...   (one or more Base USDC vaults)
 *   MORPHO_VAULT_ARBITRUM_USDC  = 0x...   (one or more Arbitrum USDC vaults)
 *
 * Multiple vaults per chain are supported via a comma-separated list, e.g.
 *   MORPHO_VAULT_BASE_USDC=0xeE8F...4b61,0xBEEF...83b2
 * (Gauntlet USDC Prime + Steakhouse Prime USDC). Invalid/non-address tokens
 * are dropped; duplicates (case-insensitive) collapsed; order preserved.
 *
 * A chain with no valid vault env AND no curated default returns [] from every
 * read. Invalid values fall through to the curated default rather than
 * nulling the chain — so a typo can't 500 the panel.
 */
export const MORPHO_ENV = {
  base: "MORPHO_VAULT_BASE_USDC",
  arbitrum: "MORPHO_VAULT_ARBITRUM_USDC",
} as const;

/**
 * Curated default vault per chain. Base ships with Gauntlet USDC Prime
 * (`0xeE8F...4b61`) — the largest listed Base USDC MetaMorpho vault, verified
 * via the Morpho API and on-chain (asset = Base USDC, ERC-4626, ~$425M TVL).
 * ENV (MORPHO_ENV) overrides this if ops picks a different curator. Arbitrum
 * has NO default (Base-first rollout) — it activates only via its ENV var.
 */
const MORPHO_DEFAULT_VAULT: Partial<Record<string, Address>> = {
  base: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61",
};

/** EVM chainId per Q402 chain key, for the Morpho API APY lookup. */
const MORPHO_CHAIN_ID: Record<string, number> = { base: 8453, arbitrum: 42161 };

function envVault(varName: string): Address | null {
  const v = (process.env[varName] ?? "").trim();
  return v && isAddress(v) ? (v as Address) : null;
}

/**
 * Multi-vault ENV: comma-separated list of addresses. Invalid entries dropped.
 * Returns deduped list (case-insensitive) preserving first-occurrence order.
 */
function envVaults(varName: string): Address[] {
  const raw = (process.env[varName] ?? "").trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!isAddress(s)) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s as Address);
  }
  return out;
}

function morphoConfig(chain: string): ChainMorphoCfg | null {
  const envName = (MORPHO_ENV as Record<string, string>)[chain];
  if (!envName) return null;
  // ENV (comma-separated) overrides; otherwise fall back to the curated default
  // (Base only). Empty/invalid ENV falls through to the default — never null
  // a chain that has a working default just because ops set a malformed string.
  const fromEnv = envVaults(envName);
  const vaults: Address[] = fromEnv.length > 0
    ? fromEnv
    : (MORPHO_DEFAULT_VAULT[chain] ? [MORPHO_DEFAULT_VAULT[chain] as Address] : []);
  if (vaults.length === 0) return null;
  return { vaults: vaults.map((vault) => ({ asset: "USDC" as const, vault })) };
}

/**
 * Live net supply APY for a vault from the Morpho API (the canonical source —
 * MetaMorpho has no on-chain APY getter). Best-effort: a network/timeout/shape
 * error yields 0 ("unknown"), so a market still lists. 4s timeout keeps the
 * reserves route responsive even if the API is slow.
 */
async function fetchMorphoApy(chain: string, vault: Address): Promise<number> {
  const chainId = MORPHO_CHAIN_ID[chain];
  if (!chainId) return 0;
  try {
    const body = JSON.stringify({
      query: `query($a:String!,$c:Int!){ vaultByAddress(address:$a, chainId:$c){ state{ netApy } } }`,
      variables: { a: vault, c: chainId },
    });
    const r = await fetch("https://blue-api.morpho.org/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return 0;
    const j = (await r.json()) as { data?: { vaultByAddress?: { state?: { netApy?: number } } } };
    const apy = j.data?.vaultByAddress?.state?.netApy;
    return typeof apy === "number" && Number.isFinite(apy) && apy > 0 ? apy : 0;
  } catch {
    return 0;
  }
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
  // Asset (on-chain) + APY (Morpho API) in parallel — APY is best-effort.
  const [assetAddress, supplyApy] = await Promise.all([
    readAsset(c, v.vault),
    fetchMorphoApy(chain, v.vault),
  ]);
  return {
    protocol: "morpho",
    chain,
    asset: v.asset,
    assetAddress,
    positionToken: v.vault, // ERC-4626: the vault share token is the vault itself
    marketAddress: v.vault,
    supplyApy, // net APY from the Morpho API (0 when unavailable)
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
  apy: number,
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
    supplyApy: apy,
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
      const apy = await fetchMorphoApy(chain, v.vault); // best-effort (0 on fail)
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:${v.asset}`], apy));
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
      const apy = await fetchMorphoApy(chain, v.vault); // best-effort (0 on fail)
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:${v.asset}`], apy));
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
