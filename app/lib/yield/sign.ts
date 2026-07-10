/**
 * Q402 Yield — server-side EIP-712 + EIP-7702 signing for Aave supply /
 * withdraw, mirroring agentic-wallet-sign.ts's transfer signing.
 *
 * The Agent Wallet (server-managed key) signs an AaveSupply/Withdraw
 * witness + an EIP-7702 authorization delegating to the v2 impl (the one
 * with supplyToAave/withdrawFromAave). The relayer submits the type-4 tx
 * and pays gas. Witness field order MUST match the v2 contract's typehash
 * exactly (contracts/yield/Q402PaymentImplementationBNBv2.sol).
 *
 * The v2 impl address is read from env (YIELD_IMPL_<CHAIN>) and is unset
 * until the audited v2 impl is deployed — signYieldAction throws a clear
 * error until then, so the deposit/withdraw routes fail closed.
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENTIC_CHAINS,
  randomUint256Nonce,
  type AgenticChainKey,
  type AgenticToken,
  type SignedAuthorization,
} from "@/app/lib/agentic-wallet-sign";
import { morphoVaultFor, morphoSupportedChains } from "./morpho";
import { listaVaultFor, listaDepositChains, listaConfiguredChains, isListaVaultAllowed } from "./lista";

export type YieldAction = "supply" | "withdraw";

// Field order is normative — keeps the off-chain witness byte-identical to
// the on-chain AAVE_*_AUTHORIZATION_TYPEHASH.
const AAVE_SUPPLY_AUTH_TYPES = {
  AaveSupplyAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "pool", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const AAVE_WITHDRAW_AUTH_TYPES = {
  AaveWithdrawAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "pool", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ERC-4626 (Morpho) witness types — field order MUST match the BASE v2 impl's
// ERC4626_*_AUTHORIZATION_TYPEHASH (vault replaces Aave's pool).
const ERC4626_SUPPLY_AUTH_TYPES = {
  Erc4626SupplyAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "vault", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minSharesOut", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const ERC4626_WITHDRAW_AUTH_TYPES = {
  Erc4626WithdrawAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "vault", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minAssetsOut", type: "uint256" },
    { name: "maxSharesBurned", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Default slippage tolerance for ERC-4626 supply/withdraw share/asset bounds (0.5%). */
const YIELD_SLIPPAGE_BPS = 50n;
const BPS = 10000n;

