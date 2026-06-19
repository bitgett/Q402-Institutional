import { ethers } from "ethers";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRelayerKey } from "./relayer-key";
import { isChainDisabled } from "./chain-status";

// ── Per-chain relay dispatch (v1.3) ──────────────────────────────────────────
// All 11 chains (avax / bnb / eth / xlayer / stable / mantle / injective / monad / scroll / arbitrum / base) default to EIP-7702 Type 4 TXs.
// X Layer additionally supports EIP-3009 as a USDC-only fallback.
//
// Chain → relay method:
//   avax / bnb / eth / stable : EIP-7702 (Q402PaymentImplementation.transferWithAuthorization())
//   xlayer (primary)          : EIP-7702 (Q402PaymentImplementationXLayer.transferWithAuthorization())
//   xlayer (fallback)         : EIP-3009 (USDC.transferWithAuthorization(), pass eip3009Nonce)
//
// Security (v1.3): the facilitator address is passed explicitly on every chain.
//   - settlePayment() / settlePaymentXLayerEIP7702() / settlePaymentStableEIP7702()
//     all forward the relayer address as facilitator
//   - Authorization Guard: chainId + impl address are pinned server-side against
//     contracts.manifest.json

// ── RPC helpers ───────────────────────────────────────────────────────────────
// Each chain has a primary RPC + fallbacks.  getChainRpc() tries them in order.
const CHAIN_RPC_FALLBACKS: Record<string, string[]> = {
  avax:   [
    "https://api.avax.network/ext/bc/C/rpc",
    "https://avalanche-c-chain-rpc.publicnode.com",
    "https://rpc.ankr.com/avalanche",
  ],
  bnb:    [
    "https://bsc-dataseed1.binance.org/",
    "https://bsc-dataseed2.binance.org/",
    "https://bsc.publicnode.com",
  ],
  eth:    [
    "https://ethereum.publicnode.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ],
  xlayer: [
    "https://rpc.xlayer.tech",
    "https://xlayerrpc.okx.com",
  ],
  stable: [
    "https://rpc.stable.xyz",
  ],
  mantle: [
    "https://rpc.mantle.xyz",
    "https://mantle-rpc.publicnode.com",
    "https://rpc.ankr.com/mantle",
  ],
  injective: [
    "https://sentry.evm-rpc.injective.network/",
    "https://1776.rpc.thirdweb.com",
  ],
  monad: [
    "https://rpc.monad.xyz",
    "https://rpc1.monad.xyz",
    "https://rpc2.monad.xyz",
  ],
  scroll: [
    "https://rpc.scroll.io",
    "https://scroll-mainnet.public.blastapi.io",
    "https://scroll.drpc.org",
  ],
  arbitrum: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.publicnode.com",
    "https://arbitrum.drpc.org",
    "https://rpc.ankr.com/arbitrum",
  ],
  base: [
    "https://mainnet.base.org",
    "https://base.publicnode.com",
    "https://base.drpc.org",
    "https://rpc.ankr.com/base",
  ],
};

export function getPrimaryRpc(chain: string): string {
  return CHAIN_RPC_FALLBACKS[chain]?.[0] ?? "https://ethereum.publicnode.com";
}

export function getFallbackRpcs(chain: string): string[] {
  return CHAIN_RPC_FALLBACKS[chain] ?? [];
}

