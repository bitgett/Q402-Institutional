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

/** Chains where Aave yield deposit/withdraw is wired (pool + deployed impl). */
export function yieldExecChains(): AgenticChainKey[] {
  return (Object.keys(AAVE_POOL) as AgenticChainKey[]).filter((c) => yieldImplAddress(c));
}

export interface SignedYieldAction {
  chain: AgenticChainKey;
  action: YieldAction;
  asset: AgenticToken;
  /** The exact asset token address that was signed (submit THIS, never re-resolve). */
  assetAddress: Address;
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
  chain: AgenticChainKey;
  token: AgenticToken;
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
  const pool = AAVE_POOL[p.chain];
  if (!pool) throw new Error(`YIELD_NO_POOL:${p.chain}`);
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
  const message = {
    owner: fromAddr,
    facilitator: p.facilitator,
    pool,
    asset: tokenCfg.address,
    amount: amountRaw,
    nonce: nonceUint,
    deadline,
  };

  // Split branches so viem infers the message type from a concrete
  // (types, primaryType) pair — a ternary union collapses it to `never`.
  const witnessSig = (p.action === "supply"
    ? await walletClient.signTypedData({ domain, types: AAVE_SUPPLY_AUTH_TYPES, primaryType: "AaveSupplyAuthorization", message })
    : await walletClient.signTypedData({ domain, types: AAVE_WITHDRAW_AUTH_TYPES, primaryType: "AaveWithdrawAuthorization", message })) as Hex;

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
    action: p.action,
    asset: p.token,
    assetAddress: tokenCfg.address,
    pool,
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
