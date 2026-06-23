/**
 * Q402 Yield — relayer-side settlement of Aave supply/withdraw.
 *
 * Mirrors relayer.ts settlePayment's EIP-7702 type-4 construction: the
 * relayer (facilitator + gas payer) sends a type-4 tx to the Agent Wallet
 * EOA with an authorizationList delegating the v2 impl, calling
 * supplyToAave/withdrawFromAave. The Agent Wallet never holds native gas.
 *
 * The signed `facilitator` in the witness MUST equal the relayer address
 * (the v2 contract enforces msg.sender == facilitator), so callers sign
 * with yieldFacilitator() and settle here with the same key.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  formatEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kv } from "@vercel/kv";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";
import type { SignedYieldAction } from "./sign";

// ── Per-owner daily yield-operation cap (gas-budget rail) ──────────────────
//
// Yield is intentionally fee-free — the relayer pays the Aave gas with NO
// per-op credit decrement. Without a ceiling, a valid-but-abusive caller
// (live trial/sub key, passes every gate) could fire yield ops in a loop and
// drain the relayer's gas wallet unbounded. This is the guard rail: a per
// (owner, UTC-day) operation COUNT, INCR'd before settle and refunded on a
// non-settlement. Same INCR + per-day-key + TTL idiom as agentic-wallet.ts's
// chargeAgainstDailyLimit, but counting operations (gas cost is roughly
// fixed per op) rather than USD notional.
//
// Override via YIELD_DAILY_OP_CAP env; default 50/owner/day comfortably
// exceeds any honest deposit/withdraw/rebalance pattern while capping the
// blast radius of a leaked key at ~50 × per-op gas.
const YIELD_OP_DAY_TTL_SEC = 48 * 60 * 60;

function yieldOpCountKey(owner: string, dateUtc: string): string {
  return `aw:yield:opcount:${owner.toLowerCase()}:${dateUtc}`;
}

function yieldDailyOpCap(): number {
  const raw = Number(process.env.YIELD_DAILY_OP_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}

/**
 * Atomically reserve one yield-op against the owner's daily cap. INCR the
 * per-day counter; if it overshoots, INCR back (-1) and deny. Mirrors
 * chargeAgainstDailyLimit's reserve-then-rollback shape. Caller MUST
 * `refundYieldOpBudget` on any non-settlement so a failed op doesn't burn a
 * cap slot.
 *
 * Fail-OPEN on a KV error: yield is fund-safe regardless of this counter
 * (the policy gate + locks guard funds), and the counter is purely a relayer
 * gas-abuse rail — a KV blip must not block an honest user's legitimate
 * deposit. The blast radius without it is one day's relayer gas, which the
 * relayer's own balance bounds.
 */
export async function chargeYieldOpBudget(
  owner: string,
): Promise<{ allowed: boolean; count: number; cap: number }> {
  const cap = yieldDailyOpCap();
  const dateUtc = new Date().toISOString().slice(0, 10);
  const key = yieldOpCountKey(owner, dateUtc);
  let count: number;
  try {
    count = await kv.incr(key);
  } catch {
    return { allowed: true, count: 0, cap }; // fail-open — see docstring
  }
  // Set the TTL on first write so the counter self-flushes daily.
  if (count === 1) {
    try { await kv.expire(key, YIELD_OP_DAY_TTL_SEC); } catch { /* best-effort */ }
  }
  if (count > cap) {
    // Roll back the reservation we just made (INCR overshot the cap).
    try { await kv.decr(key); } catch { /* best-effort */ }
    return { allowed: false, count: count - 1, cap };
  }
  return { allowed: true, count, cap };
}

/** Release a reserved yield-op slot (failed/rejected before settlement). */
export async function refundYieldOpBudget(owner: string): Promise<void> {
  const dateUtc = new Date().toISOString().slice(0, 10);
  const key = yieldOpCountKey(owner, dateUtc);
  try { await kv.decr(key); } catch { /* best-effort — TTL flushes anyway */ }
}

const YIELD_IMPL_ABI = [
  {
    type: "function",
    name: "supplyToAave",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "facilitator", type: "address" },
      { name: "pool", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witnessSignature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawFromAave",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "facilitator", type: "address" },
      { name: "pool", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witnessSignature", type: "bytes" },
    ],
    outputs: [{ name: "withdrawn", type: "uint256" }],
  },
] as const;

// ERC-4626 (Morpho) yield impl ABI — function names match the BASE v2 contract.
const YIELD_ERC4626_ABI = [
  {
    type: "function", name: "supplyToErc4626", stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" }, { name: "facilitator", type: "address" },
      { name: "vault", type: "address" }, { name: "asset", type: "address" },
      { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }, { name: "witnessSignature", type: "bytes" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function", name: "withdrawFromErc4626", stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" }, { name: "facilitator", type: "address" },
      { name: "vault", type: "address" }, { name: "asset", type: "address" },
      { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }, { name: "witnessSignature", type: "bytes" },
    ],
    outputs: [{ name: "assetsOut", type: "uint256" }],
  },
] as const;