// ── Chain configs ──────────────────────────────────────────────────────────────
export const CHAIN_CONFIG = {
  avax: {
    name: "Avalanche",
    rpc: process.env.AVAX_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",
    chainId: 43114,
    token: "AVAX",
    // Q402PaymentImplementation deployed on Avalanche mainnet.
    // Historical note: `IMPLEMENTATION_CONTRACT` (unprefixed) was the first
    // env var added and remains in existing Vercel projects. New deployments
    // should use `AVAX_IMPLEMENTATION_CONTRACT` (matches BNB/ETH/XLAYER/STABLE
    // naming and what .env.example documents). Both are read here for compat.
    implContract: process.env.AVAX_IMPLEMENTATION_CONTRACT?.trim() || process.env.IMPLEMENTATION_CONTRACT?.trim() || "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, symbol: "USDT" },
  },
  bnb: {
    name: "BNB Chain",
    rpc: process.env.BNB_RPC_URL ?? "https://bsc-dataseed1.binance.org/",
    chainId: 56,
    token: "BNB",
    implContract: process.env.BNB_IMPLEMENTATION_CONTRACT?.trim() || "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, symbol: "USDC" },
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, symbol: "USDT" },
  },
  eth: {
    name: "Ethereum",
    rpc: process.env.ETH_RPC_URL ?? "https://ethereum.publicnode.com",
    chainId: 1,
    token: "ETH",
    implContract: process.env.ETH_IMPLEMENTATION_CONTRACT?.trim() || "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
    usdt: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" },
    // Ripple USD — NY DFS regulated stablecoin. ERC-20 + EIP-2612 permit, decimals 18.
    // UUPS proxy; implementation at 0x9747a0d261c2d56eb93f542068e5d1e23170fa9e.
    // Only listed on Ethereum (no XRPL EVM deployment yet; XRPL native is non-EVM and
    // out of scope). Cross-chain use is rejected by CHAIN_TOKEN_ALLOWLIST in the relay route.
    rlusd: { address: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD", decimals: 18, symbol: "RLUSD" },
  },
  xlayer: {
    name: "X Layer",
    rpc: process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech",
    chainId: 196,
    token: "OKB",
    implContract: process.env.XLAYER_IMPLEMENTATION_CONTRACT?.trim() || "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    usdc: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6, symbol: "USDT" },
  },
  stable: {
    name: "Stable",
    rpc: process.env.STABLE_RPC_URL ?? "https://rpc.stable.xyz",
    chainId: 988,
    token: "USDT0",
    // Q402PaymentImplementationStable deployed on Stable Mainnet (Chain ID: 988)
    implContract: process.env.STABLE_IMPLEMENTATION_CONTRACT?.trim() || "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // USDT0 is the native gas token and primary transfer token on Stable
    usdc: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18, symbol: "USDT0" },
    usdt: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18, symbol: "USDT0" },
  },
  mantle: {
    name: "Mantle",
    rpc: process.env.MANTLE_RPC_URL ?? "https://rpc.mantle.xyz",
    chainId: 5000,
    token: "MNT",
    // Q402PaymentImplementationMantle (guarded) on Mantle mainnet (chainId 5000),
    // on-chain NAME() = "Q402 Mantle". Empty env falls back to the default address.
    implContract: process.env.MANTLE_IMPLEMENTATION_CONTRACT?.trim() || "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
    usdc: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6, symbol: "USDC" },
    // USDT0 (LayerZero OFT) — Mantle's ecosystem default per the 2025-11-27 official
    // announcement. Legacy canonical-bridged USDT (0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE)
    // deposits sunset 2026-02-03; Bybit withdrawals to Mantle now deliver USDT0, so new
    // users will hold this address. Same 0x779Ded... as Stable via CREATE3 OFT deployment;
    // decimals are per-chain (Mantle 6, Stable 18) — symbol exposed as "USDT" to keep the
    // SDK API surface (`token: "USDT"`) consistent with the other chains.
    usdt: { address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6, symbol: "USDT" },
  },
  injective: {
    name: "Injective",
    rpc: process.env.INJECTIVE_RPC_URL ?? "https://sentry.evm-rpc.injective.network/",
    chainId: 1776,
    token: "INJ",
    // Q402PaymentImplementationInjective (guarded) on Injective EVM mainnet
    // (chainId 1776), deployed 2026-06-15, on-chain NAME() = "Q402 Injective".
    implContract: process.env.INJECTIVE_IMPLEMENTATION_CONTRACT?.trim() || "0xa9a7dcE76DEF2AC36057FeF0d8103dF10581d61e",
    // Native Circle USDC (CCTP, live since 2026-06) + canonical Tether (USDT0), both 6 dec.
    // Cosmos and EVM share one balance via the MultiVM Token Standard.
    usdc: { address: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13", decimals: 6, symbol: "USDT" },
  },
  monad: {
    name: "Monad",
    rpc: process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz",
    chainId: 143,
    token: "MON",
    // Q402PaymentImplementationMonad (guarded) on Monad mainnet (chainId 143),
    // deployed 2026-06-15 by 0xfc77...f466, on-chain NAME() = "Q402 Monad".
    implContract: process.env.MONAD_IMPLEMENTATION_CONTRACT?.trim() || "0xc5d4dFA6D2e545409C1abf86f336Dd43bb87621f",
    // Native Circle USDC via CCTP V2 (not bridged) — 6 decimals.
    usdc: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, symbol: "USDC" },
    // USDT0 (LayerZero OFT) — Tether omnichain standard on Monad. Same OFT family as
    // Mantle's USDT0 entry, exposed as "USDT" through the SDK to keep API surface
    // (`token: "USDT"`) consistent with other chains. Decimals = 6 (per on-chain eth_call).
    usdt: { address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6, symbol: "USDT" },
  },
  scroll: {
    name: "Scroll",
    rpc: process.env.SCROLL_RPC_URL ?? "https://rpc.scroll.io",
    chainId: 534352,
    token: "ETH",
    // Q402PaymentImplementationScroll (guarded) redeployed on Scroll mainnet
    // (chainId 534352) 2026-06-15 by 0xfc77...f466, on-chain NAME() = "Q402 Scroll".
    // The impl address is per-chain (CREATE depends on the deployer nonce) — not
    // shared across chains. EIP-7702 live on Scroll since the Euclid Phase 2 upgrade
    // (2025-04-22).
    implContract: process.env.SCROLL_IMPLEMENTATION_CONTRACT?.trim() || "0x7635F32D893B64b5944CB8cbF2AC4cd3dA41B2f1",
    // Native Circle USDC + canonical Tether on Scroll, both 6 decimals
    // (confirmed with the Scroll team for the integration handshake).
    usdc: { address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6, symbol: "USDC" },
    usdt: { address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", decimals: 6, symbol: "USDT" },
  },
  arbitrum: {
    name: "Arbitrum",
    rpc: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
    token: "ETH",
    // Q402PaymentImplementationArbitrum (guarded) redeployed on Arbitrum One
    // (chainId 42161) 2026-06-15 by 0xfc77...f466, on-chain NAME() = "Q402 Arbitrum".
    // The impl address is per-chain (CREATE depends on the deployer nonce) — not
    // shared across chains. EIP-7702 live on Arbitrum One since ArbOS 40 "Callisto";
    // ArbOS 51 "Dia" (2026-01-08) refined precompile delegation per spec.
    implContract: process.env.ARBITRUM_IMPLEMENTATION_CONTRACT?.trim() || "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    // Native Circle USDC (CCTP) + canonical Tether on Arbitrum One. The legacy
    // bridged USDC.e (0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8) is NOT supported
    // — Q402 stays on native Circle USDC to avoid the bridged/native confusion
    // that surfaced during Mantle's USDT migration.
    usdc: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, symbol: "USDC" },
    usdt: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, symbol: "USDT" },
  },
  base: {
    name: "Base",
    rpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    chainId: 8453,
    token: "ETH",
    // Q402PaymentImplementation (guarded, "Q402 Base") deployed on Base mainnet
    // (chainId 8453) 2026-06-19 by 0xfc77...f466. On-chain verified: NAME() =
    // "Q402 Base", VERSION() = "1", owner-binding reverts OwnerMismatch(). CREATE
    // at nonce 0 on Base, so the address coincides with the Stable-chain impl —
    // distinct chains, not a shared deployment. EIP-7702 live on Base via the OP
    // Stack Isthmus upgrade.
    implContract: process.env.BASE_IMPLEMENTATION_CONTRACT?.trim() || "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // Native Circle USDC + bridged Tether USD on Base, both 6 decimals. Native
    // USDC only (not legacy bridged USDbC). USDT on Base is a bridged token.
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
    usdt: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, symbol: "USDT" },
  },
} as const;

