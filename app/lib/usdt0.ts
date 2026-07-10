/**
 * app/lib/usdt0.ts — Q402 × LayerZero USDT0 (OFT) bridge helpers.
 *
 * Companion rail to app/lib/ccip.ts. CCIP moves USDC; this moves USDT (USDT0)
 * over LayerZero's OFT standard by calling the existing USDT0 OFT deployments.
 * The agent picks the rail by token: USDC -> CCIP, USDT/USDT0 -> OFT.
 *
 * Scope (v1, see contracts.manifest.json `.oft`):
 *   5 chains eth / arbitrum / mantle / monad / xlayer (6-decimal). Mode C only.
 *   The Q402 relayer submits Q402OftSender.bridgeFor (facilitator-gated); the
 *   Agent Wallet pre-approves the Sender for USDT0/USDT. Recipient is force-bound
 *   to the owner's own address on the destination chain. The LayerZero native fee
 *   is paid from the Sender's pool and debited from the Gas Tank 1:1, exactly like
 *   CCIP.
 *
 * Authoritative chain config is contracts.manifest.json; this mirrors it for the
 * typed paths the routes need, and oft-config.test.ts pins them in sync.
 */

import { JsonRpcProvider, Wallet, Contract, zeroPadValue } from "ethers";
import manifest from "../../contracts.manifest.json";
import { getPrimaryRpc } from "./relayer";
import { loadRelayerKey } from "./relayer-key";

// ─── Types ──────────────────────────────────────────────────────────────────

export type OftChainKey = "eth" | "arbitrum" | "mantle" | "monad" | "xlayer";

export interface OftChainConfig {
  eid: number;                         // LayerZero endpoint id
  oft: string;                         // USDT0 OFT (native) or adapter (Ethereum)
  oftType: "native" | "adapter";
  decimals: number;
  sender: string;                      // Q402OftSender deployed address ("" until deployed)
  supportedDestinations: OftChainKey[];
  explorer: string;
  lzScan: string;
}

// ─── Config (mirrors manifest.oft.chains, env-overridable sender) ───────────

const RAW = manifest.oft;
const OFT_KEYS: OftChainKey[] = ["eth", "arbitrum", "mantle", "monad", "xlayer"];

function loadChain(k: OftChainKey): OftChainConfig {
  const c = (RAW.chains as Record<string, {
    eid: number; oft: string; oftType: string; decimals: number; sender: string;
    supportedDestinations: string[]; explorer: string; lzScan: string;
  }>)[k];
  const envSender = process.env[`OFT_SENDER_${k.toUpperCase()}`]?.trim();
  return {
    eid:                   c.eid,
    oft:                   c.oft,
    oftType:               c.oftType === "adapter" ? "adapter" : "native",
    decimals:              c.decimals,
    sender:                envSender || c.sender,
    supportedDestinations: c.supportedDestinations as OftChainKey[],
    explorer:              c.explorer,
    lzScan:                c.lzScan,
  };
}

export const OFT_CONFIG: Record<OftChainKey, OftChainConfig> = {
  eth:      loadChain("eth"),
  arbitrum: loadChain("arbitrum"),
  mantle:   loadChain("mantle"),
  monad:    loadChain("monad"),
  xlayer:   loadChain("xlayer"),
};

export const OFT_CHAINS: OftChainKey[] = OFT_KEYS;

export function isOftChain(s: string): s is OftChainKey {
  return (OFT_KEYS as string[]).includes(s);
}

/** True when the src -> dst lane is a configured USDT0 route. */
export function isOftLane(src: OftChainKey, dst: OftChainKey): boolean {
  return OFT_CONFIG[src].supportedDestinations.includes(dst);
}

/** All directed (src -> dst) USDT0 lanes across the configured chains. */
export function oftLaneMatrix(): { src: OftChainKey; dst: OftChainKey }[] {
  const out: { src: OftChainKey; dst: OftChainKey }[] = [];
  for (const src of OFT_CHAINS) {
    for (const dst of OFT_CONFIG[src].supportedDestinations) out.push({ src, dst });
  }
  return out;
}

// ─── ABIs ────────────────────────────────────────────────────────────────────

const SEND_PARAM_T =
  "(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)";