export interface YieldSettleResult {
  success: boolean;
  txHash?: string;
  blockNumber?: bigint;
  gasCostNative?: number;
  error?: string;
  /** true when the tx WAS broadcast but the receipt couldn't be confirmed
   *  (RPC timeout). The caller MUST NOT release idempotency on this — the
   *  action may have settled; a retry would double it. */
  uncertain?: boolean;
}

/** Relayer/facilitator address, or null if the key is unset/mismatched. */
export function yieldFacilitator(): Address | null {
  const k = loadRelayerKey();
  if (!k.ok) return null;
  return privateKeyToAccount(k.privateKey).address;
}

/**
 * Submit a signed Aave supply/withdraw as an EIP-7702 type-4 tx. The
 * relayer pays gas; the Agent Wallet (a.fromAddr) executes the v2 impl.
 */
export async function settleYieldAction(a: SignedYieldAction): Promise<YieldSettleResult> {
  const k = loadRelayerKey();
  if (!k.ok) {
    return { success: false, error: k.reason === "mismatch" ? "Relayer key/address mismatch" : "RELAYER_PRIVATE_KEY not set" };
  }

  const cfg = AGENTIC_CHAINS[a.chain];
  if (!cfg) return { success: false, error: `UNSUPPORTED_CHAIN:${a.chain}` };

  const account = privateKeyToAccount(k.privateKey);
  // The witness is bound to a specific facilitator and the v2 contract
  // enforces msg.sender == facilitator. Refuse to submit with a relayer
  // other than the one signed for — fail BEFORE spending gas on a tx the
  // contract would revert.
  if (account.address.toLowerCase() !== a.signedFacilitator.toLowerCase()) {
    return { success: false, error: "facilitator_mismatch" };
  }

  const walletClient = createWalletClient({ account, transport: http(cfg.rpc) });
  const publicClient = createPublicClient({ transport: http(cfg.rpc) });

  // Submit exactly the asset/target that was SIGNED (never re-resolve from
  // config — a divergence would mismatch the witness and revert). Branch the
  // ABI + function by protocol (Aave Pool vs ERC-4626 vault); args are identical.
  let callData: `0x${string}`;
  if (a.protocol === "aave") {
    callData = encodeFunctionData({
      abi: YIELD_IMPL_ABI,
      functionName: a.action === "supply" ? "supplyToAave" : "withdrawFromAave",
      args: [a.fromAddr, account.address, a.pool, a.assetAddress, a.amountRaw, a.nonceUint, a.deadline, a.witnessSig],
    });
  } else {
    callData = encodeFunctionData({
      abi: YIELD_ERC4626_ABI,
      functionName: a.action === "supply" ? "supplyToErc4626" : "withdrawFromErc4626",
      args: [a.fromAddr, account.address, a.pool, a.assetAddress, a.amountRaw, a.nonceUint, a.deadline, a.witnessSig],
    });
  }

  const authorizationList = [
    {
      chainId: a.authorization.chainId,
      address: a.authorization.address, // v2 impl
      nonce: a.authorization.nonce,
      yParity: a.authorization.yParity,
      r: a.authorization.r,
      s: a.authorization.s,
    },
  ];

  // Gas: estimate with a buffer; fall back to a generous fixed cap.
  // supply does approve(+reset) + Pool.supply (first supply of an asset is
  // costly on Aave); withdraw is lighter.
  const fallbackGas = a.action === "supply" ? 700_000n : 450_000n;
  let gas = fallbackGas;
  try {
    const est = await publicClient.estimateGas({
      account, to: a.fromAddr, data: callData, authorizationList,
    });
    const buffered = (est * 13n) / 10n; // +30%
    gas = buffered > fallbackGas ? buffered : fallbackGas;
  } catch {
    // estimate can fail before delegation is set; use the fixed cap.
  }

  // Phase 1: broadcast. A failure here means the tx never went out.
  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.sendTransaction({
      chain: null,
      to: a.fromAddr, // the Agent Wallet EOA (runs v2 impl code under 7702)
      data: callData,
      gas,
      authorizationList,
    });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Phase 2: confirm. The tx IS broadcast now — a receipt-read failure is
  // UNCERTAIN, not failed. Surface txHash + uncertain so the caller keeps
  // idempotency (a retry could double the action).
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasCostNative = parseFloat(
      formatEther((receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n)),
    );
    return {
      success: receipt.status === "success",
      txHash,
      blockNumber: receipt.blockNumber,
      gasCostNative,
      error: receipt.status !== "success" ? "Transaction reverted" : undefined,
    };
  } catch (e) {
    return { success: false, uncertain: true, txHash, error: e instanceof Error ? e.message : String(e) };
  }
}