export type ChainKey = keyof typeof CHAIN_CONFIG;

// ── Q402PaymentImplementation ABI ─────────────────────────────────────────────
// transferWithAuthorization() is the EIP-7702 delegated execution entry point (v1.3).
// The owner's EOA delegates to the implementation via EIP-7702 authorization,
// then transferWithAuthorization() is called on the owner's EOA address.
// msg.sender (facilitator) must match the signed facilitator param.
export const Q402_IMPL_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner",            type: "address" },
      { name: "facilitator",      type: "address" },
      { name: "token",            type: "address" },
      { name: "recipient",        type: "address" },
      { name: "amount",           type: "uint256" },
      { name: "nonce",            type: "uint256" },
      { name: "deadline",         type: "uint256" },
      { name: "witnessSignature", type: "bytes"   },
    ],
    outputs: [],
  },
] as const;

// ── X Layer USDC EIP-3009 ABI ─────────────────────────────────────────────────
// X Layer USDC takes v,r,s as separate args (9-param form).
// Confirmed USDC address: 0x74b7F16337b8972027F6196A17a631aC6dE26d22 (chainId 196)
const USDC_EIP3009_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
];

export interface EIP3009PayParams {
  /** Token holder (signer) */
  from: string;
  /** Recipient */
  to: string;
  /** Amount in atomic units */
  amount: bigint;
  /** Valid-after (typically 0) */
  validAfter: bigint;
  /** Valid-before (unix timestamp) */
  validBefore: bigint;
  /** EIP-3009 bytes32 nonce (random) */
  nonce: string;
  /** EIP-3009 signature (65-byte packed: r+s+v) */
  sig: string;
  /** Chain key — X Layer (EIP-3009 fallback) or Base (x402 rail). Generic over
   *  any chain whose USDC implements the standard EIP-3009 9-param form. */
  chainKey: ChainKey;
  /** Token symbol */
  token: "USDC" | "USDT" | "RLUSD";
}

