/**
 * app/lib/ccip.ts — Q402 × Chainlink CCIP integration helpers.
 *
 * Scope (Phase 1, see contracts.manifest.json `.ccip` block):
 *   3-chain triangle: eth / avax / arbitrum. USDC routing only. No
 *   destination-side Q402 contract — token arrives directly at the
 *   destination Agentic Wallet (EOA). No EIP-712 BridgeAuthorization —
 *   Mode C only: Q402 server signs ccipSend as the Agentic Wallet.
 *
 * Authoritative source for chain config is contracts.manifest.json. This
 * file mirrors the manifest for the typed paths the API routes need, and
 * the ccip-config.test.ts drift guard pins them in sync.
 */

import { JsonRpcProvider, Wallet, Contract, type ContractRunner, type AddressLike, ZeroAddress, AbiCoder, parseUnits } from "ethers";
import manifest from "../../contracts.manifest.json";
import { CHAIN_CONFIG, getPrimaryRpc, type ChainKey } from "./relayer";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CCIPChainKey = "eth" | "avax" | "arbitrum";
export type FeeTokenKind = "LINK" | "native";
export const FEE_TOKEN_LINK = 0;
export const FEE_TOKEN_NATIVE = 1;

export interface CCIPChainConfig {
  chainSelector: bigint;
  router: string;
  linkToken: string;
  sender: string;                       // Q402CCIPSender deployed address
  supportedDestinations: CCIPChainKey[];
  explorer: string;
}

// ─── Config (mirrors manifest.ccip.chains) ──────────────────────────────────

const RAW = manifest.ccip;

function loadChain(k: CCIPChainKey): CCIPChainConfig {
  const c = RAW.chains[k];
  return {
    chainSelector:        BigInt(c.chainSelector),
    router:               c.router,
    linkToken:            c.linkToken,
    sender:               c.sender,
    supportedDestinations: c.supportedDestinations as CCIPChainKey[],
    explorer:             c.explorer,
  };
}

export const CCIP_CONFIG: Record<CCIPChainKey, CCIPChainConfig> = {
  eth:      loadChain("eth"),
  avax:     loadChain("avax"),
  arbitrum: loadChain("arbitrum"),
};

export const CCIP_CHAINS: CCIPChainKey[] = ["eth", "avax", "arbitrum"];

export function isCCIPChain(s: string): s is CCIPChainKey {
  return s === "eth" || s === "avax" || s === "arbitrum";
}

/** All 6 directed (src → dst) lanes in the 3-chain triangle. */
export function ccipLaneMatrix(): { src: CCIPChainKey; dst: CCIPChainKey }[] {
  const out: { src: CCIPChainKey; dst: CCIPChainKey }[] = [];
  for (const src of CCIP_CHAINS) {
    for (const dst of CCIP_CONFIG[src].supportedDestinations) {
      out.push({ src, dst });
    }
  }
  return out;
}

// ─── Router ABI (subset needed for Q402 paths) ──────────────────────────────

export const ROUTER_ABI = [
  "function getFee(uint64 destinationChainSelector, (bytes receiver, bytes data, (address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) external view returns (uint256)",
  "function ccipSend(uint64 destinationChainSelector, (bytes receiver, bytes data, (address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) external payable returns (bytes32)",
  "function isChainSupported(uint64 chainSelector) external view returns (bool)",
] as const;

/** Q402CCIPSender ABI (subset). */
export const SENDER_ABI = [
  "function bridge(uint64 destChainSelector, uint256 amount, address destReceiver, uint8 feeToken, uint256 maxFee) external returns (bytes32)",
  "function quoteFee(uint64 destChainSelector, uint256 amount, address destReceiver, uint8 feeToken) external view returns (uint256)",
  "function poolBalances() external view returns (uint256 linkBalance, uint256 nativeBalance)",
  "function ROUTER() external view returns (address)",
  "function LINK() external view returns (address)",
  "function USDC() external view returns (address)",
  "function FACILITATOR() external view returns (address)",
  "event BridgeInitiated(bytes32 indexed messageId, address indexed owner, uint64 indexed destChainSelector, address destReceiver, uint256 amount, uint8 feeToken, uint256 feePaid)",
] as const;

