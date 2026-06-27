/**
 * Q402 Yield — Lista Lending (Moolah curated ERC-4626 "MoolahVault") adapter.
 *
 * Lista Lending is BNB Chain's largest lending market: a Morpho-Blue-style core
 * (Moolah) with curated ERC-4626 vaults (Gauntlet / Pangolins / MEV / ...). The
 * vault share token IS the position token and the redeemable balance is
 * `convertToAssets(shareBalanceOf(wallet))` — the exact same read surface as the
 * Morpho (Base) adapter. Lista is the BNB-native ERC-4626 venue for Q402 Yield.
 *
 * Write: deposit/withdraw settle through the SAME EIP-7702 witness path as Base
 * Morpho — the BNB ERC-4626 impl exposes supplyToErc4626 / withdrawFromErc4626
 * (contracts/yield/Q402PaymentImplementationBNBYieldErc4626.sol). `listaVaultFor`
 * here resolves the curated write-path vault (== the contract's immutable
 * allowlist; pinned by yield-bnb-lista-vault-drift.test).
 *
 * Vaults:
 *   - USDT: curated DEFAULT = Gauntlet USDT Vault (0x6d6783…), verified on BNB
 *     mainnet (ERC-4626, asset() == BSC USDT, name "Gauntlet USDT Vault").
 *     Overridable for READS via LISTA_VAULT_BNB_USDT.
 *   - USDC: curated DEFAULT = Lista USDC Vault (0x8a06…1869), verified on BNB
 *     mainnet (ERC-4626, asset() == BSC USDC, name "Lista USDC Vault"/lisUSDC).
 *     Overridable for READS via LISTA_VAULT_BNB_USDC.
 *
 * APY: Lista exposes no single on-chain "supply APY" getter (a vault's net rate is
 * the allocation-weighted blend of its Moolah markets minus fees). It is read
 * best-effort from Lista's API when LISTA_API_URL is configured; any
 * network/shape/timeout error yields 0 ("unknown") and the market still lists —
 * exactly like the Morpho adapter's best-effort APY-on-error.
 */