/**
 * X Layer: direct USDC EIP-3009 transferWithAuthorization call.
 *
 * User signs USDC's TransferWithAuthorization type →
 * relayer invokes USDC.transferWithAuthorization() and pays the gas.
 * The Q402PaymentImplementation contract is not involved in this path.
 */
export async function settlePaymentEIP3009(params: EIP3009PayParams): Promise<SettleResult> {
  const key = loadRelayerKey();
  if (!key.ok) {
    return { success: false, error: key.reason === "mismatch" ? "Relayer key/address mismatch" : "RELAYER_PRIVATE_KEY not set" };
  }

  const chainCfg = CHAIN_CONFIG[params.chainKey];
  const tokenCfg = getTokenConfig(params.chainKey, params.token);

  try {
    const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
    const relayer  = new ethers.Wallet(key.privateKey, provider);

    const { v, r, s } = ethers.Signature.from(params.sig);

    const usdc = new ethers.Contract(tokenCfg.address, USDC_EIP3009_ABI, relayer);

    const tx = await usdc.transferWithAuthorization(
      params.from,
      params.to,
      params.amount,
      params.validAfter,
      params.validBefore,
      params.nonce,
      v, r, s,
      { gasLimit: 200000n }
    );

    const receipt = await tx.wait();
    const gasUsed  = receipt.gasUsed  ?? 0n;
    const gasPrice = receipt.gasPrice ?? 0n;
    const gasCostNative = parseFloat(ethers.formatEther(gasUsed * gasPrice));

    return {
      success: receipt.status === 1,
      txHash:      tx.hash,
      blockNumber: BigInt(receipt.blockNumber),
      gasCostNative,
      error: receipt.status !== 1 ? "Transaction reverted on-chain" : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

// ── X Layer EIP-7702: Q402PaymentImplementationXLayer ABI ────────────────────
// Contract: 0x8D854436ab0426F5BC6Cc70865C90576AD523E73 (X Layer mainnet)
// Witness type: TransferAuthorization (identical scheme across all 11 chains)
// Key detail: verifyingContract = user's EOA (address(this) under EIP-7702)
//             msg.sender must equal facilitator param
const XLAYER_EIP7702_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner",            type: "address" },
      { name: "facilitator",      type: "address" },
      { name: "token",            type: "address" },
      { name: "recipient",        type: "address" },
      { name: "amount",           type: "uint256" },
      { name: "nonce",            type: "uint256" },
      { name: "deadline",         type: "uint256" },
      { name: "witnessSignature", type: "bytes"   },
    ],
    outputs: [],
  },
] as const;

