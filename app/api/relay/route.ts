import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getApiKeyRecord, getGasBalance, recordRelayedTx } from "@/app/lib/db";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_CONFIG,
  getTokenConfig,
  settlePayment,
  settlePaymentEIP3009,
  settlePaymentXLayerEIP7702,
  type ChainKey,
  type PayParams,
  type EIP3009PayParams,
  type XLayerEIP7702PayParams,
} from "@/app/lib/relayer";
import type { Hex, Address } from "viem";

/**
 * POST /api/relay
 *
 * 체인별 가스리스 USDC/USDT 릴레이 엔드포인트.
 *
 * ─────────────────────────────────────────────────────────────
 * 체인별 동작 방식:
 *   avax / bnb / eth  → EIP-7702 (Type 4 TX)
 *     클라이언트가 EIP-712 witnessSig + EIP-7702 authorization을 전달
 *     릴레이어가 Q402PaymentImplementation.pay() 호출
 *
 *   xlayer            → EIP-3009 (Standard TX)
 *     클라이언트가 USDC TransferWithAuthorization 서명 전달
 *     (witnessSig = EIP-3009 65-byte sig, eip3009Nonce = bytes32 nonce)
 *     릴레이어가 USDC.transferWithAuthorization() 직접 호출
 *     authorization 필드 불필요
 * ─────────────────────────────────────────────────────────────
 *
 * 공통 필드:
 * {
 *   apiKey:       "q402_live_xxx",
 *   chain:        "avax" | "bnb" | "eth" | "xlayer",
 *   token:        "USDC" | "USDT",
 *   from:         "0xPayer",
 *   to:           "0xRecipient",
 *   amount:       "50000",           // atomic units (string)
 *   deadline:     1234567890,        // unix timestamp (= validBefore for xlayer)
 *   paymentId:    "0x...",           // bytes32, optional (auto-generated if omitted)
 *   witnessSig:   "0x...",           // EIP-712 sig (non-xlayer) OR EIP-3009 sig (xlayer)
 * }
 *
 * EIP-7702 추가 필드 (avax/bnb/eth):
 * {
 *   authorization: { chainId, address, nonce, yParity, r, s }
 * }
 *
 * EIP-3009 추가 필드 (xlayer):
 * {
 *   eip3009Nonce: "0x...(bytes32)"
 * }
 */
