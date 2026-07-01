import { ethers } from "ethers";
import { getEscrowChain, type EscrowChainCfg } from "./escrow-contracts";

/**
 * Server-side escrow settlement. The relayer sponsors gas; the ON-CHAIN
 * signatures are the real authority (only the buyer can sign a release, the
 * arbiter a resolve, etc.), so this module never decides a payout — it only
 * broadcasts a transaction the signatures/timeouts already authorize.
 *
 * lock is an EIP-7702 Type-4 broadcast (the buyer's authorization delegates the
 * EOA to the lock impl); release/refund/dispute/resolve are plain vault calls.
 * Proven end-to-end on Sepolia (see escrow-contracts.ts).
 */

const LOCK_ABI = [
  "function escrowLock((address buyer,address seller,address vault,address token,uint256 amount,bytes32 salt,uint256 releaseDeadline,address arbiter,address facilitator,uint256 nonce,uint256 deadline) p, bytes witnessSignature) external",
];
const VAULT_ABI = [
  "function release(bytes32 escrowId, uint256 nonce, uint256 deadline, bytes buyerSig) external",
  "function refund(bytes32 escrowId) external",
  "function dispute(bytes32 escrowId, uint256 nonce, uint256 deadline, bytes partySig) external",
  "function resolve(bytes32 escrowId, bool toSeller, uint256 nonce, uint256 deadline, bytes arbiterSig) external",
  "function getEscrow(bytes32 escrowId) view returns ((address buyer,address seller,address token,uint256 amount,uint256 releaseDeadline,address arbiter,uint8 state))",
];

export type SettleResult =
  | { ok: true; txHash: string }
  | { ok: false; error: string };

/**
 * The escrow relayer wallet. Prefers a dedicated ESCROW_RELAYER_KEY, but falls
 * back to the shared production relayer key (the same 0xfc77 hot wallet that
 * facilitates payments) so go-live needs no new secret. The relayer only sponsors
 * gas + is the named facilitator; the on-chain EIP-712 signatures are the sole
 * fund authority, so a shared key cannot move or redirect anyone's funds.
 */
function relayerFor(cfg: EscrowChainCfg): ethers.Wallet | null {
  const pk = process.env.ESCROW_RELAYER_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (!pk) return null;
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  try {
    return new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  } catch {
    return null;
  }
}

/** Facilitator = the escrow relayer's address; the buyer's EscrowLock must name it. */
export function escrowFacilitator(chain: string): string | null {
  const cfg = getEscrowChain(chain);
  if (!cfg) return null;
  const w = relayerFor(cfg);
  return w ? w.address : null;
}

export interface LockParams {
  buyer: string; seller: string; vault: string; token: string; amount: string;
  salt: string; releaseDeadline: string; arbiter: string; facilitator: string;
  nonce: string; deadline: string;
}
/** ethers-shaped 7702 authorization the buyer signed (address = lock impl). */
export interface Authorization {
  chainId: number; address: string; nonce: number; yParity: number; r: string; s: string;
}

async function broadcast(fn: () => Promise<ethers.TransactionResponse>): Promise<SettleResult> {
  try {
    const tx = await fn();
    const rc = await tx.wait();
    if (rc?.status !== 1) return { ok: false, error: `tx reverted (${tx.hash})` };
    return { ok: true, txHash: tx.hash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : "broadcast failed" };
  }
}