export interface XLayerEIP7702PayParams {
  /** Token owner — the user whose EOA is delegated */
  owner: Address;
  /** Relayer wallet address (msg.sender on-chain, must match signed facilitator) */
  facilitator: Address;
  /** ERC-20 token address */
  token: Address;
  /** Payment recipient */
  recipient: Address;
  /** Amount in atomic units */
  amount: bigint;
  /** Random uint256 nonce (replay protection — not sequential) */
  nonce: bigint;
  /** Unix timestamp deadline */
  deadline: bigint;
  /** EIP-712 TransferAuthorization signature */
  witnessSig: Hex;
  /** EIP-7702 authorization from the owner's EOA */
  authorization: {
    chainId: number;
    address: Address;
    nonce: number;
    yParity: number;
    r: Hex;
    s: Hex;
  };
}

/**
 * X Layer: EIP-7702 transferWithAuthorization via Q402PaymentImplementationXLayer.
 *
 * User signs the TransferAuthorization witness + an EIP-7702 authorization →
 * the relayer (facilitator) submits the Type 4 TX, delegating impl code to the
 * user EOA for execution.
 */
export async function settlePaymentXLayerEIP7702(params: XLayerEIP7702PayParams): Promise<SettleResult> {
  const key = loadRelayerKey();
  if (!key.ok) {
    return { success: false, error: key.reason === "mismatch" ? "Relayer key/address mismatch" : "RELAYER_PRIVATE_KEY not set" };
  }

  const chainCfg = CHAIN_CONFIG["xlayer"];

  try {
    const account = privateKeyToAccount(key.privateKey);

    const walletClient = createWalletClient({
      account,
      transport: http(chainCfg.rpc),
    });

    const publicClient = createPublicClient({
      transport: http(chainCfg.rpc),
    });

    const callData = encodeFunctionData({
      abi: XLAYER_EIP7702_ABI,
      functionName: "transferWithAuthorization",
      args: [
        params.owner,
        params.facilitator,
        params.token,
        params.recipient,
        params.amount,
        params.nonce,
        params.deadline,
        params.witnessSig,
      ],
    });

    // EIP-7702 Type 4 TX: to = owner's EOA, authorizationList delegates impl code
    const txHash = await walletClient.sendTransaction({
      chain: null,
      to: params.owner,
      data: callData,
      gas: BigInt(300000),
      authorizationList: [
        {
          chainId: params.authorization.chainId,
          address: params.authorization.address,
          nonce: params.authorization.nonce,
          yParity: params.authorization.yParity,
          r: params.authorization.r,
          s: params.authorization.s,
        },
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasUsed  = receipt.gasUsed        ?? 0n;
    const gasPrice = receipt.effectiveGasPrice ?? 0n;
    const gasCostNative = parseFloat(formatEther(gasUsed * gasPrice));

    return {
      success: receipt.status === "success",
      txHash,
      blockNumber: receipt.blockNumber,
      gasCostNative,
      error: receipt.status !== "success" ? "Transaction reverted" : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

// ── ethers.js relayer wallet (kept for gas estimation / non-EIP7702 ops) ──────
export function getRelayerWallet(chainKey: ChainKey): ethers.Wallet {
  const key = loadRelayerKey();
  if (!key.ok) {
    throw new Error(
      key.reason === "mismatch"
        ? `RELAYER_PRIVATE_KEY/address mismatch (${key.detail})`
        : "RELAYER_PRIVATE_KEY not set in .env.local"
    );
  }
  const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG[chainKey].rpc);
  return new ethers.Wallet(key.privateKey, provider);
}

export function getTokenConfig(chainKey: ChainKey, tokenSymbol: "USDC" | "USDT" | "RLUSD") {
  const cfg = CHAIN_CONFIG[chainKey];
  if (tokenSymbol === "RLUSD") {
    // RLUSD is Ethereum-only. The relay route's CHAIN_TOKEN_ALLOWLIST rejects
    // chain≠eth + token=RLUSD before we reach here, so this access is safe.
    // Throwing instead of returning undefined keeps the function's return type
    // narrow (no `| undefined`) for callers that index into .address / .decimals.
    if (chainKey !== "eth") {
      throw new Error(`RLUSD is only supported on Ethereum mainnet (got chain=${chainKey})`);
    }
    return (cfg as typeof CHAIN_CONFIG.eth).rlusd;
  }
  return tokenSymbol === "USDC" ? cfg.usdc : cfg.usdt;
}

// ── EIP-7702 pay() via viem ───────────────────────────────────────────────────
// The EIP-7702 flow requires a Type 4 transaction which ethers.js v6 does not
// support natively. We use viem's walletClient.sendTransaction with an
// authorizationList field.

export interface PayParams {
  /** Owner / payer EOA address */
  owner: Address;
  /** Gas sponsor address — must match the facilitator param the user signed */
  facilitator: Address;
  /** Token contract (e.g. USDC) */
  token: Address;
  /** Amount in token atomic units */
  amount: bigint;
  /** Recipient */
  to: Address;
  /** uint256 nonce for replay protection */
  nonce: bigint;
  /** Unix timestamp deadline */
  deadline: bigint;
  /** EIP-712 witness signature */
  witnessSig: Hex;
  /** EIP-7702 signed authorization from the owner's EOA */
  authorization: {
    /** Chain ID as number (viem authorizationList requirement) */
    chainId: number;
    address: Address;
    /** Nonce as number (viem authorizationList requirement) */
    nonce: number;
    yParity: number;
    r: Hex;
    s: Hex;
  };
  /** Which chain to submit on */
  chainKey: ChainKey;
}

export interface SettleResult {
  success: boolean;
  txHash?: string;
  blockNumber?: bigint;
  gasCostNative?: number;   // gas fee in native token (computed from receipt)
  error?: string;
}

/**
 * Submit an EIP-7702 pay() transaction using viem.
 *
 * The relayer (facilitator) wallet sends a Type 4 transaction that:
 *  1. Sets an authorizationList so the owner's EOA temporarily executes
 *     the Q402PaymentImplementation bytecode.
 *  2. Calls pay() on the owner's EOA address, which runs the implementation.
 */
export async function settlePayment(params: PayParams): Promise<SettleResult> {
  // Held chains (chain-status.ts) — settlement is paused until the on-chain
  // impl is refreshed. This is the universal EIP-7702 chokepoint, so every
  // caller (relay route, recurring cron, …) is covered here at once.
  if (isChainDisabled(params.chainKey)) {
    return { success: false, error: `Chain ${params.chainKey} is temporarily unavailable` };
  }

  const key = loadRelayerKey();
  if (!key.ok) {
    return { success: false, error: key.reason === "mismatch" ? "Relayer key/address mismatch" : "RELAYER_PRIVATE_KEY not set" };
  }

  const chainCfg = CHAIN_CONFIG[params.chainKey];
  if (!chainCfg.implContract) {
    return { success: false, error: `No impl contract on chain ${params.chainKey}` };
  }

  try {
    const account = privateKeyToAccount(key.privateKey);

    // Use the transport directly without a strongly-typed chain object.
    // This avoids viem chain literal type conflicts when supporting multiple chains.
    const walletClient = createWalletClient({
      account,
      transport: http(chainCfg.rpc),
    });

    const publicClient = createPublicClient({
      transport: http(chainCfg.rpc),
    });

    // Encode transferWithAuthorization() calldata (v1.3 contract interface)
    const callData = encodeFunctionData({
      abi: Q402_IMPL_ABI,
      functionName: "transferWithAuthorization",
      args: [
        params.owner,
        params.facilitator,
        params.token,
        params.to,
        params.amount,
        params.nonce,
        params.deadline,
        params.witnessSig,
      ],
    });

    // EIP-7702 Type 4 transaction
    // The `to` is the owner's EOA; the authorizationList delegates the impl
    // code to the owner's EOA for this transaction.
    const txHash = await walletClient.sendTransaction({
      chain: null,
      to: params.owner,        // call the owner's EOA (which now runs impl code)
      data: callData,
      gas: BigInt(300000),
      authorizationList: [
        {
          chainId: params.authorization.chainId,
          address: params.authorization.address,
          nonce: params.authorization.nonce,
          yParity: params.authorization.yParity,
          r: params.authorization.r,
          s: params.authorization.s,
        },
      ],
    });

    // Wait for receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasUsed  = receipt.gasUsed        ?? 0n;
    const gasPrice = receipt.effectiveGasPrice ?? 0n;
    const gasCostNative = parseFloat(formatEther(gasUsed * gasPrice));

    return {
      success: receipt.status === "success",
      txHash,
      blockNumber: receipt.blockNumber,
      gasCostNative,
      error: receipt.status !== "success" ? "Transaction reverted" : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