/** ERC-4626 preview/read surface used to bind slippage into the signed intent. */
const ERC4626_PREVIEW_ABI = [
  { type: "function", name: "previewDeposit", stateMutability: "view", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "previewWithdraw", stateMutability: "view", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "previewRedeem", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "maxRedeem", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export type YieldProtocol = "aave" | "morpho" | "lista";

/** Aave V3 Pool per chain — must equal the v2 impl's on-chain allowlist. */
const AAVE_POOL: Partial<Record<AgenticChainKey, Address>> = {
  bnb: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
};

const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_DEADLINE_AHEAD = 600;

/** Minimal ERC-4626 maxWithdraw read for the withdraw liquidity pre-check.
 *  maxWithdraw(owner) = min(owner's redeemable assets, the vault's currently
 *  available liquidity) — a Lista/Morpho lending vault can return less than the
 *  owner's balance when utilization is high (Lista blocks only near ~99.99%). */
const MAXWITHDRAW_ABI = [
  { type: "function", name: "maxWithdraw", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Default v2 impl per chain (the chain's DEFAULT protocol — Aave on BNB, Morpho
 *  on Base). Set after the audited deploy via YIELD_IMPL_<CHAIN>. Lista does NOT
 *  use this — it resolves its own YIELD_IMPL_<CHAIN>_LISTA via yieldImplFor. */
export function yieldImplAddress(chain: AgenticChainKey): Address | undefined {
  const v = process.env[`YIELD_IMPL_${chain.toUpperCase()}`];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

/**
 * The EIP-7702 impl to delegate to for a (chain, protocol). The delegation target
 * is protocol-SPECIFIC: an Aave withdraw needs the impl exposing withdrawFromAave;
 * a Lista (ERC-4626) deposit/withdraw needs withdrawFromErc4626. A single
 * YIELD_IMPL_<CHAIN> can't serve both, so a coexisting protocol resolves its OWN
 * env YIELD_IMPL_<CHAIN>_<PROTOCOL>.
 *
 * lista NEVER falls back to YIELD_IMPL_<CHAIN> (that's the Aave impl on BNB) — it
 * returns undefined unless YIELD_IMPL_<CHAIN>_LISTA is set, so enabling the deposit
 * flag without deploying + wiring the ERC-4626 impl fails closed
 * (YIELD_IMPL_NOT_DEPLOYED) instead of mis-delegating to the Aave impl and burning
 * gas on every deposit (the P0 enable-ordering trap). aave/morpho keep the
 * chain-default env.
 */
export function yieldImplFor(chain: AgenticChainKey, protocol: YieldProtocol): Address | undefined {
  const specific = process.env[`YIELD_IMPL_${chain.toUpperCase()}_${protocol.toUpperCase()}`];
  if (specific && /^0x[0-9a-fA-F]{40}$/.test(specific)) return specific as Address;
  if (protocol === "lista") return undefined; // fail closed — never the Aave impl
  return yieldImplAddress(chain);
}

/**
 * Which yield protocol a NEW DEPOSIT settles into on this chain. Lista (BNB
 * ERC-4626) takes precedence over Aave when its deposit flag is on
 * (listaDepositChains is gated by LISTA_YIELD_ENABLED), so flipping the flag pivots
 * NEW BNB deposits from Aave to Lista. Default off → BNB stays Aave, Base stays
 * Morpho. WITHDRAWALS do NOT use this — they route by the position's OWN protocol
 * (so legacy Aave + new Lista funds are both recoverable).
 */
export function yieldDepositProtocol(chain: AgenticChainKey): YieldProtocol | null {
  if (listaDepositChains().includes(chain)) return "lista"; // gated by LISTA_YIELD_ENABLED
  if (AAVE_POOL[chain]) return "aave";
  if (morphoVaultFor(chain) !== null) return "morpho";
  return null;
}
/** @deprecated Renamed to clarify it is the DEPOSIT selector (withdraws route by
 *  the position's own protocol). Kept so existing imports resolve. */
export const yieldProtocolForChain = yieldDepositProtocol;

/** Chains where yield deposit/withdraw is wired (a configured target + a deployed
 *  impl for that chain's protocol). Uses CONFIGURED (not deposit-gated) Lista
 *  chains so withdraw stays wired even with deposits off. */
export function yieldExecChains(): AgenticChainKey[] {
  const aave = (Object.keys(AAVE_POOL) as AgenticChainKey[]).filter((c) => yieldImplFor(c, "aave"));
  const morpho = (morphoSupportedChains() as AgenticChainKey[]).filter((c) => yieldImplFor(c, "morpho"));
  const lista = (listaConfiguredChains() as AgenticChainKey[]).filter((c) => yieldImplFor(c, "lista"));
  return [...new Set([...aave, ...morpho, ...lista])];
}

export interface SignedYieldAction {
  chain: AgenticChainKey;
  protocol: YieldProtocol;
  action: YieldAction;
  asset: AgenticToken;
  /** The exact asset token address that was signed (submit THIS, never re-resolve). */
  assetAddress: Address;
  /** The settle target: Aave Pool (aave) or the ERC-4626 vault (morpho). */
  pool: Address;
  fromAddr: Address;
  /** The facilitator bound into the witness — the relayer MUST match it. */
  signedFacilitator: Address;
  amount: string; // human string; "max" = max currently redeemable (maxRedeem, can be < full position)
  amountRaw: bigint;
  /** ERC-4626 slippage bounds bound into the witness (0 / MAX for Aave). */
  minSharesOut: bigint;
  minAssetsOut: bigint;
  maxSharesBurned: bigint;
  nonceUint: bigint;
  deadline: bigint;
  witnessSig: Hex;
  authorization: SignedAuthorization;
}

interface SignYieldParams {
  privateKey: Hex;
  /** Wallet RECORD address; the derived signer is asserted to equal it before
   *  signing (F5 — a swapped key blob can't sign from another record). */
  expectedOwner: Address;
  chain: AgenticChainKey;
  // Yield is stablecoin-only (Aave/Morpho USDC/USDT markets). Q is NOT a yield
  // asset — narrow here so the union can never route Q into a vault.
  token: "USDC" | "USDT";
  action: YieldAction;
  /** Human decimal string. For withdraw, "max" = max currently redeemable (maxRedeem, can be < full position). */
  amount: string;
  facilitator: Address;
  deadlineSeconds?: number;
  authorizationNonce?: number;
  /** Withdraw: the position's OWN protocol + market (from listAllPositions), so a
   *  legacy Aave position withdraws via Aave even while Lista is the deposit venue.
   *  Omit for deposits — protocol is then the chain's deposit selector. */
  protocol?: YieldProtocol;
  marketAddress?: Address;
}

/**
 * Sign an Aave supply/withdraw witness + matching EIP-7702 authorization.
 * Returns the body ready to forward to the yield relay path. Fails closed
 * (throws) if the chain has no Aave Pool or no deployed v2 impl.
 */
export async function signYieldAction(p: SignYieldParams): Promise<SignedYieldAction> {
  const cfg = AGENTIC_CHAINS[p.chain];
  if (!cfg) throw new Error(`UNSUPPORTED_CHAIN:${p.chain}`);
  // Protocol: explicit (withdraw → the position's own protocol) else the chain's
  // deposit selector. So a legacy Aave position withdraws via Aave even after the
  // flag pivots NEW deposits to Lista.
  const protocol = p.protocol ?? yieldDepositProtocol(p.chain);
  if (!protocol) throw new Error(`YIELD_NO_PROTOCOL:${p.chain}`);
  // Settle target: Aave Pool, the curated Morpho vault (Base, USDC-only), or a
  // Lista MoolahVault (BNB ERC-4626). When a marketAddress is supplied (withdraw),
  // it is VALIDATED against the protocol's allowlist, never trusted blindly.
  let target: Address;
  if (protocol === "aave") {
    const pool = AAVE_POOL[p.chain];
    if (!pool) throw new Error(`YIELD_NO_POOL:${p.chain}`);
    if (p.marketAddress && p.marketAddress.toLowerCase() !== pool.toLowerCase()) {
      throw new Error(`YIELD_MARKET_NOT_ALLOWED:${p.marketAddress}`);
    }
    target = pool;
  } else if (protocol === "lista") {
    if (p.marketAddress) {
      if (!isListaVaultAllowed(p.chain, p.token, p.marketAddress)) throw new Error(`YIELD_MARKET_NOT_ALLOWED:${p.marketAddress}`);
      target = p.marketAddress;
    } else {
      const vault = listaVaultFor(p.chain, p.token);
      if (!vault) throw new Error(`YIELD_NO_VAULT:${p.chain}:${p.token}`);
      target = vault;
    }
  } else {
    const vault = morphoVaultFor(p.chain, p.token);
    if (!vault) throw new Error(`YIELD_NO_VAULT:${p.chain}:${p.token}`);
    if (p.marketAddress && p.marketAddress.toLowerCase() !== vault.toLowerCase()) {
      throw new Error(`YIELD_MARKET_NOT_ALLOWED:${p.marketAddress}`);
    }
    target = vault;
  }
  const impl = yieldImplFor(p.chain, protocol);
  if (!impl) throw new Error(`YIELD_IMPL_NOT_DEPLOYED:${p.chain}:${protocol}`);

  const tokenCfg = cfg.tokens[p.token];
  if (!tokenCfg) throw new Error(`UNSUPPORTED_TOKEN:${p.token}`);

  // Amount: withdraw supports the "max" sentinel (full aToken balance).
  let amountRaw: bigint;
  const isMax = p.action === "withdraw" && p.amount.trim().toLowerCase() === "max";
  if (isMax) {
    amountRaw = MAX_UINT256;
  } else {
    try {
      amountRaw = parseUnitsStrict(p.amount, tokenCfg.decimals);
    } catch {
      throw new Error("AMOUNT_PRECISION_TOO_HIGH");
    }
    if (amountRaw <= 0n) throw new Error("INVALID_AMOUNT");
    // supply MUST NOT be max (contract rejects it); guard early.
    if (p.action === "supply" && amountRaw === MAX_UINT256) throw new Error("INVALID_AMOUNT");
  }

  const nonceUint = randomUint256Nonce();
  const deadline = BigInt(
    Math.floor(Date.now() / 1000) + (p.deadlineSeconds ?? DEFAULT_DEADLINE_AHEAD),
  );

  const account = privateKeyToAccount(p.privateKey);
  const fromAddr = account.address as Address;
  if (fromAddr.toLowerCase() !== p.expectedOwner.toLowerCase()) {
    throw new Error("KEY_RECORD_MISMATCH");
  }

  const viemChain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  } as const;

  // Liquidity pre-check for ERC-4626 withdraws (Lista / Morpho): a fixed-amount
  // withdraw whose assets exceed the vault's available liquidity reverts on-chain
  // AFTER the relayer paid gas. Reject pre-broadcast with the available amount so
  // the caller can size down (Lista blocks withdraws only near ~99.99% utilization,
  // but the edge is real for pay-from-yield). A "max" withdraw uses redeem(maxRedeem),
  // which is already liquidity-bounded, so it is exempt. RPC read failures are
  // swallowed — the on-chain call still guards funds; we just don't block an honest
  // withdraw on a transient blip.
  if (p.action === "withdraw" && !isMax && (protocol === "lista" || protocol === "morpho")) {
    try {
      const pub = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });
      const maxW = (await pub.readContract({ address: target, abi: MAXWITHDRAW_ABI, functionName: "maxWithdraw", args: [fromAddr] })) as bigint;
      if (amountRaw > maxW) throw new Error(`YIELD_INSUFFICIENT_LIQUIDITY:${formatUnits(maxW, tokenCfg.decimals)}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("YIELD_INSUFFICIENT_LIQUIDITY")) throw e;
    }
  }

  // MD-01 / L-01: bind slippage into the ERC-4626 intent so the signed consent
  // covers the share/asset outcome, not just the amount. Aave aTokens are 1:1 and
  // carry no share-price slippage, so they keep the original witness. Fail closed on
  // a read error — we never sign an unbounded intent.
  let minSharesOut = 0n;
  let minAssetsOut = 0n;
  let maxSharesBurned = MAX_UINT256;
  if (protocol === "lista" || protocol === "morpho") {
    try {
      const pub = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });
      const rd = (fn: "previewDeposit" | "previewWithdraw" | "previewRedeem" | "maxRedeem", args: readonly unknown[]) =>
        pub.readContract({ address: target, abi: ERC4626_PREVIEW_ABI, functionName: fn, args } as never) as Promise<bigint>;
      if (p.action === "supply") {
        const expShares = await rd("previewDeposit", [amountRaw]);
        minSharesOut = (expShares * (BPS - YIELD_SLIPPAGE_BPS)) / BPS;
      } else if (isMax) {
        // max path redeems maxRedeem shares; the meaningful floor is assets out.
        const shares = await rd("maxRedeem", [fromAddr]);
        const expAssets = shares > 0n ? await rd("previewRedeem", [shares]) : 0n;
        minAssetsOut = (expAssets * (BPS - YIELD_SLIPPAGE_BPS)) / BPS;
        maxSharesBurned = MAX_UINT256;
      } else {
        // fixed withdraw delivers exactly `amount` assets; bound the shares it burns.
        minAssetsOut = amountRaw;
        const expShares = await rd("previewWithdraw", [amountRaw]);
        maxSharesBurned = (expShares * (BPS + YIELD_SLIPPAGE_BPS)) / BPS;
      }
    } catch {
      throw new Error("YIELD_SLIPPAGE_PRECHECK_FAILED");
    }
  }

  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(cfg.rpc) });

  const domain = {
    name: cfg.domainName,
    version: cfg.domainVersion,
    chainId: cfg.id,
    verifyingContract: fromAddr, // == address(this) under 7702
  };
  // Build the protocol-correct witness. The message field is `pool` (Aave) or
  // `vault` (ERC-4626); both carry `target`. Split branches so viem infers the
  // message type from a concrete (types, primaryType) pair.
  let witnessSig: Hex;
  if (protocol === "aave") {
    const message = { owner: fromAddr, facilitator: p.facilitator, pool: target, asset: tokenCfg.address, amount: amountRaw, nonce: nonceUint, deadline };
    witnessSig = (p.action === "supply"
      ? await walletClient.signTypedData({ domain, types: AAVE_SUPPLY_AUTH_TYPES, primaryType: "AaveSupplyAuthorization", message })
      : await walletClient.signTypedData({ domain, types: AAVE_WITHDRAW_AUTH_TYPES, primaryType: "AaveWithdrawAuthorization", message })) as Hex;
  } else if (p.action === "supply") {
    const message = { owner: fromAddr, facilitator: p.facilitator, vault: target, asset: tokenCfg.address, amount: amountRaw, minSharesOut, nonce: nonceUint, deadline };
    witnessSig = (await walletClient.signTypedData({ domain, types: ERC4626_SUPPLY_AUTH_TYPES, primaryType: "Erc4626SupplyAuthorization", message })) as Hex;
  } else {
    const message = { owner: fromAddr, facilitator: p.facilitator, vault: target, asset: tokenCfg.address, amount: amountRaw, minAssetsOut, maxSharesBurned, nonce: nonceUint, deadline };
    witnessSig = (await walletClient.signTypedData({ domain, types: ERC4626_WITHDRAW_AUTH_TYPES, primaryType: "Erc4626WithdrawAuthorization", message })) as Hex;
  }

  // EIP-7702 authorization delegating to the v2 impl (the one exposing
  // supplyToAave/withdrawFromAave). Distinct from cfg.impl (v1 transfer).
  let txNonce = p.authorizationNonce;
  if (txNonce === undefined) {
    const publicClient = createPublicClient({ chain: viemChain, transport: http(cfg.rpc) });
    txNonce = await publicClient.getTransactionCount({ address: fromAddr });
  }

  const auth = await account.signAuthorization({ chainId: cfg.id, address: impl, nonce: txNonce });
  if (auth.yParity === undefined || auth.r === undefined || auth.s === undefined) {
    throw new Error("signAuthorization returned an incomplete signature");
  }

  return {
    chain: p.chain,
    protocol,
    action: p.action,
    asset: p.token,
    assetAddress: tokenCfg.address,
    pool: target,
    fromAddr,
    signedFacilitator: p.facilitator,
    amount: isMax ? "max" : p.amount,
    amountRaw,
    minSharesOut,
    minAssetsOut,
    maxSharesBurned,
    nonceUint,
    deadline,
    witnessSig,
    authorization: {
      chainId: cfg.id,
      address: impl,
      nonce: txNonce,
      yParity: auth.yParity,
      r: auth.r as Hex,
      s: auth.s as Hex,
    },
  };
}

/** parseUnits that rejects extra precision (mirrors agentic transfer path). */
function parseUnitsStrict(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  if (!/^\d+$/.test(whole) || (frac !== "" && !/^\d+$/.test(frac))) throw new Error("bad number");
  if (frac.length > decimals) throw new Error("too many decimals");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}