export async function settleEscrowLock(chain: string, p: LockParams, witnessSig: string, auth: Authorization): Promise<SettleResult> {
  const cfg = getEscrowChain(chain);
  if (!cfg) return { ok: false, error: "escrow not supported on chain" };
  const relayer = relayerFor(cfg);
  if (!relayer) return { ok: false, error: "escrow relayer not configured" };
  // Tamper-guard: the signed vault/lockImpl/facilitator MUST be the canonical ones.
  if (p.vault.toLowerCase() !== cfg.vault.toLowerCase()) return { ok: false, error: "vault mismatch" };
  if (p.facilitator.toLowerCase() !== relayer.address.toLowerCase()) return { ok: false, error: "facilitator mismatch" };
  // The 7702 authorization must delegate the buyer's EOA to the CANONICAL lock
  // impl on THIS chain, never a client-chosen contract or a foreign-chain auth
  // (the on-chain checks are the backstop, but reject early to match the
  // vault/facilitator tamper-guards).
  if (auth.address.toLowerCase() !== cfg.lockImpl.toLowerCase()) return { ok: false, error: "lock impl mismatch" };
  if (auth.chainId !== cfg.chainId) return { ok: false, error: "authorization chainId mismatch" };
  const lockImpl = new ethers.Contract(cfg.lockImpl, LOCK_ABI, relayer);
  const data = lockImpl.interface.encodeFunctionData("escrowLock", [p, witnessSig]);
  // Rebuild the ethers Authorization from the client-serialized tuple: the
  // signed 7702 authorization needs its signature nested, not the flat r/s/v.
  const authList = [{
    address: auth.address, nonce: auth.nonce, chainId: auth.chainId,
    signature: ethers.Signature.from({ r: auth.r, s: auth.s, yParity: auth.yParity ? 1 : 0 }),
  }];
  // BSC (and other legacy-fee chains) return no EIP-1559 fee data, so ethers
  // silently downgrades an authorizationList tx to Type-0 — dropping the 7702
  // delegation, which makes the lock a no-op that "succeeds" (status 1) yet
  // creates NO escrow. Force Type-4 + explicit EIP-1559 fees so the delegation
  // always applies. (Proven on BNB mainnet: without this the lock silently fails.)
  const fee = await relayer.provider!.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("1", "gwei");
  return broadcast(() => relayer.sendTransaction({
    to: p.buyer, data, authorizationList: authList, type: 4,
    maxFeePerGas: maxFee, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? maxFee,
  }));
}

export async function settleEscrowRelease(chain: string, escrowId: string, nonce: string, deadline: string, buyerSig: string): Promise<SettleResult> {
  const cfg = getEscrowChain(chain);
  if (!cfg) return { ok: false, error: "escrow not supported on chain" };
  const relayer = relayerFor(cfg);
  if (!relayer) return { ok: false, error: "escrow relayer not configured" };
  const vault = new ethers.Contract(cfg.vault, VAULT_ABI, relayer);
  return broadcast(() => vault.release(escrowId, nonce, deadline, buyerSig));
}

export async function settleEscrowRefund(chain: string, escrowId: string): Promise<SettleResult> {
  const cfg = getEscrowChain(chain);
  if (!cfg) return { ok: false, error: "escrow not supported on chain" };
  const relayer = relayerFor(cfg);
  if (!relayer) return { ok: false, error: "escrow relayer not configured" };
  const vault = new ethers.Contract(cfg.vault, VAULT_ABI, relayer);
  return broadcast(() => vault.refund(escrowId));
}

export async function settleEscrowDispute(chain: string, escrowId: string, nonce: string, deadline: string, partySig: string): Promise<SettleResult> {
  const cfg = getEscrowChain(chain);
  if (!cfg) return { ok: false, error: "escrow not supported on chain" };
  const relayer = relayerFor(cfg);
  if (!relayer) return { ok: false, error: "escrow relayer not configured" };
  const vault = new ethers.Contract(cfg.vault, VAULT_ABI, relayer);
  return broadcast(() => vault.dispute(escrowId, nonce, deadline, partySig));
}

export async function settleEscrowResolve(chain: string, escrowId: string, toSeller: boolean, nonce: string, deadline: string, arbiterSig: string): Promise<SettleResult> {
  const cfg = getEscrowChain(chain);
  if (!cfg) return { ok: false, error: "escrow not supported on chain" };
  const relayer = relayerFor(cfg);
  if (!relayer) return { ok: false, error: "escrow relayer not configured" };
  const vault = new ethers.Contract(cfg.vault, VAULT_ABI, relayer);
  return broadcast(() => vault.resolve(escrowId, toSeller, nonce, deadline, arbiterSig));
}

/**
 * Read the on-chain escrow state (0 None, 1 Open, 2 Released, 3 Refunded,
 * 4 Disputed) — the authoritative truth. Used to reconcile a record whose KV
 * write was lost after the lock tx landed, so a stuck `pending` record can be
 * healed from the chain instead of stranding the buyer's locked funds.
 */
export async function readEscrowOnchainState(chain: string, escrowId: string): Promise<number | null> {
  const cfg = getEscrowChain(chain);
  if (!cfg) return null;
  try {
    const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
    const vault = new ethers.Contract(cfg.vault, VAULT_ABI, provider);
    const e = await vault.getEscrow(escrowId);
    return Number(e.state);
  } catch {
    return null;
  }
}
