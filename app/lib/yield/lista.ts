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
import { getPrimaryRpc, getTokenConfig, type ChainKey } from "@/app/lib/relayer";
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
 * DEPOSIT gate. LISTA_YIELD_ENABLED controls only whether NEW deposits route to
 * Lista (and whether Lista deposit markets are advertised) — NOT reads/withdraws.
 * Reads, withdraw-target resolution, GC counting and allocation are
 * flag-INDEPENDENT (keyed on whether a vault is configured), so funds already
 * supplied to Lista stay visible and recoverable even after the flag is turned
 * back off (no "rollback orphans funds"). Default off → zero behavior change vs
 * the Aave-on-BNB deposit path.
 *
 * Per-protocol impl: a Lista deposit/withdraw delegates to YIELD_IMPL_<CHAIN>_LISTA
 * (the ERC-4626 impl), NEVER the chain's default Aave impl (yieldImplFor in
 * sign.ts). Enabling the flag without that env set fails closed — no Aave-impl
 * mis-delegation that would burn gas on every deposit.
 */
export function listaDepositsEnabled(): boolean {
  return (process.env.LISTA_YIELD_ENABLED ?? "").trim().toLowerCase() === "true";
}
/** @deprecated Ambiguous old name (it used to gate reads too). Use
 *  listaDepositsEnabled() for the deposit gate; reads/withdraws are no longer
 *  flag-gated. Kept only so any stale import still resolves. */
export function listaEnabled(): boolean {
  return listaDepositsEnabled();
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
 *  blank the panel. Empty when the chain has neither. Every candidate is filtered
 *  through `isListaVaultAllowed` (the SAME allowlist the signer + the impl enforce)
 *  so reads can NEVER advertise a vault that Q402 withdraw would reject — an ENV
 *  override pointing at a non-allowlisted vault is dropped, not shown as a
 *  read-only / un-withdrawable position (audit: read<->withdraw must agree). */
function listaConfig(chain: string): { vaults: VaultCfg[] } | null {
  // Flag-INDEPENDENT: a configured vault is readable + withdrawable regardless of
  // the deposit flag (funds stay recoverable after a rollback). Deposit
  // advertising is gated separately (listMarkets / listaDepositChains).
  const envMap = LISTA_ENV[chain];
  if (!envMap) return null;
  const vaults: VaultCfg[] = [];
  for (const asset of ["USDT", "USDC"] as StableAsset[]) {
    const envName = envMap[asset];
    const fromEnv = envName ? envVaults(envName) : [];
    const def = LISTA_DEFAULT_VAULT[chain]?.[asset];
    const list = fromEnv.length > 0 ? fromEnv : def ? [def] : [];
    // Only advertise withdrawable (allowlisted) vaults — an ENV override that
    // isn't in the immutable contract/signer allowlist would otherwise strand
    // funds: visible position, withdraw rejected.
    for (const vault of list) {
      if (isListaVaultAllowed(chain, asset, vault)) vaults.push({ asset, vault });
    }
  }
  return vaults.length > 0 ? { vaults } : null;
}

/**
 * DeFiLlama pool id per curated Lista vault. Lista does NOT expose a public APY
 * API — its docs (docs.bsc.lista.org) define APY as an on-chain weighted average
 * of the vault's Moolah markets (borrowAPY x utilization x (1 - fee), weighted by
 * the vault's withdrawal-queue allocation). DeFiLlama already runs that compute
 * and serves it per curated vault, so we read it from there rather than
 * re-implementing the Moolah math. The vault->pool match is VERIFIED, not guessed:
 * each pool's tvlUsd equals the vault's on-chain totalAssets (Gauntlet USDT
 * $7.27M == pool 8b4267ba; Lista USDC $0.236M == pool 2e2b6277). Keys lowercase.
 */
const LISTA_DEFILLAMA_POOL: Record<string, string> = {
  "0x6d6783c146f2b0b2774c1725297f1845dc502525": "8b4267ba-69b2-49c9-9a82-df98e24e1f0f", // Gauntlet USDT Vault (BNB)
  "0x8a06ac91265dbebe6d4606f45b10993e9a571869": "2e2b6277-9fc6-4466-8580-0dfb9416aad7", // Lista USDC Vault (BNB)
};

/**
 * Live net supply APY for a vault, best-effort, as a FRACTION (0.0488 == 4.88%).
 * Primary source = DeFiLlama's per-pool chart (the latest apy, base + LISTA
 * rewards). `LISTA_API_URL` is an optional override (used first when set, e.g. if
 * Lista ships a native endpoint that returns a fraction). Any miss/error → 0
 * ("unknown"), the market still lists. 4s timeout keeps reserves responsive.
 */
async function fetchListaApy(_chain: string, vault: Address): Promise<number> {
  try {
    // Optional Lista-native override (expected to return a fraction).
    const base = (process.env.LISTA_API_URL ?? "").trim().replace(/\/+$/, "");
    if (base) {
      const r = await fetch(`${base}/lending/vault/${vault}`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = (await r.json()) as { netApy?: number; apy?: number; data?: { netApy?: number; apy?: number } };
        const a = j.netApy ?? j.apy ?? j.data?.netApy ?? j.data?.apy;
        if (typeof a === "number" && Number.isFinite(a) && a > 0) return a;
      }
    }
    // DeFiLlama — the standard public source for a curated Lista vault's APY.
    const pool = LISTA_DEFILLAMA_POOL[vault.toLowerCase()];
    if (!pool) return 0;
    const r = await fetch(`https://yields.llama.fi/chart/${pool}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return 0;
    const j = (await r.json()) as { data?: Array<{ apy?: number }> };
    const apyPct = j.data?.[j.data.length - 1]?.apy;
    // DeFiLlama apy is a PERCENT; our markets carry APY as a fraction.
    return typeof apyPct === "number" && Number.isFinite(apyPct) && apyPct > 0 ? apyPct / 100 : 0;
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
  // Lista venues are USDC/USDT chains (never Robinhood/USDG); resolve decimals
  // from the manifest-backed config, falling back to 18 (BNB stables).
  try {
    return getTokenConfig(chain as ChainKey, asset)?.decimals ?? 18;
  } catch {
    return 18;
  }
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
    if (!listaDepositsEnabled()) return []; // advertise deposit markets only when enabled
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
    if (!listaDepositsEnabled()) return [];
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
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:lista:${v.asset}`], apy));
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
      out.push(positionRow(chain, v, assets, shares, principals[`${chain}:lista:${v.asset}`], apy));
    }
    return out;
  },
};

