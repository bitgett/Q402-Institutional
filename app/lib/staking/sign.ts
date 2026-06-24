/**
 * Q402 Q Staking — server-side EIP-712 + EIP-7702 signing for gasless Q stake /
 * unstake into QuackAiStake, mirroring app/lib/yield/sign.ts.
 *
 * The Agent Wallet (server-managed key) signs a Stake/Unstake witness + an
 * EIP-7702 authorization delegating to the deployed Q402StakingImplementationBNB
 * (stakeQuack/unstakeQuack). The relayer submits the type-4 tx + pays gas. Witness
 * field order MUST match the impl typehashes exactly
 * (contracts/staking/Q402StakingImplementationBNB.sol).
 *
 * BNB-only (Q lives only on BNB). The impl address is read from STAKE_IMPL_BNB;
 * until set, signStakeAction throws so the stake routes fail closed.
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
  type SignedAuthorization,
} from "@/app/lib/agentic-wallet-sign";

export type StakeAction = "stake" | "unstake";

/** QuackAiStake + Q on BNB — MUST equal the impl's immutable allowlist. */
export const QUACK_STAKE: Address = "0x7D23C17cE1baFaD881582DaE54C386feE515E96b";
export const Q_TOKEN: Address = "0xc07e1300dc138601FA6B0b59f8D0FA477e690589";
const Q_DECIMALS = 18;
const DEFAULT_DEADLINE_AHEAD = 600;

/** Lock-tier metadata (mirrors fuibox stakeConfig.stakeTypes). Display only —
 *  the staking contract is the source of truth + reverts on an unknown tier. */
export const STAKE_TIERS: ReadonlyArray<{ stakeType: number; lockDays: number; aprPct: number }> = [
  { stakeType: 0, lockDays: 30, aprPct: 10 },
  { stakeType: 1, lockDays: 60, aprPct: 15 },
  { stakeType: 2, lockDays: 120, aprPct: 32 },
  { stakeType: 3, lockDays: 180, aprPct: 40 },
];

// Field order is normative — keeps the off-chain witness byte-identical to the
// on-chain STAKE_/UNSTAKE_AUTHORIZATION_TYPEHASH.
const STAKE_AUTH_TYPES = {
  StakeAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "stakeContract", type: "address" },
    { name: "token", type: "address" },
    { name: "stakeType", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const UNSTAKE_AUTH_TYPES = {
  UnstakeAuthorization: [
    { name: "owner", type: "address" },
    { name: "facilitator", type: "address" },
    { name: "stakeContract", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Staking impl per chain (env STAKE_IMPL_<CHAIN>) — set after the audited deploy. */
export function stakeImplAddress(chain: AgenticChainKey): Address | undefined {
  const v = process.env[`STAKE_IMPL_${chain.toUpperCase()}`];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

/** Chains where Q staking is wired (BNB-only + a deployed impl). */
export function stakeExecChains(): AgenticChainKey[] {
  return (["bnb"] as AgenticChainKey[]).filter((c) => stakeImplAddress(c));
}

export interface SignStakeParams {
  privateKey: Hex;
  expectedOwner: Address;
  chain: AgenticChainKey;
  action: StakeAction;
  /** Tier 0-5 (stake only; ignored for unstake). */
  stakeType: number;
  /** Human Q decimal string. */
  amount: string;
  facilitator: Address;
  authorizationNonce?: number;
  deadlineSeconds?: number;
}

export interface SignedStakeAction {
  chain: AgenticChainKey;
  action: StakeAction;
  stakeContract: Address;
  token: Address;
  stakeType: number;
  fromAddr: Address;
  /** The facilitator bound into the witness — the relayer MUST match it. */
  signedFacilitator: Address;
  amount: string;
  amountRaw: bigint;
  nonceUint: bigint;
  deadline: bigint;
  witnessSig: Hex;
  authorization: SignedAuthorization;
}

export async function signStakeAction(p: SignStakeParams): Promise<SignedStakeAction> {
  // Q staking is BNB-only — Q lives only on BNB and the impl/allowlist are BNB.
  if (p.chain !== "bnb") throw new Error(`STAKE_CHAIN_UNSUPPORTED:${p.chain}`);
  const cfg = AGENTIC_CHAINS[p.chain];
  const impl = stakeImplAddress(p.chain);
  if (!impl) throw new Error(`STAKE_IMPL_NOT_DEPLOYED:${p.chain}`);

  const account = privateKeyToAccount(p.privateKey);
  const fromAddr = account.address as Address;
  if (fromAddr.toLowerCase() !== p.expectedOwner.toLowerCase()) throw new Error("SIGNER_OWNER_MISMATCH");

  let amountRaw: bigint;
  try {
    amountRaw = parseUnitsStrict(p.amount, Q_DECIMALS);
  } catch {
    throw new Error("AMOUNT_PRECISION_TOO_HIGH");
  }
  if (amountRaw <= 0n) throw new Error("INVALID_AMOUNT");

  const nonceUint = randomUint256Nonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (p.deadlineSeconds ?? DEFAULT_DEADLINE_AHEAD));

  const viemChain = {
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: cfg.name, symbol: cfg.name, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  } as const;
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(cfg.rpc) });
  const domain = {
    name: cfg.domainName,        // "Q402 BNB Chain"
    version: cfg.domainVersion,  // "1"
    chainId: cfg.id,
    verifyingContract: fromAddr, // == address(this) under 7702
  };

  let witnessSig: Hex;
  if (p.action === "stake") {
    const message = {
      owner: fromAddr, facilitator: p.facilitator, stakeContract: QUACK_STAKE, token: Q_TOKEN,
      stakeType: BigInt(p.stakeType), amount: amountRaw, nonce: nonceUint, deadline,
    };
    witnessSig = (await walletClient.signTypedData({ domain, types: STAKE_AUTH_TYPES, primaryType: "StakeAuthorization", message })) as Hex;
  } else {
    const message = {
      owner: fromAddr, facilitator: p.facilitator, stakeContract: QUACK_STAKE,
      amount: amountRaw, nonce: nonceUint, deadline,
    };
    witnessSig = (await walletClient.signTypedData({ domain, types: UNSTAKE_AUTH_TYPES, primaryType: "UnstakeAuthorization", message })) as Hex;
  }

  // EIP-7702 authorization delegating to the staking impl for this tx.
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
    stakeContract: QUACK_STAKE,
    token: Q_TOKEN,
    stakeType: p.stakeType,
    fromAddr,
    signedFacilitator: p.facilitator,
    amount: p.amount,
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

/** Test seam — the witness type tables, asserted byte-identical to the on-chain
 *  typehash strings by __tests__/staking-typehash-drift.test.ts. */
export const __test = { STAKE_AUTH_TYPES, UNSTAKE_AUTH_TYPES };

/** parseUnits that rejects extra precision (mirrors the agentic transfer path). */
function parseUnitsStrict(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  if (!/^\d+$/.test(whole) || (frac !== "" && !/^\d+$/.test(frac))) throw new Error("bad number");
  if (frac.length > decimals) throw new Error("too many decimals");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}
