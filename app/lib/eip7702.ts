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
// or slow-respond for tens of seconds; without a bound, the 12-chain
// parallel status read can sit on a single bad endpoint until the Vercel
// function timeout (default 10s) consumes the whole request. 5s per
// chain lets the slow chain show up as `error: timeout` while the
// other 9 still return their state on time.
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
  arbitrum:  42161,
  base:      8453,
  robinhood: 4663,
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
  mantle:    "0xe5b90d564650bdce7c2bb4344f777f6582e05699",
  injective: "0xa9a7dce76def2ac36057fef0d8103df10581d61e",
  monad:     "0xc5d4dfa6d2e545409c1abf86f336dd43bb87621f",
  scroll:    "0x7635f32d893b64b5944cb8cbf2ac4cd3da41b2f1",
  arbitrum:  "0x8d854436ab0426f5bc6cc70865c90576ad523e73",
  base:      "0x2fb2b2d110b6c5664e701666b3741240242bf350",
  robinhood: "0x2fb2b2d110b6c5664e701666b3741240242bf350",
};

export function isOfficialQ402Impl(chain: ChainKey, impl: string | undefined): boolean {
  if (!impl) return false;
  return impl.toLowerCase() === Q402_IMPL_PER_CHAIN[chain];
}

// Retired Q402 impls per chain — earlier generations the relayer once delegated
// EOAs to. They are NOT the current settlement impl (some lack the owner-binding
// check), so they must NEVER be accepted for SETTLEMENT (use isOfficialQ402Impl
// for that — current only). But a delegation pointing at one is still a Q402
// delegation, so the clear-delegation endpoint SHOULD sponsor un-delegating it
// (clearing is always the EOA owner's own action, proven by sig recovery).
// Keyed per (chain, address): the same CREATE address can be a current impl on
// one chain and retired on another. All lowercased; append as older generations
// are found (this list is "known retired", not provably exhaustive).
const RETIRED_IMPLS: Record<ChainKey, readonly string[]> = {
  avax:      [],
  bnb:       [],
  eth:       [],
  xlayer:    [],
  stable:    [],
  // 0x2fb2b2… was deployed on mantle/injective/scroll/arbitrum (and is Stable's
  // CURRENT impl) via deterministic nonce-aligned CREATE — it really does carry
  // code on all of them, so list it everywhere it's retired. The static address
  // list is the durable guarantee; the fallback isQ402ImplOnChain() below is a
  // best-effort recogniser by on-chain bytecode codehash (Q402_IMPL_CODEHASHES)
  // for an un-enumerated impl whose bytecode we already know.
  mantle:    ["0xa9a7dce76def2ac36057fef0d8103df10581d61e", "0x2fb2b2d110b6c5664e701666b3741240242bf350"],
  injective: ["0x892e647fbbadc8ee8342710244931ea98529ea9c", "0x2fb2b2d110b6c5664e701666b3741240242bf350"],
  monad:     ["0x5a8fde1851491d9ed512a9eda1c63ca7627becb8", "0x39ba9520718ee069d7f72882ff4c28a5ea8a2acc"],
  scroll:    ["0x8d854436ab0426f5bc6cc70865c90576ad523e73", "0x2fb2b2d110b6c5664e701666b3741240242bf350"],
  arbitrum:  ["0xe5b90d564650bdce7c2bb4344f777f6582e05699", "0x2fb2b2d110b6c5664e701666b3741240242bf350"],
  // base: 0x2fb2b2… is the CURRENT impl here (deployed at nonce 0), not retired.
  base:      [],
  // robinhood: 0x2fb2b2… is the CURRENT impl here, not retired.
  robinhood: [],
};

/**
 * True if `impl` is a Q402 impl on `chain` that the clear-delegation endpoint
 * may sponsor un-delegating — the CURRENT impl OR a known RETIRED impl. This is
 * the gate for CLEARING only; settlement still requires isOfficialQ402Impl
 * (current impl only).
 */
export function isClearableQ402Impl(chain: ChainKey, impl: string | undefined): boolean {
  if (!impl) return false;
  const a = impl.toLowerCase();
  return a === Q402_IMPL_PER_CHAIN[chain] || RETIRED_IMPLS[chain].includes(a);
}