import { createPublicClient, http, formatUnits, isAddress, type Address } from "viem";
import { kv } from "@vercel/kv";
import { getPrimaryRpc, CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";
import type { YieldAdapter, YieldMarket, YieldPosition } from "./types";

type StableAsset = "USDC" | "USDT";

interface VaultCfg {
  asset: StableAsset;
  /** The MoolahVault ERC-4626 vault. Both marketAddress and positionToken. */
  vault: Address;
}

/**
 * Per-chain, per-asset vault ENV. A comma-separated list is supported for READS
 * (multiple curated vaults of the same asset), e.g.
 *   LISTA_VAULT_BNB_USDT=0x6d67…2525,0xEB4F…Ba33   (Gauntlet + Pangolins)
 * Invalid/non-address tokens are dropped; duplicates collapsed; order preserved.
 */
export const LISTA_ENV: Record<string, Partial<Record<StableAsset, string>>> = {
  bnb: { USDT: "LISTA_VAULT_BNB_USDT", USDC: "LISTA_VAULT_BNB_USDC" },
};

/**
 * Curated default vault per chain+asset (Gauntlet USDT Vault + Lista USDC Vault,
 * both verified on-chain: ERC-4626, asset() == the stablecoin). ENV overrides these
 * for READS; the WRITE path uses the default ONLY (see listaVaultFor) so it always
 * equals the impl's immutable allowlist (pinned by yield-bnb-lista-vault-drift.test).
 */
const LISTA_DEFAULT_VAULT: Record<string, Partial<Record<StableAsset, Address>>> = {
  bnb: {
    USDT: "0x6d6783C146F2B0B2774C1725297f1845dc502525", // Gauntlet USDT Vault
    USDC: "0x8a06ac91265dbebe6d4606f45b10993e9a571869", // Lista USDC Vault (lisUSDC)
  },
};

/**
 * Master gate. Lista yield (read + write) is INERT until ops sets
 * LISTA_YIELD_ENABLED=true — flipped only AFTER the BNB ERC-4626 impl is deployed
 * and YIELD_IMPL_BNB is re-pointed at it (else a deposit would sign an ERC-4626
 * witness and delegate to the Aave impl, which lacks supplyToErc4626, and revert).
 * Default off → zero behavior change vs the Aave-on-BNB path.
 */
export function listaEnabled(): boolean {
  return (process.env.LISTA_YIELD_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Comma-separated ENV list of addresses → deduped, order-preserving. */
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

/** READ-side vault list for a chain: ENV (per asset, comma list) overrides the
 *  curated default; a malformed ENV falls through to the default so a typo can't
 *  blank the panel. Empty when the chain has neither. */
function listaConfig(chain: string): { vaults: VaultCfg[] } | null {
  if (!listaEnabled()) return null;
  const envMap = LISTA_ENV[chain];
  if (!envMap) return null;
  const vaults: VaultCfg[] = [];
  for (const asset of ["USDT", "USDC"] as StableAsset[]) {
    const envName = envMap[asset];
    const fromEnv = envName ? envVaults(envName) : [];
    const def = LISTA_DEFAULT_VAULT[chain]?.[asset];
    const list = fromEnv.length > 0 ? fromEnv : def ? [def] : [];
    for (const vault of list) vaults.push({ asset, vault });
  }
  return vaults.length > 0 ? { vaults } : null;
}

/**
 * Live net supply APY for a vault, best-effort, from Lista's API when configured
 * (LISTA_API_URL — the base, e.g. https://api.lista.org). No env / any error → 0
 * ("unknown"), market still lists. 4s timeout keeps reserves responsive.
 * The exact response shape is wired once Lista shares the endpoint; until then
 * this returns 0 and the market lists with APY unknown.
 */
async function fetchListaApy(_chain: string, vault: Address): Promise<number> {
  const base = (process.env.LISTA_API_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return 0;
  try {
    const r = await fetch(`${base}/lending/vault/${vault}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return 0;
    const j = (await r.json()) as { netApy?: number; apy?: number; data?: { netApy?: number; apy?: number } };
    const apy = j.netApy ?? j.apy ?? j.data?.netApy ?? j.data?.apy;
    return typeof apy === "number" && Number.isFinite(apy) && apy > 0 ? apy : 0;
  } catch {
    return 0;
  }
}

// ERC-4626 read surface: underlying asset, the wallet's share balance, and
// shares -> assets (redeemable underlying). Identical to the Morpho adapter.
const ERC4626_ABI = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

function client(chain: string) {
  return createPublicClient({ transport: http(getPrimaryRpc(chain)) });
}

function tokenDecimals(chain: string, asset: StableAsset): number {
  const cfg = CHAIN_CONFIG[chain as ChainKey];
  const t = asset === "USDT" ? cfg?.usdt : cfg?.usdc;
  return t?.decimals ?? 18; // BNB stables are 18-dec
}

async function readAsset(c: ReturnType<typeof client>, vault: Address): Promise<Address> {
  return (await c.readContract({ address: vault, abi: ERC4626_ABI, functionName: "asset", args: [] })) as Address;
}

async function readShares(c: ReturnType<typeof client>, vault: Address, wallet: Address): Promise<bigint> {
  return (await c.readContract({ address: vault, abi: ERC4626_ABI, functionName: "balanceOf", args: [wallet] })) as bigint;
}

async function sharesToAssets(c: ReturnType<typeof client>, vault: Address, shares: bigint): Promise<bigint> {
  if (shares === 0n) return 0n;
  return (await c.readContract({ address: vault, abi: ERC4626_ABI, functionName: "convertToAssets", args: [shares] })) as bigint;
}

async function marketRow(c: ReturnType<typeof client>, chain: string, v: VaultCfg): Promise<YieldMarket> {
  const [assetAddress, supplyApy] = await Promise.all([
    readAsset(c, v.vault),
    fetchListaApy(chain, v.vault),
  ]);
  return {
    protocol: "lista",
    chain,
    asset: v.asset,
    assetAddress,
    positionToken: v.vault, // ERC-4626: the vault share token is the vault itself
    marketAddress: v.vault,
    supplyApy,
    label: `Lista Lending ${v.asset}`,
  };
}

/** Off-chain principal mirror, keyed `{chain}:{asset}` (human units). Shared KV
 *  layout with the Aave/Morpho adapters (aw:yield:{wallet}). Best-effort. */
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
  if (principalHuman != null && Number.isFinite(principalHuman) && principalHuman > 0) {
    principal = String(principalHuman);
    accrued = String(Math.max(0, Number(balance) - principalHuman));
  }
  return {
    protocol: "lista",
    chain,
    asset: v.asset,
    marketAddress: v.vault,
    positionToken: v.vault,
    balance,
    balanceRaw: sharesRaw.toString(),
    principal,
    accrued,
    supplyApy: apy,
  };
}

export const listaAdapter: YieldAdapter = {
  protocol: "lista",

  async listMarkets(chain: string): Promise<YieldMarket[]> {
    const cfg = listaConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const out: YieldMarket[] = [];
    for (const v of cfg.vaults) {
      try {
        out.push(await marketRow(c, chain, v));
      } catch {
        // Vault unreadable (RPC blip / wrong address) — skip rather than publish
        // a phantom market. Strict variant surfaces the error instead.
      }
    }
    return out;
  },

  async listMarketsStrict(chain: string): Promise<YieldMarket[]> {
    const cfg = listaConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const out: YieldMarket[] = [];
    for (const v of cfg.vaults) {
      out.push(await marketRow(c, chain, v));
    }
    return out;
  },

  async getPositions(chain: string, walletAddress: string): Promise<YieldPosition[]> {
    const cfg = listaConfig(chain);
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
      const apy = await fetchListaApy(chain, v.vault); // best-effort (0 on fail)
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:${v.asset}`], apy));
    }
    return out;
  },

  async getPositionsStrict(chain: string, walletAddress: string): Promise<YieldPosition[]> {
    const cfg = listaConfig(chain);
    if (!cfg) return [];
    const c = client(chain);
    const wallet = walletAddress as Address;
    const principals = await readPrincipalMap(walletAddress);
    const out: YieldPosition[] = [];
    for (const v of cfg.vaults) {
      const shares = await readShares(c, v.vault, wallet);
      if (shares === 0n) continue; // no position — omit
      const assets = await sharesToAssets(c, v.vault, shares);
      const apy = await fetchListaApy(chain, v.vault); // best-effort (0 on fail)
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:${v.asset}`], apy));
    }
    return out;
  },
};

/** Chains where a Lista vault is configured (default or ENV). */
export function listaSupportedChains(): string[] {
  return Object.keys(LISTA_ENV).filter((chain) => listaConfig(chain) !== null);
}

/** The ERC-4626 vault the WRITE path signs for, or null if unconfigured.
 *  Resolves the CURATED default ONLY (LISTA_DEFAULT_VAULT) so it always equals
 *  the impl's immutable allowlist (pinned by yield-bnb-lista-vault-drift.test).
 *  It deliberately ignores the read adapter's ENV-flexible multi-vault list: an
 *  ENV-diverged vault would pass off-chain signing but revert on-chain
 *  (VaultNotAllowed) AFTER the relayer paid gas. USDC returns null until a USDC
 *  vault is both confirmed by Lista AND hard-coded in the impl allowlist. */
export function listaVaultFor(chain: string, asset: StableAsset = "USDT"): Address | null {
  if (!listaEnabled()) return null;
  return LISTA_DEFAULT_VAULT[chain]?.[asset] ?? null;
}

/**
 * Total redeemable Lista position value (vault shares -> assets) in human units.
 * THROWS on RPC failure so policy can fail closed (mirrors
 * aaveTotalPositionValueStrict / morphoTotalPositionValueStrict).
 */
export async function listaTotalPositionValueStrict(chain: string, walletAddress: string): Promise<number> {
  const cfg = listaConfig(chain);
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
