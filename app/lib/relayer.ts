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

// ── Chain configs ──────────────────────────────────────────────────────────────
export const CHAIN_CONFIG = {
  avax: {
    name: "Avalanche",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    chainId: 43114,
    token: "AVAX",
    // Q402PaymentImplementation deployed on Avalanche mainnet
    implContract: process.env.IMPLEMENTATION_CONTRACT ?? "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, symbol: "USDT" },
  },
  bnb: {
    name: "BNB Chain",
    rpc: "https://bsc-dataseed1.binance.org/",
    chainId: 56,
    token: "BNB",
    implContract: process.env.BNB_IMPLEMENTATION_CONTRACT ?? "0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6",
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, symbol: "USDC" },
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, symbol: "USDT" },
  },
  eth: {
    name: "Ethereum",
    rpc: "https://ethereum.publicnode.com",
    chainId: 1,
    token: "ETH",
    implContract: process.env.ETH_IMPLEMENTATION_CONTRACT ?? "0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
    usdt: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" },
  },
  xlayer: {
    name: "X Layer",
    rpc: "https://rpc.xlayer.tech",
    chainId: 196,
    token: "OKB",
    implContract: process.env.XLAYER_IMPLEMENTATION_CONTRACT ?? "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    usdc: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6, symbol: "USDC" },
    usdt: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6, symbol: "USDT" },
  },
} as const;

export type ChainKey = keyof typeof CHAIN_CONFIG;

// ── Q402PaymentImplementation ABI ─────────────────────────────────────────────
// pay() is the EIP-7702 delegated execution entry point.
// The contract is deployed as the implementation; the owner's EOA delegates to it
// via an EIP-7702 authorization, and then pay() is called on the owner's EOA.
export const Q402_IMPL_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner",     type: "address" },
      { name: "token",     type: "address" },
      { name: "amount",    type: "uint256" },
      { name: "to",        type: "address" },
      { name: "deadline",  type: "uint256" },
      { name: "paymentId", type: "bytes32" },
      { name: "witnessSig",type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "payBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "items",
        type: "tuple[]",
        components: [
          { name: "token",  type: "address" },
          { name: "amount", type: "uint256" },
          { name: "to",     type: "address" },
        ],
      },
      { name: "deadline",  type: "uint256" },
      { name: "paymentId", type: "bytes32" },
      { name: "witnessSig",type: "bytes"   },
    ],
    outputs: [],
  },
] as const;

// Legacy human-readable ABI kept for ethers.js usage if needed elsewhere
export const Q402_IMPL_ABI_HUMAN = [
  "function pay(address owner, address token, uint256 amount, address to, uint256 deadline, bytes32 paymentId, bytes calldata witnessSig) external",
  "function payBatch(address owner, tuple(address token, uint256 amount, address to)[] items, uint256 deadline, bytes32 paymentId, bytes calldata witnessSig) external",
];

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
  /** Token contract (e.g. USDC) */
  token: Address;
  /** Amount in token atomic units */
  amount: bigint;
  /** Recipient */
  to: Address;
  /** Unix timestamp deadline */
  deadline: bigint;
  /** Unique payment ID (bytes32) */
  paymentId: Hex;
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

    // Encode pay() calldata
    const callData = encodeFunctionData({
      abi: Q402_IMPL_ABI,
      functionName: "pay",
      args: [
        params.owner,
        params.token,
        params.amount,
        params.to,
        params.deadline,
        params.paymentId,
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