/**
 * Codehash allowlist of EVERY known Q402 impl bytecode: keccak256 of the
 * on-chain runtime code of each (chain, address) in Q402_IMPL_PER_CHAIN +
 * RETIRED_IMPLS, collected once PER-(chain,address). Keyed on bytecode, NOT
 * address — the SAME address carries DIFFERENT bytecode across chains and
 * generations (e.g. 0x2fb2b2… hashes to 6 distinct values across
 * stable/base/mantle/injective/scroll/arbitrum), so deduping by address would
 * silently reject legitimate retired deployments. 21 entries as of the last
 * collection. Empty/0x code is excluded (a 0x entry would make every plain or
 * self-destructed EOA match — re-opening the grief).
 *
 * Refresh: when you add a new impl ADDRESS to Q402_IMPL_PER_CHAIN/RETIRED_IMPLS,
 * fetch its on-chain code (cross-checked across ≥2 RPCs), keccak256 it, and add
 * the hash here in the SAME commit. See docs/IMPL_REFRESH_RUNBOOK.md.
 */
export const Q402_IMPL_CODEHASHES: ReadonlySet<string> = new Set<string>([
  "0x345a0bec725b97d5e049cce9954b286d3ac00c9c62de5b91d423bc73a78206c5", // avax current
  "0x1f66d6859ec346d8000d9df00209de0f94033072c4db5f2b7024e728129388c1", // bnb current
  "0x7a2c13a087d61a9d4b99420369b5b8a384d62d72918335d8a50ec35088007ec0", // eth current
  "0xa2703a7de08e40353c7683f66ad1fae508310af0309c6ef300b057db36ef81c4", // xlayer current
  "0x8cfe8706df57fc10cc16e52da1cffb861e9a02a42a233b3424f7f3bf0115e24d", // stable current
  "0x0c7a6dd4d1838354f7021dd7de55fc939ee07d422ff376984431a5d8d3a00448", // mantle current
  "0xb87ac1c8563df244de934d923e56f0b9fdcdf7fc293546509689088e12a6d398", // injective current
  "0x6fed32dcc6a28c49874cb01d57c58dc915cbae8a6f77d9b8a3c06ee1382f16cb", // monad current
  "0x6b2c3faf60f570aab50abbb4aa12a3c0c555671fea6ed9301ac45e340ecda1d9", // scroll current
  "0x44feb33dce89b4b7a18e0b3cddd6b52154e8db2846d640cfbef43ae2a4d63a33", // arbitrum current
  "0x5bfc8ae51406a93df0324beca30f1028978da0900778312de8725b9de60f0679", // base current
  "0x0306a515be22e02d116ae0beeab6b6a08b9e37f8a0cf0d90000a4df77ec5744d", // mantle retired (0xa9a7dc)
  "0x8fb2ac5535ab1cf247edfb29c5f12206eadfe7f4d4bb696265ff4827e3dc6e3c", // mantle retired (0x2fb2b2)
  "0x29f061d3db4f9b7bfb3d68286df9c1c1458612f71d605d239b0dffb6c96d8b6b", // injective retired (0x892e64)
  "0x9a3536aa12e5505087c91507416cb73fc27fc2a9d82ca9f6bea96e35a20b4433", // injective retired (0x2fb2b2)
  "0xa4d5fc33e2bf2247aa6b3426da09b040799310da1d814df9906f28546455f98d", // monad retired (0x5a8fde)
  "0x6ee01dc9552636b6bd4f4d5ad56960662c83aa51ea7d1a488d4e0687bebf0c37", // monad retired (0x39ba95)
  "0x4085e5450309a992a69bdf90dc93d28b0cdf6db1f28557af4de0d694b2ed6514", // scroll retired (0x8d8544)
  "0x3f1cafbe691713c9df9c6ca3908698b7941d0252181cec6872905e415e5bf828", // scroll retired (0x2fb2b2)
  "0x463e2cb224f4dcaf599bb52734dc148af4849c4802057a03af9a2fce25bd4e81", // arbitrum retired (0xe5b90d)
  "0x9acb7b7f2f29371e56d4f3de584c35c8c522b87e09a5a2e043b169143fd12692", // arbitrum retired (0x2fb2b2)
  "0xa9104ce3dd511f78a24d5c12bedd7021a8730716964fb070accbb4e3abfc18f6", // robinhood current (0x2fb2b2), keccak256(eth_getCode) verified 2026-07-02
  "0x8318019b8613545d217dfa5d30e1a8495cc37dc63407146d762db7f82b6cf56b", // bnb Lista yield v3 slippage (0x5F5aa6E2), verified 2026-07-10
  "0xe3da86a52b6392389839b36683a62a805fcc106f45365a907f4e15c2bbb5b6c8", // base Morpho yield v3 slippage (0x101b8D79), verified 2026-07-10
]);