/** Chains with a configured Lista vault, REGARDLESS of the deposit flag. Drives
 *  reads / withdraw / GC / allocation so Lista funds stay recoverable even with
 *  deposits disabled. */
export function listaConfiguredChains(): string[] {
  return Object.keys(LISTA_ENV).filter((chain) => listaConfig(chain) !== null);
}

/** Chains where NEW Lista deposits are enabled (configured AND the deposit flag).
 *  Drives deposit protocol selection + market de-dup. Empty when the flag is off. */
export function listaDepositChains(): string[] {
  return listaDepositsEnabled() ? listaConfiguredChains() : [];
}

/** The curated DEFAULT ERC-4626 vault for a chain+asset (the deposit write
 *  target), or null if unconfigured. Resolves the CURATED default ONLY
 *  (LISTA_DEFAULT_VAULT) so it always equals the impl's immutable allowlist
 *  (pinned by yield-bnb-lista-vault-drift.test). Flag-INDEPENDENT — a withdraw
 *  must resolve the vault even when deposits are off; the deposit flag is checked
 *  upstream (deposit protocol selection), not here. Both USDT and USDC resolve to
 *  their curated default vault. */
export function listaVaultFor(chain: string, asset: StableAsset = "USDT"): Address | null {
  return LISTA_DEFAULT_VAULT[chain]?.[asset] ?? null;
}

/** Is `vault` the curated default Lista vault for this chain+asset? Validates a
 *  withdraw's on-chain position market before signing. Checks the CURATED default
 *  ONLY (not the ENV-flexible read list): the impl's immutable on-chain
 *  isAllowedVault accepts only the curated default per asset, so an ENV-added read
 *  vault would pass an ENV-flexible check here but revert on-chain (VaultNotAllowed)
 *  AFTER the relayer paid gas. Reject it off-chain — same posture as aave/morpho. */
export function isListaVaultAllowed(chain: string, asset: StableAsset, vault: string): boolean {
  const def = LISTA_DEFAULT_VAULT[chain]?.[asset];
  return !!def && def.toLowerCase() === vault.toLowerCase();
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