export async function POST(req: NextRequest) {
  let body: {
    apiKey:       string;
    chain:        ChainKey;
    token:        "USDC" | "USDT";
    from:         string;
    to:           string;
    amount:       string;
    deadline:     number;
    paymentId?:   string;
    witnessSig:   string;
    // EIP-7702 (avax/bnb/eth)
    authorization?: {
      chainId:  number;
      address:  string;
      nonce:    number;
      yParity: number;
      r: string;
      s: string;
    };
    // EIP-3009 (xlayer fallback)
    eip3009Nonce?: string;
    // EIP-7702 XLayer (xlayer native, Q402PaymentImplementationXLayer)
    xlayerNonce?: string;   // random uint256 for TransferAuthorization replay protection
    facilitator?: string;   // relayer wallet address (must match msg.sender)
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    apiKey, chain, token, from, to, amount, deadline,
    paymentId, witnessSig, authorization, eip3009Nonce, xlayerNonce,
  } = body;

  // ── 1. 공통 필수 필드 검증 ──────────────────────────────────────────────────
  if (!apiKey || !chain || !token || !from || !to || !amount || !deadline || !witnessSig) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // ── 2. 체인별 추가 필드 검증 ────────────────────────────────────────────────
  const isXLayer = chain === "xlayer";
  // xlayer: EIP-7702 mode (preferred) or EIP-3009 fallback
  const isXLayerEIP7702 = isXLayer && !!authorization && !!xlayerNonce;
  const isXLayerEIP3009 = isXLayer && !!eip3009Nonce && !authorization;

  if (isXLayer && !isXLayerEIP7702 && !isXLayerEIP3009) {
    return NextResponse.json(
      { error: "xlayer requires either (authorization + xlayerNonce) for EIP-7702 mode, or eip3009Nonce for EIP-3009 mode" },
      { status: 400 }
    );
  }
  if (!isXLayer && !authorization) {
    return NextResponse.json(
      { error: "EIP-7702 chains (avax/bnb/eth) require authorization object" },
      { status: 400 }
    );
  }

  // ── 3. API Key 검증 ─────────────────────────────────────────────────────────
  const keyRecord = await getApiKeyRecord(apiKey);
  if (!keyRecord || !keyRecord.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  // ── 4. 체인 지원 확인 ───────────────────────────────────────────────────────
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer.`,
    }, { status: 400 });
  }

  // ── 5. Gas Tank 잔고 확인 ──────────────────────────────────────────────────
  const gasBalance   = await getGasBalance(keyRecord.address);
  const chainBalance = gasBalance[chain] ?? 0;
  if (chainBalance <= 0.0001) {
    return NextResponse.json({
      error: `Insufficient gas tank on ${chain}. Deposit ${chainCfg.token} to your gas tank.`,
    }, { status: 402 });
  }

  // ── 6. paymentId → bytes32 ─────────────────────────────────────────────────
  let paymentIdBytes32: Hex;
  if (paymentId && paymentId.startsWith("0x") && paymentId.length === 66) {
    paymentIdBytes32 = paymentId as Hex;
  } else if (paymentId) {
    paymentIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(paymentId)) as Hex;
  } else {
    paymentIdBytes32 = ethers.keccak256(
      ethers.toUtf8Bytes(`${from}-${to}-${amount}-${deadline}-${Date.now()}`)
    ) as Hex;
  }

  const tokenCfg = getTokenConfig(chain, token);
  let result;

  // ── 7a-1. X Layer EIP-7702 (Q402PaymentImplementationXLayer) ────────────────
  if (isXLayerEIP7702) {
    // Derive facilitator address from RELAYER_PRIVATE_KEY to enforce match
    const pkRaw = process.env.RELAYER_PRIVATE_KEY!;
    const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
    const relayerAddress = privateKeyToAccount(pk).address as Address;

    const xlayerParams: XLayerEIP7702PayParams = {
      owner:       from as Address,
      facilitator: relayerAddress,
      token:       tokenCfg.address as Address,
      recipient:   to as Address,
      amount:      BigInt(amount),
      nonce:       BigInt(xlayerNonce!),
      deadline:    BigInt(deadline),
      witnessSig:  witnessSig as Hex,
      authorization: {
        chainId: Number(authorization!.chainId),
        address: authorization!.address as Address,
        nonce:   Number(authorization!.nonce),
        yParity: authorization!.yParity,
        r:       authorization!.r as Hex,
        s:       authorization!.s as Hex,
      },
    };
    result = await settlePaymentXLayerEIP7702(xlayerParams);

  // ── 7a-2. X Layer EIP-3009 fallback (USDC.transferWithAuthorization) ────────
  } else if (isXLayerEIP3009) {
    const eip3009Params: EIP3009PayParams = {
      from,
      to,
      amount:      BigInt(amount),
      validAfter:  0n,
      validBefore: BigInt(deadline),
      nonce:       eip3009Nonce!,
      sig:         witnessSig,
      chainKey:    chain,
      token,
    };
    result = await settlePaymentEIP3009(eip3009Params);

  // ── 7b. EIP-7702 릴레이 (avax / bnb / eth) ────────────────────────────────
  } else {
    const payParams: PayParams = {
      owner:      from as Address,
      token:      tokenCfg.address as Address,
      amount:     BigInt(amount),
      to:         to as Address,
      deadline:   BigInt(deadline),
      paymentId:  paymentIdBytes32,
      witnessSig: witnessSig as Hex,
      authorization: {
        chainId:  Number(authorization!.chainId),
        address:  authorization!.address as Address,
        nonce:    Number(authorization!.nonce),
        yParity: authorization!.yParity,
        r:        authorization!.r as Hex,
        s:        authorization!.s as Hex,
      },
      chainKey: chain,
    };
    result = await settlePayment(payParams);
  }

  if (!result.success) {
    return NextResponse.json({ error: `Relay failed: ${result.error}` }, { status: 400 });
  }

  // ── 8. TX 기록 ─────────────────────────────────────────────────────────────
  const tokenAmount = parseFloat(ethers.formatUnits(amount, tokenCfg.decimals));

  await recordRelayedTx(keyRecord.address, {
    apiKey,
    address:      keyRecord.address,
    chain,
    fromUser:     from,
    toUser:       to,
    tokenAmount,
    tokenSymbol:  token,
    gasCostNative: 0,
    relayTxHash:  result.txHash ?? "",
    relayedAt:    new Date().toISOString(),
  });

  return NextResponse.json({
    success:     true,
    txHash:      result.txHash,
    blockNumber: result.blockNumber?.toString(),
    tokenAmount,
    token,
    chain,
    method:      isXLayerEIP7702 ? "eip7702_xlayer" : isXLayerEIP3009 ? "eip3009" : "eip7702",
  });
}
