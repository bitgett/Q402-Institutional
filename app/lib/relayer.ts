import { ethers } from "ethers";
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── 체인별 릴레이 방식 (v1.2) ───────────────────────────────────────────────────
// 모든 체인이 EIP-7702 Type 4 TX를 지원한다.
// X Layer는 EIP-7702 (primary) + EIP-3009 (fallback) 두 방식을 모두 지원한다.
//
// 체인별 릴레이 방식:
//   avax / bnb / eth : EIP-7702 (Type 4 TX, Q402PaymentImplementation.transferWithAuthorization())
//   xlayer (primary) : EIP-7702 (Type 4 TX, Q402PaymentImplementationXLayer.transferWithAuthorization())
//   xlayer (fallback): EIP-3009 (Standard TX, USDC.transferWithAuthorization())
//
// 보안 (v1.2): facilitator 주소를 모든 체인에서 명시적으로 전달한다.
//   - avax/bnb/eth: settlePayment()에서 relayer address를 facilitator로 전달
//   - xlayer EIP-7702: settlePaymentXLayerEIP7702()에서 relayer address를 facilitator로 전달

// ── Chain configs ──────────────────────────────────────────────────────────────
export const CHAIN_CONFIG = {
  avax: {
    name: "Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    chainId: 43114,
    token: "AVAX",
    // Q402PaymentImplementation deployed on Avalanche mainnet
    implContract: process.env.IMPLEMENTATION_CONTRACT ?? "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, symbol: "USDT" },
  },
  bnb: {
    name: "BNB Chain",
    rpc: "https://bsc-dataseed1.binance.org/",
    chainId: 56,
    token: "BNB",
    implContract: process.env.BNB_IMPLEMENTATION_CONTRACT ?? "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, symbol: "USDC" },
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, symbol: "USDT" },
  },
  eth: {
    name: "Ethereum",
    rpc: "https://ethereum.publicnode.com",
    chainId: 1,
    token: "ETH",
    implContract: process.env.ETH_IMPLEMENTATION_CONTRACT ?? "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
    usdt: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" },
  },
  xlayer: {
    name: "X Layer",
    rpc: "https://rpc.xlayer.tech",
    chainId: 196,
    token: "OKB",
    implContract: process.env.XLAYER_IMPLEMENTATION_CONTRACT ?? "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    usdc: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6, symbol: "USDT" },
  },
  stable: {
    name: "Stable",
    rpc: "https://rpc.stable.xyz",
    chainId: 988,
    token: "USDT0",
    // Q402PaymentImplementationStable deployed on Stable Mainnet (Chain ID: 988)
    implContract: process.env.STABLE_IMPLEMENTATION_CONTRACT ?? "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // USDT0 is the native gas token and primary transfer token on Stable
    usdc: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18, symbol: "USDT0" },
    usdt: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18, symbol: "USDT0" },
  },
} as const;

export type ChainKey = keyof typeof CHAIN_CONFIG;

// ── Q402PaymentImplementation ABI ─────────────────────────────────────────────
// transferWithAuthorization() is the EIP-7702 delegated execution entry point (v1.2+).
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
// X Layer USDC는 v,r,s 분리 방식(9-param)을 사용한다.
// 확인된 USDC 주소: 0x74b7F16337b8972027F6196A17a631aC6dE26d22 (chainId 196)
const USDC_EIP3009_ABI = [
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
];

export interface EIP3009PayParams {
  /** 토큰 보유자 (서명자) */
  from: string;
  /** 수신자 */
  to: string;
  /** atomic 단위 금액 */
  amount: bigint;
  /** 유효 시작 (보통 0) */
  validAfter: bigint;
  /** 유효 만료 (unix timestamp) */
  validBefore: bigint;
  /** EIP-3009 bytes32 nonce (random) */
  nonce: string;
  /** EIP-3009 서명 (65-byte packed: r+s+v) */
  sig: string;
  /** 체인 키 — 현재 xlayer만 사용 */
  chainKey: ChainKey;
  /** 토큰 심볼 */
  token: "USDC" | "USDT";
}