/** LayerZero IOFT (subset). Reads the USDT0 deployment directly for quotes. */
export const OFT_ABI = [
  "function token() view returns (address)",
  `function quoteSend(${SEND_PARAM_T} sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee))`,
  `function quoteOFT(${SEND_PARAM_T} sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD) oftLimit, (int256 feeAmountLD, string description)[] oftFeeDetails, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)`,
] as const;

/** Q402OftSender ABI (subset). */
export const OFT_SENDER_ABI = [
  "function bridgeFor(address owner, uint32 dstEid, uint256 amountLD, uint256 minAmountLD, uint256 maxNativeFee, bytes extraOptions) returns (bytes32)",
  "function quoteNativeFee(address owner, uint32 dstEid, uint256 amountLD, uint256 minAmountLD, bytes extraOptions) view returns (uint256)",
  "function poolBalance() view returns (uint256)",
  "function TOKEN() view returns (address)",
  "function OFT() view returns (address)",
  "function FACILITATOR() view returns (address)",
  "event OftBridgeInitiated(bytes32 indexed guid, address indexed owner, uint32 indexed dstEid, uint256 amountLD, uint256 amountReceivedLD, uint256 nativeFeePaid)",
] as const;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

// Default slippage floor on the OFT-reported received amount (0.5%).
export const OFT_SLIPPAGE_BPS = 50n;

// ─── Providers + SendParam ───────────────────────────────────────────────────

export function getOftProvider(chain: OftChainKey): JsonRpcProvider {
  return new JsonRpcProvider(getPrimaryRpc(chain));
}

/**
 * Build the OFT SendParam tuple. The recipient is ALWAYS the owner's own address
 * on the destination chain (bytes32 left-padded) — a cross-chain move to self,
 * never a third-party transfer. The on-chain Q402OftSender enforces the same.
 */
export function buildSendParam(
  owner: string,
  dstEid: number,
  amountLD: bigint,
  minAmountLD: bigint,
  extraOptions: string = "0x",
): [number, string, bigint, bigint, string, string, string] {
  return [dstEid, zeroPadValue(owner, 32), amountLD, minAmountLD, extraOptions, "0x", "0x"];
}

// ─── Quote (provider-only, no signer) ────────────────────────────────────────

export interface OftQuote {
  nativeFee: bigint;         // LayerZero native messaging fee (source-chain wei)
  amountReceivedLD: bigint;  // OFT-reported amount delivered on the destination
  minAmountLD: bigint;       // slippage floor bound into the send
  limitMinLD: bigint;        // path credit floor
  limitMaxLD: bigint;        // path credit ceiling
}

/**
 * Quote a USDT0 bridge directly against the source OFT deployment: the delivered
 * amount + path limits (quoteOFT) and the native fee (quoteSend). Throws on a
 * lane that is not configured or when the amount is outside the path credit.
 */
export async function quoteOftBridge(
  src: OftChainKey,
  dst: OftChainKey,
  amountLD: bigint,
  owner: string,
  opts: { slippageBps?: bigint; extraOptions?: string } = {},
): Promise<OftQuote> {
  if (!isOftLane(src, dst)) throw new Error(`OFT: ${src} -> ${dst} is not a supported lane`);
  const extraOptions = opts.extraOptions ?? "0x";
  const eid = OFT_CONFIG[dst].eid;
  const oft = new Contract(OFT_CONFIG[src].oft, OFT_ABI, getOftProvider(src));

  // quoteOFT with a zero floor to read the delivered amount + path limits.
  const probe = buildSendParam(owner, eid, amountLD, 0n, extraOptions);
  const [limit, , receipt] = await oft.quoteOFT(probe) as [
    { minAmountLD: bigint; maxAmountLD: bigint },
    unknown,
    { amountSentLD: bigint; amountReceivedLD: bigint },
  ];
  const limitMinLD = limit.minAmountLD;
  const limitMaxLD = limit.maxAmountLD;
  if (amountLD > limitMaxLD) {
    throw new Error(`OFT: amount exceeds ${src} -> ${dst} path credit (max ${limitMaxLD})`);
  }
  const amountReceivedLD = receipt.amountReceivedLD;

  const slippageBps = opts.slippageBps ?? OFT_SLIPPAGE_BPS;
  const minAmountLD = (amountReceivedLD * (10_000n - slippageBps)) / 10_000n;

  // quoteSend with the real floor to price the message.
  const sp = buildSendParam(owner, eid, amountLD, minAmountLD, extraOptions);
  const fee = await oft.quoteSend(sp, false) as { nativeFee: bigint; lzTokenFee: bigint };

  return { nativeFee: fee.nativeFee, amountReceivedLD, minAmountLD, limitMinLD, limitMaxLD };
}

