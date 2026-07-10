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

import { JsonRpcProvider, Wallet, Contract, type ContractRunner, ZeroAddress, AbiCoder } from "ethers";
import manifest from "../../contracts.manifest.json";
import { getPrimaryRpc, getTokenConfig, type ChainKey } from "./relayer";
import { loadRelayerKey } from "./relayer-key";

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
  "function bridgeFor(address owner, uint64 destChainSelector, uint256 amount, address destReceiver, uint8 feeToken, uint256 maxFee) external returns (bytes32)",
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
  const usdc = getTokenConfig(src as ChainKey, "USDC").address;
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

// Minimal ERC-20 ABI for allowance + approve (used by lazy-approval path).
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/**
 * Submit ccipSend through Q402CCIPSender. Auto-handles the one-time USDC
 * approval — if the Agentic Wallet's allowance to Sender is < amount, this
 * submits an approve(MAX_UINT) TX first (gas paid by the Agentic Wallet,
 * which is expected to be pre-funded with a small native amount on each
 * CCIP chain).
 *
 * IMPORTANT: server-side function. Never call from the client — needs
 * the Agentic Wallet private key.
 */
export async function executeBridge(p: BridgeSendParams): Promise<BridgeSendResult & { approveTxHash?: string }> {
  const provider = getCCIPProvider(p.src);
  const wallet = new Wallet(p.agenticWalletKey, provider);
  const senderAddr = CCIP_CONFIG[p.src].sender;
  // The Agent Wallet only ever signs the one-time approval below. The bridge call
  // itself is submitted by the RELAYER via bridgeFor(owner, ...) — Q402CCIPSender
  // is facilitator-gated, so a leaked wallet key cannot drain the fee pool.
  const rk = loadRelayerKey();
  if (!rk.ok) throw new Error(`CCIP bridge: relayer key unavailable (${rk.reason})`);
  const relayer = new Wallet(rk.privateKey, provider);
  const sender = new Contract(senderAddr, SENDER_ABI, relayer);

  const feeTokenEnum = p.feeToken === "LINK" ? FEE_TOKEN_LINK : FEE_TOKEN_NATIVE;
  const dstSelector = CCIP_CONFIG[p.dst].chainSelector;

  // ── Lazy approve — first-bridge-per-chain bootstrap ─────────────────────
  // Sender.bridge() does USDC.transferFrom(msg.sender, address(this), amount),
  // so the Agentic Wallet must have allowed Sender to pull USDC. Check the
  // current allowance and approve(MAX_UINT) if insufficient. Idempotent: a
  // single MAX approval covers every future bridge from this wallet on this
  // chain, so this only ever runs on the very first attempt.
  const usdcAddr = getTokenConfig(p.src as ChainKey, "USDC").address;
  const usdc = new Contract(usdcAddr, ERC20_ABI, wallet);
  const allowance = (await usdc.allowance(wallet.address, senderAddr)) as bigint;
  let approveTxHash: string | undefined;
  if (allowance < p.amount) {
    const approveTx = await usdc.approve(senderAddr, 2n ** 256n - 1n);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error("CCIP bridge: approve tx mined but receipt null");
    approveTxHash = approveTx.hash;
  }

  const tx = await sender.bridgeFor(
    wallet.address,
    dstSelector,
    p.amount,
    p.destReceiver,
    feeTokenEnum,
    p.maxFee,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("CCIP bridge: tx mined but receipt null");
  // status === 1 success, 0 reverted. Without this check a reverted tx
  // would fall through the event-scan loop (no BridgeInitiated emitted),
  // return messageId = "" + feeRaw = 0n, and the caller would record a
  // bogus "success" + skip the fee debit — even though the bridge never
  // happened on chain. Fail loud instead so the route surfaces a clean
  // CCIP_BRIDGE_FAILED.
  if (receipt.status !== 1) {
    throw new Error(`CCIP bridge: tx ${tx.hash} reverted on chain (status=${receipt.status})`);
  }

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
  // Defensive — receipt.status was 1 above, so the event MUST have been
  // emitted. If we still didn't find it, something is wrong with the ABI
  // mirror or the Sender contract — better to fail loud than record a
  // success with empty messageId.
  if (!messageId) {
    throw new Error(`CCIP bridge: tx ${tx.hash} mined OK but BridgeInitiated event missing — ABI drift?`);
  }

  return {
    txHash:      tx.hash,
    messageId,
    blockNumber: receipt.blockNumber,
    feeRaw,
    feeToken:    p.feeToken,
    approveTxHash,
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

// ── Live USD pricing via Chainlink Data Feeds ───────────────────────────────
// The CCIP fee AMOUNT is exact (Router.getFee). The USD shown beside it used to
// be hardcoded ($12 LINK / $4000 ETH / $30 AVAX) and drifted far from spot (real
// values were ~$8 / ~$1750 / ~$6.8), which also skewed the "cheaper fee token"
// ranking. We now read live prices from Chainlink Data Feeds (latestRoundData).
// Every address below was verified on-chain (description() matches the pair) via
// scripts/verify-ccip-feeds.mjs. LINK has no Avalanche feed in our set, so its
// (global, fungible) price is read from Ethereum's LINK/USD feed.
const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
] as const;

type PriceFeedRef = { chain: CCIPChainKey; address: string };

const PRICE_FEEDS: Record<CCIPChainKey, { link: PriceFeedRef; native: PriceFeedRef }> = {
  eth: {
    link:   { chain: "eth", address: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c" },
    native: { chain: "eth", address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
  },
  arbitrum: {
    link:   { chain: "arbitrum", address: "0x86E53CF1B870786351Da77A57575e79CB55812CB" },
    native: { chain: "arbitrum", address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" },
  },
  avax: {
    link:   { chain: "eth",  address: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c" },
    native: { chain: "avax", address: "0x0A77230d17318075983913bC2145DB16C7366156" },
  },
};

// Sanity bands: reject a feed read outside these so a wrong/garbage answer can
// never render an absurd USD or flip the cheaper-fee recommendation.
const USD_BOUNDS: Record<"LINK" | "ETH" | "AVAX", [number, number]> = {
  LINK: [0.5, 500],
  ETH:  [100, 50000],
  AVAX: [0.5, 5000],
};

const FALLBACK_USD = { LINK: 12, ETH: 4000, AVAX: 30 } as const;

async function readFeedUsd(ref: PriceFeedRef): Promise<number | null> {
  try {
    const agg = new Contract(ref.address, AGGREGATOR_V3_ABI, getCCIPProvider(ref.chain));
    const [dec, round] = await Promise.all([
      agg.decimals() as Promise<bigint>,
      agg.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
    ]);
    const answer = round[1];
    if (answer <= 0n) return null;
    const price = Number(answer) / 10 ** Number(dec);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Live LINK + native USD prices for a source chain's CCIP fee, from Chainlink
 * Data Feeds. Each read is bounds-checked; an out-of-band or failed read falls
 * back to a conservative constant so the quote still returns. `live` is true
 * only when BOTH reads succeeded in-band, so callers can label the source.
 */
export async function getCCIPFeeUsdPrices(
  src: CCIPChainKey,
): Promise<{ LINK_USD: number; native_USD: number; live: boolean }> {
  const nativeSym: "ETH" | "AVAX" = src === "avax" ? "AVAX" : "ETH";
  const [linkRaw, nativeRaw] = await Promise.all([
    readFeedUsd(PRICE_FEEDS[src].link),
    readFeedUsd(PRICE_FEEDS[src].native),
  ]);
  const inBand = (v: number | null, sym: "LINK" | "ETH" | "AVAX") =>
    v != null && v >= USD_BOUNDS[sym][0] && v <= USD_BOUNDS[sym][1];
  const linkOk = inBand(linkRaw, "LINK");
  const nativeOk = inBand(nativeRaw, nativeSym);
  return {
    LINK_USD: linkOk ? (linkRaw as number) : FALLBACK_USD.LINK,
    native_USD: nativeOk ? (nativeRaw as number) : FALLBACK_USD[nativeSym],
    live: linkOk && nativeOk,
  };
}
