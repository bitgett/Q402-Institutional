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
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";
import type { SignedYieldAction } from "./sign";

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

  const fnName = a.action === "supply" ? "supplyToAave" : "withdrawFromAave";
  // Submit exactly the asset that was SIGNED (never re-resolve from config —
  // a divergence would mismatch the witness and revert).
  const callData = encodeFunctionData({
    abi: YIELD_IMPL_ABI,
    functionName: fnName,
    args: [a.fromAddr, account.address, a.pool, a.assetAddress, a.amountRaw, a.nonceUint, a.deadline, a.witnessSig],
  });

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