/**
 * Dynamic completeness check for the clear endpoint. Recognises a Q402 impl by
 * its on-chain BYTECODE: fetches eth_getCode(impl) and checks keccak256(code)
 * against Q402_IMPL_CODEHASHES. Returns false on empty/0x code, on RPC error,
 * or on any unknown bytecode (an attacker's fake impl, or MetaMask's
 * EIP7702StatelessDeleGator), so non-Q402 delegations are never sponsored.
 *
 * This REPLACES the old NAME()-prefix check, which trusted an attacker-
 * controllable contract method: anyone could deploy a contract whose NAME()
 * returns "Q402 …", self-delegate to it, and get Q402 to sponsor clearing the
 * junk delegation. A codehash can't be forged without deploying byte-identical
 * Q402 impl bytecode (which IS a real Q402 impl, fine to clear). Enumerated
 * impls hit isClearableQ402Impl first (synchronous, RPC-free), so this fallback
 * only ever fires for an un-enumerated bytecode.
 */
export async function isQ402ImplOnChain(chain: ChainKey, impl: string): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(getPrimaryRpc(chain));
    const code = await withTimeout(
      provider.getCode(impl) as Promise<string>,
      PROVIDER_CALL_TIMEOUT_MS,
      `getCode(${chain})`,
    );
    // Empty/0x must short-circuit BEFORE hashing — keccak256("0x") in the set
    // would make every plain or self-destructed EOA match.
    if (!code || code === "0x") return false;
    return Q402_IMPL_CODEHASHES.has(ethers.keccak256(code));
  } catch {
    return false;
  }
}

export const CHAIN_KEYS: ReadonlyArray<ChainKey> = [
  "avax", "bnb", "eth", "xlayer", "stable", "mantle", "injective", "monad", "scroll", "arbitrum", "base", "robinhood",
];

/**
 * Chains where a clear-delegation (undelegate) bills the gas to the USER's
 * Gas Tank instead of Q402 sponsoring it. Ethereum L1 ONLY — its type-4 gas
 * is too expensive to sponsor unmetered, so every undelegate on eth is
 * user-funded regardless of wallet mode (A / B / C). Every other chain is
 * fully sponsored ($0 to the user). Single source of truth shared by BOTH
 * clear endpoints (/api/wallet/clear-delegation and the agentic one) so the
 * policy can never drift between them. Deliberately NOT isCCIPChain(): that
 * set (eth/avax/arbitrum) is the cross-chain bridge feature, a separate
 * concern — avax + arbitrum clears are sponsored.
 */
export const CLEAR_GAS_TANK_CHAINS: ReadonlySet<ChainKey> = new Set<ChainKey>(["eth"]);

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
 * Read delegation state across all 12 chains in parallel.
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
  stable:    "https://stablescan.xyz/tx/",
  mantle:    "https://explorer.mantle.xyz/tx/",
  injective: "https://blockscout.injective.network/tx/",
  monad:     "https://monadscan.com/tx/",
  scroll:    "https://scrollscan.com/tx/",
  arbitrum:  "https://arbiscan.io/tx/",
  base:      "https://basescan.org/tx/",
  robinhood: "https://robinhoodchain.blockscout.com/tx/",
};

export function explorerTxUrl(chain: ChainKey, hash: string): string {
  return (EXPLORER_TX_BASE[chain] ?? "") + hash;
}

const EXPLORER_ADDRESS_BASE: Record<ChainKey, string> = {
  bnb:       "https://bscscan.com/address/",
  eth:       "https://etherscan.io/address/",
  avax:      "https://snowtrace.io/address/",
  xlayer:    "https://www.oklink.com/xlayer/address/",
  stable:    "https://stablescan.xyz/address/",
  mantle:    "https://explorer.mantle.xyz/address/",
  injective: "https://blockscout.injective.network/address/",
  monad:     "https://monadscan.com/address/",
  scroll:    "https://scrollscan.com/address/",
  arbitrum:  "https://arbiscan.io/address/",
  base:      "https://basescan.org/address/",
  robinhood: "https://robinhoodchain.blockscout.com/address/",
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
  arbitrum:  "Arbiscan",
  base:      "Basescan",
  robinhood: "Blockscout",
};

export function explorerLabel(chain: ChainKey): string {
  return EXPLORER_LABEL[chain] ?? "Explorer";
}