// ─── Message encoding (matches Q402CCIPSender on-chain layout) ──────────────

/**
 * Build the EVM2AnyMessage tuple used by Router.getFee / ccipSend.
 * Mirrors Q402CCIPSender's internal encoding so off-chain quotes match
 * on-chain fees exactly — quote drift is a silent revert trap.
 */
export function buildEvm2AnyMessage(opts: {
  destReceiver: string;     // user's Agentic Wallet on destination chain (EOA)
  usdc:         string;     // USDC address on source chain
  amount:       bigint;     // raw 6-decimal USDC
  feeTokenKind: FeeTokenKind;
  linkAddr:     string;     // LINK address on source chain
}): [string, string, [string, bigint][], string, string] {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const receiverBytes = abiCoder.encode(["address"], [opts.destReceiver]);
  const data = "0x";
  const tokenAmounts: [string, bigint][] = [[opts.usdc, opts.amount]];

  // ExtraArgs: GenericExtraArgsV2 — selector 0x181dcf10 + abi.encode(gasLimit, allowOutOfOrderExecution)
  const extraArgsInner = abiCoder.encode(["uint256", "bool"], [0n, true]);
  const extraArgs = "0x181dcf10" + extraArgsInner.slice(2);

  const feeTokenAddr = opts.feeTokenKind === "LINK" ? opts.linkAddr : ZeroAddress;
  return [receiverBytes, data, tokenAmounts, feeTokenAddr, extraArgs];
}

// ─── Provider + signer helpers ──────────────────────────────────────────────

const providerCache = new Map<CCIPChainKey, JsonRpcProvider>();

export function getCCIPProvider(chain: CCIPChainKey): JsonRpcProvider {
  let p = providerCache.get(chain);
  if (!p) {
    // Reuse the main relayer's RPC fan-out — these chains are already in
    // CHAIN_RPC_FALLBACKS via relayer.ts.
    p = new JsonRpcProvider(getPrimaryRpc(chain as ChainKey));
    providerCache.set(chain, p);
  }
  return p;
}

/** Read-only Router contract handle. */
export function getRouter(chain: CCIPChainKey, runner?: ContractRunner): Contract {
  return new Contract(CCIP_CONFIG[chain].router, ROUTER_ABI, runner ?? getCCIPProvider(chain));
}

/** Read-only Q402CCIPSender handle. */
export function getSender(chain: CCIPChainKey, runner?: ContractRunner): Contract {
  return new Contract(CCIP_CONFIG[chain].sender, SENDER_ABI, runner ?? getCCIPProvider(chain));
}

// ─── Fee quote helpers ──────────────────────────────────────────────────────

export interface CCIPQuote {
  src:           CCIPChainKey;
  dst:           CCIPChainKey;
  amount:        string;             // raw 6-decimal USDC
  feeToken:      FeeTokenKind;
  feeRaw:        string;             // wei for native, 18-dec for LINK
  feeUsd:        number;             // estimated USD (approximate, oracle-priced)
  destReceiver:  string;
  chainSelector: string;
}

/**
 * On-chain fee quote via Router.getFee. Provider-only, no signer needed.
 * Returns BOTH LINK and native quotes so the dashboard can show the user
 * the trade-off without an extra round-trip.
 */
