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
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type YieldProtocol = "aave" | "morpho";

/** Aave V3 Pool per chain — must equal the v2 impl's on-chain allowlist. */
const AAVE_POOL: Partial<Record<AgenticChainKey, Address>> = {
  bnb: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
};

const MAX_UINT256 = (1n << 256n) - 1n;
const DEFAULT_DEADLINE_AHEAD = 600;

/** v2 impl (with supplyToAave) per chain — set after the audited deploy. */
export function yieldImplAddress(chain: AgenticChainKey): Address | undefined {
  const v = process.env[`YIELD_IMPL_${chain.toUpperCase()}`];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

/** Which yield protocol settles on this chain: Aave (BNB) or Morpho/ERC-4626 (Base). */
export function yieldProtocolForChain(chain: AgenticChainKey): YieldProtocol | null {
  if (AAVE_POOL[chain]) return "aave";
  if (morphoVaultFor(chain) !== null) return "morpho";
  return null;
}

/** Chains where yield deposit/withdraw is wired (target + deployed impl). */
export function yieldExecChains(): AgenticChainKey[] {
  const aave = (Object.keys(AAVE_POOL) as AgenticChainKey[]).filter((c) => yieldImplAddress(c));
  const morpho = (morphoSupportedChains() as AgenticChainKey[]).filter((c) => yieldImplAddress(c));
  return [...new Set([...aave, ...morpho])];
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
  amount: string; // human string; "max" for withdraw-all
  amountRaw: bigint;
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
  /** Human decimal string. For withdraw, "max" = full position. */
  amount: string;
  facilitator: Address;
  deadlineSeconds?: number;
  authorizationNonce?: number;
}

/**
 * Sign an Aave supply/withdraw witness + matching EIP-7702 authorization.
 * Returns the body ready to forward to the yield relay path. Fails closed
 * (throws) if the chain has no Aave Pool or no deployed v2 impl.
 */
export async function signYieldAction(p: SignYieldParams): Promise<SignedYieldAction> {
  const cfg = AGENTIC_CHAINS[p.chain];
  if (!cfg) throw new Error(`UNSUPPORTED_CHAIN:${p.chain}`);
  const protocol = yieldProtocolForChain(p.chain);
  if (!protocol) throw new Error(`YIELD_NO_PROTOCOL:${p.chain}`);
  // Settle target: Aave Pool, or the curated ERC-4626 vault (Morpho, USDC-only).
  let target: Address;
  if (protocol === "aave") {
    const pool = AAVE_POOL[p.chain];
    if (!pool) throw new Error(`YIELD_NO_POOL:${p.chain}`);
    target = pool;
  } else {
    const vault = morphoVaultFor(p.chain, p.token);
    if (!vault) throw new Error(`YIELD_NO_VAULT:${p.chain}:${p.token}`);
    target = vault;
  }
  const impl = yieldImplAddress(p.chain);
  if (!impl) throw new Error(`YIELD_IMPL_NOT_DEPLOYED:${p.chain}`);

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
  } else {
    const message = { owner: fromAddr, facilitator: p.facilitator, vault: target, asset: tokenCfg.address, amount: amountRaw, nonce: nonceUint, deadline };
    witnessSig = (p.action === "supply"
      ? await walletClient.signTypedData({ domain, types: ERC4626_SUPPLY_AUTH_TYPES, primaryType: "Erc4626SupplyAuthorization", message })
      : await walletClient.signTypedData({ domain, types: ERC4626_WITHDRAW_AUTH_TYPES, primaryType: "Erc4626WithdrawAuthorization", message })) as Hex;
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
