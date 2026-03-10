import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getApiKeyRecord, getGasBalance, recordRelayedTx } from "@/app/lib/db";
import {
  CHAIN_CONFIG,
  getTokenConfig,
  settlePayment,
  type ChainKey,
  type PayParams,
} from "@/app/lib/relayer";
import type { Hex, Address } from "viem";

/**
 * POST /api/relay
 *
 * Gasless EIP-7702 token payment via Q402PaymentImplementation.pay().
 *
 * The client signs two things off-chain:
 *   1. An EIP-712 "witness" signature authorising the transfer.
 *   2. An EIP-7702 authorization so the owner's EOA temporarily runs the
 *      implementation bytecode when called by the facilitator.
 *
 * This endpoint submits a Type-4 (EIP-7702) transaction paying gas from
 * the relayer (facilitator) wallet.
 *
 * Request body:
 * {
 *   apiKey:      "q402_live_xxx",
 *   chain:       "avax" | "bnb" | "eth",
 *   token:       "USDC" | "USDT",
 *   from:        "0xOwner",          // payer EOA
 *   to:          "0xRecipient",
 *   amount:      "50000000",         // raw token units (string)
 *   deadline:    1234567890,         // unix timestamp
 *   paymentId:   "0x...",           // bytes32 unique payment ID
 *   witnessSig:  "0x...",           // EIP-712 witness signature (132 hex chars)
 *   authorization: {
 *     chainId:  43114,
 *     address:  "0xImplContract",
 *     nonce:    0,
 *     yParity: 0,
 *     r: "0x...",
 *     s: "0x..."
 *   }
 * }
 */
export async function POST(req: NextRequest) {
  let body: {
    apiKey: string;
    chain: ChainKey;
    token: "USDC" | "USDT";
    from: string;
    to: string;
    amount: string;
    deadline: number;
    paymentId: string;
    witnessSig: string;
    authorization: {
      chainId: number;
      address: string;
      nonce: number;
      yParity: number;
      r: string;
      s: string;
    };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { apiKey, chain, token, from, to, amount, deadline, paymentId, witnessSig, authorization } = body;

  // ── 1. Validate required fields ────────────────────────────────────────────
  if (!apiKey || !chain || !token || !from || !to || !amount || !deadline || !witnessSig || !authorization) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // ── 2. Validate API key ────────────────────────────────────────────────────
  const keyRecord = getApiKeyRecord(apiKey);
  if (!keyRecord || !keyRecord.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  // ── 3. Check chain supports relay contract ─────────────────────────────────
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg?.implContract) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer.`,
    }, { status: 400 });
  }

  // ── 4. Check gas tank balance ──────────────────────────────────────────────
  const gasBalance = getGasBalance(keyRecord.address);
  const chainBalance = gasBalance[chain] ?? 0;
  if (chainBalance <= 0.0001) {
    const nativeToken = chainCfg.token;
    return NextResponse.json({
      error: `Insufficient gas tank balance on ${chain}. Please deposit ${nativeToken} to your gas tank.`,
    }, { status: 402 });
  }

  // ── 5. Build paymentId as bytes32 ──────────────────────────────────────────
  // Accept either a hex bytes32 or a plain string to hash
  let paymentIdBytes32: Hex;
  if (paymentId && paymentId.startsWith("0x") && paymentId.length === 66) {
    paymentIdBytes32 = paymentId as Hex;
  } else if (paymentId) {
    // Hash a plain string payment ID to bytes32
    paymentIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(paymentId)) as Hex;
  } else {
    // Generate a random payment ID
    paymentIdBytes32 = ethers.keccak256(
      ethers.toUtf8Bytes(`${from}-${to}-${amount}-${deadline}-${Date.now()}`)
    ) as Hex;
  }

  // ── 6. Submit EIP-7702 pay() transaction ───────────────────────────────────
  const tokenCfg = getTokenConfig(chain, token);

  const payParams: PayParams = {
    owner: from as Address,
    token: tokenCfg.address as Address,
    amount: BigInt(amount),
    to: to as Address,
    deadline: BigInt(deadline),
    paymentId: paymentIdBytes32,
    witnessSig: witnessSig as Hex,
    authorization: {
      chainId: Number(authorization.chainId),
      address: authorization.address as Address,
      nonce: Number(authorization.nonce),
      yParity: authorization.yParity,
      r: authorization.r as Hex,
      s: authorization.s as Hex,
    },
    chainKey: chain,
  };

  const result = await settlePayment(payParams);

  if (!result.success) {
    return NextResponse.json({ error: `Relay failed: ${result.error}` }, { status: 400 });
  }

  // ── 7. Record gas usage → deduct from client's gas tank ───────────────────
  const tokenAmount = parseFloat(ethers.formatUnits(amount, tokenCfg.decimals));
  // Gas cost is approximate; a more accurate value can be fetched from the receipt
  const gasCostNative = 0; // Will be refined once gas oracle is integrated

  recordRelayedTx(keyRecord.address, {
    apiKey,
    address: keyRecord.address,
    chain,
    fromUser: from,
    toUser: to,
    tokenAmount,
    tokenSymbol: token,
    gasCostNative,
    relayTxHash: result.txHash ?? "",
    relayedAt: new Date().toISOString(),
  });

  return NextResponse.json({
    success: true,
    txHash: result.txHash,
    blockNumber: result.blockNumber?.toString(),
    tokenAmount,
    token,
    chain,
  });
}