export async function quoteBridgeFee(
  src: CCIPChainKey,
  dst: CCIPChainKey,
  amount: bigint,
  destReceiver: string,
): Promise<{ link: bigint; native: bigint }> {
  if (!CCIP_CONFIG[src].supportedDestinations.includes(dst)) {
    throw new Error(`CCIP: ${src} → ${dst} is not a supported lane`);
  }
  const router = getRouter(src);
  const usdc = CHAIN_CONFIG[src as ChainKey].usdc.address;
  const linkAddr = CCIP_CONFIG[src].linkToken;

  const linkMsg = buildEvm2AnyMessage({
    destReceiver,
    usdc,
    amount,
    feeTokenKind: "LINK",
    linkAddr,
  });
  const nativeMsg = buildEvm2AnyMessage({
    destReceiver,
    usdc,
    amount,
    feeTokenKind: "native",
    linkAddr,
  });

  const dstSelector = CCIP_CONFIG[dst].chainSelector;
  const [feeLink, feeNative] = await Promise.all([
    router.getFee(dstSelector, linkMsg) as Promise<bigint>,
    router.getFee(dstSelector, nativeMsg) as Promise<bigint>,
  ]);
  return { link: feeLink, native: feeNative };
}

// ─── Sender contract invocation (server signs as Agentic Wallet) ────────────

export interface BridgeSendParams {
  src:          CCIPChainKey;
  dst:          CCIPChainKey;
  amount:       bigint;          // raw 6-decimal USDC
  destReceiver: string;          // user's Agentic Wallet on destination chain
  feeToken:     FeeTokenKind;
  maxFee:       bigint;          // raw (wei or 18-dec LINK) — revert if quote > this
  agenticWalletKey: string;      // hex private key (0x + 64 hex) of source-chain Agentic Wallet
}

export interface BridgeSendResult {
  txHash:      string;
  messageId:   string;
  blockNumber: number;
  feeRaw:      bigint;
  feeToken:    FeeTokenKind;
}

/**
 * Submit ccipSend through Q402CCIPSender. Caller (Agentic Wallet) must have
 * already approved Q402CCIPSender for `amount` USDC on the source chain.
 * Approval is server-managed (see app/api/ccip/send route).
 *
 * IMPORTANT: server-side function. Never call from the client — needs
 * the Agentic Wallet private key.
 */
export async function executeBridge(p: BridgeSendParams): Promise<BridgeSendResult> {
  const provider = getCCIPProvider(p.src);
  const wallet = new Wallet(p.agenticWalletKey, provider);
  const sender = new Contract(CCIP_CONFIG[p.src].sender, SENDER_ABI, wallet);

  const feeTokenEnum = p.feeToken === "LINK" ? FEE_TOKEN_LINK : FEE_TOKEN_NATIVE;
  const dstSelector = CCIP_CONFIG[p.dst].chainSelector;

  const tx = await sender.bridge(
    dstSelector,
    p.amount,
    p.destReceiver,
    feeTokenEnum,
    p.maxFee,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("CCIP bridge: tx mined but receipt null");

  // Parse BridgeInitiated event for messageId + fee
  const iface = sender.interface;
  let messageId = "";
  let feeRaw = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "BridgeInitiated") {
        messageId = parsed.args.messageId as string;
        feeRaw = parsed.args.feePaid as bigint;
        break;
      }
    } catch { /* not our event */ }
  }

  return {
    txHash:      tx.hash,
    messageId,
    blockNumber: receipt.blockNumber,
    feeRaw,
    feeToken:    p.feeToken,
  };
}

// ─── USD pricing for fee display (rough — Coingecko / oracle TBD) ──────────

/**
 * Convert raw fee to approximate USD. Used for dashboard display only —
 * the on-chain fee is the source of truth, USD is informational.
 */
export function feeToUsd(
  feeRaw: bigint,
  feeToken: FeeTokenKind,
  prices: { LINK_USD?: number; native_USD?: number } = {},
): number {
  const linkUsd = prices.LINK_USD ?? 12;       // rough $12 LINK default
  const nativeUsd = prices.native_USD ?? 4000; // assumes ETH; AVAX needs override
  const decimals = 18n;
  const divisor = 10n ** decimals;
  const whole = Number(feeRaw / divisor);
  const frac = Number(feeRaw % divisor) / Number(divisor);
  const native = whole + frac;
  return feeToken === "LINK" ? native * linkUsd : native * nativeUsd;
}
