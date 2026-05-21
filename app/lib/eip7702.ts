/**
 * EIP-7702 delegation helpers.
 *
 * Two surfaces:
 *
 *   1. `getDelegationState(chain, address)` — read-only `eth_getCode`
 *      parsing. Returns whether the EOA is currently delegated and (if so)
 *      which impl contract it's pointed at. Used by the dashboard
 *      WalletDelegationCard to render per-chain status.
 *
 *   2. `broadcastClear(chain, authorization)` — server-side type-0x04 TX
 *      broadcast that clears a delegation. The caller has already
 *      collected the user's signed authorization (address = 0x0) via the
 *      browser wallet (MetaMask / OKX EIP-7702 support). Q402's relayer
 *      EOA pays gas (sponsored).
 *
 * The browser-side counterpart (asking the wallet to sign the
 * authorization) lives in WalletDelegationCard.tsx via ethers v6's
 * `signer.authorize()` helper — same pattern as q402-sdk.js.
 */

import { ethers } from "ethers";
import { getPrimaryRpc } from "./relayer";
import type { ChainKey } from "./relayer";
import { loadRelayerKey } from "./relayer-key";

// ── Chain id ↔ key mapping ─────────────────────────────────────────────────
// Mirrors contracts.manifest.json. Kept local so this module has zero
// transitive deps on the broader chain config (the eth_getCode helper is
// dependency-light by design).

export const CHAIN_IDS: Record<ChainKey, number> = {
  avax:      43114,
  bnb:       56,
  eth:       1,
  xlayer:    196,
  stable:    988,
  mantle:    5000,
  injective: 1776,
  monad:     143,
  scroll:    534352,
};

export const CHAIN_KEYS: ReadonlyArray<ChainKey> = [
  "avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll",
];

// ── EIP-7702 code prefix ───────────────────────────────────────────────────
// Per EIP-7702, a delegated EOA's `eth_getCode` returns `0xef0100` followed
// by the 20-byte delegate address. Anything else means "not delegated"
// (or, for `0xef01` other variants, a future EIP-7702 extension we don't
// recognise yet — treat as undelegated for safety).

const EIP7702_PREFIX = "0xef0100";
const PREFIX_LEN     = EIP7702_PREFIX.length; // 8 chars incl. 0x

export interface DelegationState {
  chain:     ChainKey;
  delegated: boolean;
  /** When delegated, the 20-byte impl address that the EOA is pointed at. */
  impl?:     string;
  /** Raw eth_getCode response — useful for debugging. */
  rawCode?:  string;
  /** Network error if the call failed; the chain is treated as "unknown". */
  error?:    string;
}

/**
 * Decode an `eth_getCode` response into a delegation state.
 *
 * Three cases:
 *   - `0x`                    → no code, plain EOA, not delegated.
 *   - `0xef0100<20-byte impl>` → EIP-7702 delegated to `impl`.
 *   - anything else            → unrecognised (smart account, contract,
 *                                future EIP-7702 variant) — surfaced as
 *                                non-delegated so the UI doesn't claim
 *                                false positives.
 */
export function parseCodeAsDelegation(code: string): { delegated: boolean; impl?: string } {
  if (!code || code === "0x") return { delegated: false };
  if (code.toLowerCase().startsWith(EIP7702_PREFIX)) {
    const implHex = "0x" + code.slice(PREFIX_LEN);
    if (implHex.length === 42 /* 0x + 40 hex chars */) {
      return { delegated: true, impl: ethers.getAddress(implHex) };
    }
  }
  return { delegated: false };
}

/**
 * Read a single chain's delegation state for an EOA.
 *
 * Never throws — RPC errors surface via the `error` field so the UI can
 * render "—" instead of failing the whole card on one bad RPC.
 */
