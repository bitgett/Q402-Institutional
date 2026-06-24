/**
 * Q402 Q Staking — relayer-side settlement of stakeQuack/unstakeQuack.
 *
 * Mirrors app/lib/yield/relay.ts: the relayer (facilitator + gas payer) sends a
 * type-4 tx to the Agent Wallet EOA with an authorizationList delegating the
 * deployed Q402StakingImplementationBNB, calling stakeQuack/unstakeQuack. The
 * Agent Wallet never holds native gas. The signed `facilitator` MUST equal the
 * relayer (the impl enforces msg.sender == facilitator).
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
import type { SignedStakeAction } from "./sign";

// ── Per-owner daily stake-op cap (relayer gas-abuse rail, mirrors yield) ────
const STAKE_OP_DAY_TTL_SEC = 48 * 60 * 60;
function stakeOpCountKey(owner: string, dateUtc: string): string {
  return `aw:stake:opcount:${owner.toLowerCase()}:${dateUtc}`;
}
function stakeDailyOpCap(): number {
  const raw = Number(process.env.STAKE_DAILY_OP_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
}

/** Reserve one stake-op against the owner's daily cap (fail-CLOSED on KV error.
 *  A stake op can't proceed without KV anyway — the wallet-chain lock + the
 *  idempotency SET NX both run on KV just before this and already 409/503 when
 *  KV is down — so denying here adds no new false-negative, and it closes the
 *  gas-rail bypass a fail-open would allow during a partial KV degradation.) */
export async function chargeStakeOpBudget(owner: string): Promise<{ allowed: boolean; count: number; cap: number }> {
  const cap = stakeDailyOpCap();
  const dateUtc = new Date().toISOString().slice(0, 10);
  const key = stakeOpCountKey(owner, dateUtc);
  let count: number;
  try {
    count = await kv.incr(key);
  } catch {
    return { allowed: false, count: 0, cap };
  }
  if (count === 1) {
    try { await kv.expire(key, STAKE_OP_DAY_TTL_SEC); } catch { /* best-effort */ }
  }
  if (count > cap) {
    try { await kv.decr(key); } catch { /* best-effort */ }
    return { allowed: false, count: count - 1, cap };
  }
  return { allowed: true, count, cap };
}

export async function refundStakeOpBudget(owner: string): Promise<void> {
  const dateUtc = new Date().toISOString().slice(0, 10);
  const key = stakeOpCountKey(owner, dateUtc);
  try { await kv.decr(key); } catch { /* best-effort — TTL flushes anyway */ }
}

const STAKE_IMPL_ABI = [
  {
    type: "function", name: "stakeQuack", stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" }, { name: "facilitator", type: "address" },
      { name: "stakeContract", type: "address" }, { name: "token", type: "address" },
      { name: "stakeType", type: "uint256" }, { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      { name: "witnessSignature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "unstakeQuack", stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" }, { name: "facilitator", type: "address" },
      { name: "stakeContract", type: "address" }, { name: "ith", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      { name: "witnessSignature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface StakeSettleResult {
  success: boolean;
  txHash?: string;
  blockNumber?: bigint;
  gasCostNative?: number;
  error?: string;
  /** Broadcast but receipt unconfirmed — caller MUST keep idempotency (a retry
   *  could double the action). */
  uncertain?: boolean;
}

/** Relayer/facilitator address, or null if the key is unset/mismatched. */
export function stakeFacilitator(): Address | null {
  const k = loadRelayerKey();
  if (!k.ok) return null;
  return privateKeyToAccount(k.privateKey).address;
}

/**
 * Submit a signed stake/unstake as an EIP-7702 type-4 tx. The relayer pays gas;
 * the Agent Wallet (a.fromAddr) executes the staking impl.
 */
export async function settleStakeAction(a: SignedStakeAction): Promise<StakeSettleResult> {
  const k = loadRelayerKey();
  if (!k.ok) {
    return { success: false, error: k.reason === "mismatch" ? "Relayer key/address mismatch" : "RELAYER_PRIVATE_KEY not set" };
  }
  const cfg = AGENTIC_CHAINS[a.chain];
  if (!cfg) return { success: false, error: `UNSUPPORTED_CHAIN:${a.chain}` };

  const account = privateKeyToAccount(k.privateKey);
  // The witness binds the facilitator; the impl enforces msg.sender == facilitator.
  // Refuse to submit with a relayer other than the one signed for.
  if (account.address.toLowerCase() !== a.signedFacilitator.toLowerCase()) {
    return { success: false, error: "facilitator_mismatch" };
  }

  const walletClient = createWalletClient({ account, transport: http(cfg.rpc) });
  const publicClient = createPublicClient({ transport: http(cfg.rpc) });

  // Submit exactly what was SIGNED (never re-resolve — a divergence mismatches
  // the witness and reverts).
  const callData: `0x${string}` =
    a.action === "stake"
      ? encodeFunctionData({
          abi: STAKE_IMPL_ABI, functionName: "stakeQuack",
          args: [a.fromAddr, account.address, a.stakeContract, a.token, BigInt(a.stakeType), a.amountRaw, a.nonceUint, a.deadline, a.witnessSig],
        })
      : encodeFunctionData({
          abi: STAKE_IMPL_ABI, functionName: "unstakeQuack",
          args: [a.fromAddr, account.address, a.stakeContract, BigInt(a.ith ?? 0), a.nonceUint, a.deadline, a.witnessSig],
        });

  const authorizationList = [{
    chainId: a.authorization.chainId,
    address: a.authorization.address, // staking impl
    nonce: a.authorization.nonce,
    yParity: a.authorization.yParity,
    r: a.authorization.r,
    s: a.authorization.s,
  }];

  // Gas: estimate with a buffer; stake does approve + external stake + two
  // balanceOf reads, so it's heavier than a transfer. Fall back generously.
  const fallbackGas = a.action === "stake" ? 600_000n : 400_000n;
  let gas = fallbackGas;
  try {
    const est = await publicClient.estimateGas({ account, to: a.fromAddr, data: callData, authorizationList });
    const buffered = (est * 13n) / 10n; // +30%
    gas = buffered > fallbackGas ? buffered : fallbackGas;
  } catch {
    // estimate can fail before delegation is set; use the fixed cap.
  }

  // Phase 1: broadcast.
  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.sendTransaction({ chain: null, to: a.fromAddr, data: callData, gas, authorizationList });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Phase 2: confirm. Broadcast already happened — a receipt-read failure is
  // UNCERTAIN, not failed (a retry could double the action).
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasCostNative = parseFloat(formatEther((receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n)));
    return {
      success: receipt.status === "success",
      txHash, blockNumber: receipt.blockNumber, gasCostNative,
      error: receipt.status !== "success" ? "Transaction reverted" : undefined,
    };
  } catch (e) {
    return { success: false, uncertain: true, txHash, error: e instanceof Error ? e.message : String(e) };
  }
}