// ─── Execute (server-side; relayer submits bridgeFor) ────────────────────────

export interface OftBridgeParams {
  src:              OftChainKey;
  dst:              OftChainKey;
  owner:            string;   // Agent Wallet address (also the destination recipient)
  amountLD:         bigint;
  minAmountLD:      bigint;   // from quoteOftBridge
  maxNativeFee:     bigint;   // revert if the on-chain quote is higher
  agenticWalletKey: string;   // hex private key of the source-chain Agent Wallet (for the approval)
  extraOptions?:    string;
}

export interface OftBridgeResult {
  txHash:           string;
  guid:             string;
  blockNumber:      number;
  nativeFeePaid:    bigint;
  amountReceivedLD: bigint;
  approveTxHash?:   string;
}

/**
 * Submit a USDT0 bridge through Q402OftSender.
 *
 * The Agent Wallet only ever signs a one-time approval of the Sender (gas paid by
 * the wallet, pre-funded per chain like the CCIP path). The BRIDGE itself is
 * submitted by the Q402 relayer via bridgeFor(owner, ...) — the Sender is
 * facilitator-gated, so a leaked wallet key cannot drain the fee pool, and gas for
 * every bridge after the first approval is paid by the relayer.
 *
 * IMPORTANT: server-side only — needs both the Agent Wallet key (approval) and the
 * relayer key (bridgeFor). Off-chain Gas Tank debit is the caller's responsibility.
 */
export async function executeOftBridge(p: OftBridgeParams): Promise<OftBridgeResult> {
  const senderAddr = OFT_CONFIG[p.src].sender;
  if (!senderAddr) throw new Error(`OFT: Q402OftSender not deployed on ${p.src}`);

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) throw new Error(`OFT: relayer key unavailable (${relayerKey.reason})`);

  const provider = getOftProvider(p.src);
  const wallet = new Wallet(p.agenticWalletKey, provider);
  const relayer = new Wallet(relayerKey.privateKey, provider);

  // ── Lazy approve — wallet allows the Sender to pull its USDT0/USDT ───────────
  // Read the token from the Sender (matches its on-chain OFT.token() derivation,
  // so a native OFT approves the OFT itself and Ethereum approves native USDT).
  const senderRead = new Contract(senderAddr, OFT_SENDER_ABI, provider);
  const tokenAddr = (await senderRead.TOKEN()) as string;
  const token = new Contract(tokenAddr, ERC20_ABI, wallet);
  const allowance = (await token.allowance(wallet.address, senderAddr)) as bigint;
  let approveTxHash: string | undefined;
  if (allowance < p.amountLD) {
    const approveTx = await token.approve(senderAddr, 2n ** 256n - 1n);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error("OFT bridge: approve tx mined but receipt null");
    approveTxHash = approveTx.hash;
  }

  // ── Bridge — RELAYER submits (facilitator-gated), pulls the owner's approval ──
  const sender = new Contract(senderAddr, OFT_SENDER_ABI, relayer);
  const tx = await sender.bridgeFor(
    p.owner,
    OFT_CONFIG[p.dst].eid,
    p.amountLD,
    p.minAmountLD,
    p.maxNativeFee,
    p.extraOptions ?? "0x",
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("OFT bridge: tx mined but receipt null");
  if (receipt.status !== 1) {
    throw new Error(`OFT bridge: tx ${tx.hash} reverted on chain (status=${receipt.status})`);
  }

  const iface = sender.interface;
  let guid = "";
  let nativeFeePaid = 0n;
  let amountReceivedLD = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "OftBridgeInitiated") {
        guid = parsed.args.guid as string;
        nativeFeePaid = parsed.args.nativeFeePaid as bigint;
        amountReceivedLD = parsed.args.amountReceivedLD as bigint;
        break;
      }
    } catch { /* not our event */ }
  }
  if (!guid) {
    throw new Error(`OFT bridge: tx ${tx.hash} mined OK but OftBridgeInitiated missing — ABI drift?`);
  }

  return {
    txHash: tx.hash,
    guid,
    blockNumber: receipt.blockNumber,
    nativeFeePaid,
    amountReceivedLD,
    approveTxHash,
  };
}