/**
 * X Layer: USDC EIP-3009 transferWithAuthorization 직접 호출
 *
 * 유저가 USDC의 TransferWithAuthorization 타입으로 서명 →
 * 릴레이어가 USDC.transferWithAuthorization()을 호출해서 가스 대납
 * Q402PaymentImplementation 컨트랙트 불필요
 */
export async function settlePaymentEIP3009(params: EIP3009PayParams): Promise<SettleResult> {
  const pkRaw = process.env.RELAYER_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "your_private_key_here") {
    return { success: false, error: "RELAYER_PRIVATE_KEY not set" };
  }

  const chainCfg = CHAIN_CONFIG[params.chainKey];
  const tokenCfg = getTokenConfig(params.chainKey, params.token);

  try {
    const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
    const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
    const relayer  = new ethers.Wallet(pk, provider);

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

    return {
      success: receipt.status === 1,
      txHash:      tx.hash,
      blockNumber: BigInt(receipt.blockNumber),
      error: receipt.status !== 1 ? "Transaction reverted on-chain" : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

// ── X Layer EIP-7702: Q402PaymentImplementationXLayer ABI ────────────────────
// Contract: 0x31E9D105df96b5294298cFaffB7f106994CD0d0f (X Layer mainnet)
// Witness type: TransferAuthorization (different from PaymentWitness on avax/bnb/eth)
// Key difference: verifyingContract = user's EOA (not impl contract)
//                 msg.sender must equal facilitator param
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
 * X Layer: EIP-7702 transferWithAuthorization via Q402PaymentImplementationXLayer
 *
 * 유저가 TransferAuthorization 타입으로 서명 + EIP-7702 authorization 서명 →
 * 릴레이어(facilitator)가 Type 4 TX 제출, 유저 EOA에 impl 코드 위임 실행
 */
export async function settlePaymentXLayerEIP7702(params: XLayerEIP7702PayParams): Promise<SettleResult> {
  const pkRaw = process.env.RELAYER_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "your_private_key_here") {
    return { success: false, error: "RELAYER_PRIVATE_KEY not set" };
  }

  const chainCfg = CHAIN_CONFIG["xlayer"];

  try {
    const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
    const account = privateKeyToAccount(pk);

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

    return {
      success: receipt.status === "success",
      txHash,
      blockNumber: receipt.blockNumber,
      error: receipt.status !== "success" ? "Transaction reverted" : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

// ── ethers.js relayer wallet (kept for gas estimation / non-EIP7702 ops) ──────
export function getRelayerWallet(chainKey: ChainKey): ethers.Wallet {
  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk || pk === "your_private_key_here") {
    throw new Error("RELAYER_PRIVATE_KEY not set in .env.local");
  }
  const provider = new ethers.JsonRpcProvider(CHAIN_CONFIG[chainKey].rpc);
  return new ethers.Wallet(pk, provider);
}

export function getTokenConfig(chainKey: ChainKey, tokenSymbol: "USDC" | "USDT") {
  const cfg = CHAIN_CONFIG[chainKey];
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
  const pkRaw = process.env.RELAYER_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "your_private_key_here") {
    return { success: false, error: "RELAYER_PRIVATE_KEY not set" };
  }

  const chainCfg = CHAIN_CONFIG[params.chainKey];
  if (!chainCfg.implContract) {
    return { success: false, error: `No impl contract on chain ${params.chainKey}` };
  }

  try {
    const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
    const account = privateKeyToAccount(pk);

    // Use the transport directly without a strongly-typed chain object.
    // This avoids viem chain literal type conflicts when supporting multiple chains.
    const walletClient = createWalletClient({
      account,
      transport: http(chainCfg.rpc),
    });

    const publicClient = createPublicClient({
      transport: http(chainCfg.rpc),
    });

    // Encode transferWithAuthorization() calldata (v1.2 contract interface)
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

    return {
      success: receipt.status === "success",
      txHash,
      blockNumber: receipt.blockNumber,
      error: receipt.status !== "success" ? "Transaction reverted" : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}
