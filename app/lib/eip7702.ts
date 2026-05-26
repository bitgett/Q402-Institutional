/**
 * EIP-7702 delegation helpers.
 *
 *   1. `getDelegationState(chain, address)` /
 *      `getAllDelegationStates(address)` — read-only `eth_getCode`
 *      parsing. Returns whether the EOA is currently delegated and
 *      (if so) which impl contract it's pointed at. Consumed by the
 *      delegation-status endpoint and, via that, by the MCP
 *      `q402_wallet_status` tool.
 *
 *   2. `recoverAuthorizationAddress(auth)` — off-chain ECDSA recovery
 *      against the canonical EIP-7702 signing digest (MAGIC || rlp([
 *      chainId, address, nonce])). The clear-delegation endpoint uses
 *      it to verify the submitted authorization was signed by the
 *      claimed target EOA before forwarding to sponsored broadcast.
 *
 *   3. `broadcastClear(chain, target, authorization)` — server-side
 *      type-0x04 TX broadcast that applies a user-signed "clear"
 *      authorization (address = 0x0). The caller has already collected
 *      the signature (MCP signs locally with Q402_PRIVATE_KEY; the CLI
 *      script signs via ethers Wallet). Q402's relayer EOA pays gas.
 *
 *   4. `isOfficialQ402Impl(chain, impl)` + `Q402_IMPL_PER_CHAIN` —
 *      pre-flight gate so the sponsored broadcast only fires when the
 *      EOA is actually delegated to Q402's impl on that chain. Stops
 *      this endpoint from becoming a free cleanup utility for
 *      unrelated 7702 delegations.
 */

import { ethers } from "ethers";
import { getPrimaryRpc } from "./relayer";
import type { ChainKey } from "./relayer";
import { loadRelayerKey } from "./relayer-key";

// Per-call timeout for eth_getCode probes. Public RPCs occasionally hang
// or slow-respond for tens of seconds; without a bound, the 9-chain
// parallel status read can sit on a single bad endpoint until the Vercel
// function timeout (default 10s) consumes the whole request. 5s per
// chain lets the slow chain show up as `error: timeout` while the
// other 8 still return their state on time.
const PROVIDER_CALL_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

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

// Official Q402 impl contract per chain — mirrors contracts.manifest.json.
// Used by the clear-delegation endpoint to refuse sponsoring TXs for
// EIP-7702 delegations that point at someone else's contract (i.e. the
// EOA is delegated to a non-Q402 service). Otherwise our sponsor relayer
// becomes a free 7702-cleanup utility for any caller.
//
// All addresses lowercased for cheap ===-comparison.
export const Q402_IMPL_PER_CHAIN: Record<ChainKey, string> = {
  avax:      "0x96a8c74d95a35d0c14ec60364c78ba6de99e9a4c",
  bnb:       "0x6cf4ad62c208b6494a55a1494d497713ba013dfa",
  eth:       "0x8e67a64989cfcb0c40556b13ea302709ccfd6aad",
  xlayer:    "0x8d854436ab0426f5bc6cc70865c90576ad523e73",
  stable:    "0x2fb2b2d110b6c5664e701666b3741240242bf350",
  mantle:    "0x2fb2b2d110b6c5664e701666b3741240242bf350",
  injective: "0x2fb2b2d110b6c5664e701666b3741240242bf350",
  monad:     "0x39ba9520718ee069d7f72882ff4c28a5ea8a2acc",
  scroll:    "0x2fb2b2d110b6c5664e701666b3741240242bf350",
};

export function isOfficialQ402Impl(chain: ChainKey, impl: string | undefined): boolean {
  if (!impl) return false;
  return impl.toLowerCase() === Q402_IMPL_PER_CHAIN[chain];
}

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
    const code     = await withTimeout(
      provider.getCode(address),
      PROVIDER_CALL_TIMEOUT_MS,
      `eth_getCode(${chain})`,
    );
    const parsed = parseCodeAsDelegation(code);
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

// ── EIP-7702 signature recovery ────────────────────────────────────────────
// Spec: signed message = keccak256(MAGIC || rlp([chainId, address, nonce]))
// with MAGIC = 0x05. We re-compute that hash, recover the signer from the
// (r, s, yParity) triple, and the caller compares the recovered address
// against the claimed target EOA. This is the off-chain version of the
// validation the EVM does during type-0x04 TX processing — except the EVM
// SKIPS bad auth entries silently (sponsor still pays gas) instead of
// rejecting the TX. So we have to verify here, before broadcast.

const EIP7702_MAGIC_BYTE = "0x05";

/**
 * Recover the address that signed an EIP-7702 authorization. Returns the
 * checksummed address; throws if signature recovery fails outright (bad
 * point on curve, etc.). A successfully-recovered address that doesn't
 * match the expected EOA is the caller's responsibility to reject.
 */
export function recoverAuthorizationAddress(auth: SignedAuthorization): string {
  // RLP encoding requires variable-length byte arrays; toBeArray produces
  // the minimal big-endian byte sequence for integers (no leading zeros).
  const rlpInner = ethers.encodeRlp([
    ethers.toBeArray(BigInt(auth.chainId)),
    auth.address,
    ethers.toBeArray(BigInt(auth.nonce)),
  ]);
  // Concatenate MAGIC (0x05) + RLP. encodeRlp already returns 0x-prefixed,
  // so slice(2) drops the prefix before joining.
  const prefixed = ethers.concat([EIP7702_MAGIC_BYTE, rlpInner]);
  const digest   = ethers.keccak256(prefixed);

  const signature = ethers.Signature.from({
    r:       auth.r,
    s:       auth.s,
    yParity: auth.yParity,
  });

  return ethers.recoverAddress(digest, signature);
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

const EXPLORER_ADDRESS_BASE: Record<ChainKey, string> = {
  bnb:       "https://bscscan.com/address/",
  eth:       "https://etherscan.io/address/",
  avax:      "https://snowtrace.io/address/",
  xlayer:    "https://www.oklink.com/xlayer/address/",
  stable:    "https://stablescan.org/address/",
  mantle:    "https://explorer.mantle.xyz/address/",
  injective: "https://blockscout.injective.network/address/",
  monad:     "https://monadscan.com/address/",
  scroll:    "https://scrollscan.com/address/",
};

export function explorerAddressUrl(chain: ChainKey, addr: string): string {
  return (EXPLORER_ADDRESS_BASE[chain] ?? "") + addr;
}

const EXPLORER_LABEL: Record<ChainKey, string> = {
  bnb:       "BscScan",
  eth:       "Etherscan",
  avax:      "Snowtrace",
  xlayer:    "OKLink",
  stable:    "StableScan",
  mantle:    "Mantle Explorer",
  injective: "Blockscout",
  monad:     "MonadScan",
  scroll:    "ScrollScan",
};

export function explorerLabel(chain: ChainKey): string {
  return EXPLORER_LABEL[chain] ?? "Explorer";
}