export async function getDelegationState(
  chain:   ChainKey,
  address: string,
): Promise<DelegationState> {
  try {
    const provider = new ethers.JsonRpcProvider(getPrimaryRpc(chain));
    const code     = await provider.getCode(address);
    const parsed   = parseCodeAsDelegation(code);
    return { chain, delegated: parsed.delegated, impl: parsed.impl, rawCode: code };
  } catch (e) {
    return {
      chain,
      delegated: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Read delegation state across all 9 chains in parallel.
 *
 * Returns one entry per chain regardless of error — UI consumes the array
 * directly to render status rows.
 */
export async function getAllDelegationStates(
  address: string,
): Promise<DelegationState[]> {
  return Promise.all(CHAIN_KEYS.map(c => getDelegationState(c, address)));
}

// ── Sponsored broadcast — clears a delegation on behalf of the user ────────

export interface SignedAuthorization {
  chainId: number;
  /** The address the EOA is being delegated to. For "clear", this is the zero
   *  address `0x0000…0000`. The endpoint rejects any other value. */
  address: string;
  nonce:   number;
  yParity: 0 | 1;
  r:       string;
  s:       string;
}

export interface ClearBroadcastResult {
  txHash:      string;
  blockNumber: number;
  gasUsed:     string;
  /** `0x` if the clear succeeded, anything else means the on-chain state
   *  didn't actually update — sponsor TX confirmed but the authorization
   *  was already nonce-stale, etc. UI uses this to confirm success. */
  finalCode:   string;
  explorerUrl: string;
}

/**
 * Broadcast a sponsored type-0x04 transaction that applies the given
 * authorization. The user-signed `authorization.address === 0x0` clears
 * the delegation; we don't accept any other target here (this is a
 * delegation-clearing endpoint, not a general-purpose 7702 relayer).
 *
 * The relayer EOA (sponsor) pays gas. No funds move from anywhere else.
 */
export async function broadcastClear(
  chain:         ChainKey,
  target:        string,
  authorization: SignedAuthorization,
): Promise<ClearBroadcastResult> {
  // Sanity gate: callers should validate this BEFORE calling us. Extra
  // assertion here so a future caller can't accidentally turn this into
  // a general-purpose 7702 broadcaster.
  if (authorization.address.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "broadcastClear: authorization.address must be the zero address (delegation-clearing only)",
    );
  }

  const provider   = new ethers.JsonRpcProvider(getPrimaryRpc(chain));
  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    throw new Error(`broadcastClear: relayer key unavailable (${relayerKey.reason}: ${relayerKey.detail})`);
  }
  const sponsor = new ethers.Wallet(relayerKey.privateKey, provider);

  // EIP-1559 fee data with chain-aware fallback (BSC needs at least
  // 0.05 gwei tip; the other chains usually return sane values from the
  // provider). Mirrors the pattern in scripts/undelegate-7702.mjs.
  const feeData     = await provider.getFeeData();
  const priorityFee =
    feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas > 0n
      ? feeData.maxPriorityFeePerGas
      : ethers.parseUnits("1", "gwei");
  const maxFee =
    feeData.maxFeePerGas && feeData.maxFeePerGas > 0n
      ? feeData.maxFeePerGas
      : ethers.parseUnits("5", "gwei");

  const tx = await sponsor.sendTransaction({
    type: 4,
    to:   sponsor.address, // self-send; the authorizationList is the load-bearing payload
    data: "0x",
    authorizationList: [
      {
        chainId: authorization.chainId,
        address: authorization.address,
        nonce:   authorization.nonce,
        // ethers v6 AuthorizationLike wraps the signature triple in a
        // `signature` field; passing yParity/r/s flat fails TS strict.
        signature: {
          yParity: authorization.yParity,
          r:       authorization.r,
          s:       authorization.s,
        },
      },
    ],
    maxPriorityFeePerGas: priorityFee,
    maxFeePerGas:         maxFee,
  });
  const receipt = await tx.wait();
  if (!receipt) throw new Error("broadcastClear: tx mined but receipt was null");

  const finalCode = await provider.getCode(target);

  return {
    txHash:      tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed:     receipt.gasUsed.toString(),
    finalCode,
    explorerUrl: explorerTxUrl(chain, tx.hash),
  };
}

// ── Explorer URLs ──────────────────────────────────────────────────────────
// Kept local — the broader CHAIN_CONFIG in mcp-server has the same data
// but this lib is server-side / Next-route-only, so the small duplication
// is preferable to importing the MCP package here.

const EXPLORER_TX_BASE: Record<ChainKey, string> = {
  bnb:       "https://bscscan.com/tx/",
  eth:       "https://etherscan.io/tx/",
  avax:      "https://snowtrace.io/tx/",
  xlayer:    "https://www.oklink.com/xlayer/tx/",
  stable:    "https://stablescan.org/tx/",
  mantle:    "https://explorer.mantle.xyz/tx/",
  injective: "https://blockscout.injective.network/tx/",
  monad:     "https://monadscan.com/tx/",
  scroll:    "https://scrollscan.com/tx/",
};

export function explorerTxUrl(chain: ChainKey, hash: string): string {
  return (EXPLORER_TX_BASE[chain] ?? "") + hash;
}
