import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getApiKeyRecord, getGasBalance, recordRelayedTx, getSubscription } from "@/app/lib/db";
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

const CHAIN_RPC: Record<string, string> = {
  bnb:    "https://bsc-dataseed1.binance.org/",
  eth:    "https://ethereum.publicnode.com",
  avax:   "https://api.avax.network/ext/bc/C/rpc",
  xlayer: "https://rpc.xlayer.tech",
};

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
    authorization?: {
      chainId:  number;
      address:  string;
      nonce:    number;
      yParity: number;
      r: string;
      s: string;
    };
    eip3009Nonce?: string;
    xlayerNonce?: string;
    facilitator?: string;
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

  // ── 1. 공통 필수 필드 검증 ────────────────────────────────────────────────
  if (!apiKey || !chain || !token || !from || !to || !amount || !deadline || !witnessSig) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // ── 2. 체인별 추가 필드 검증 ──────────────────────────────────────────────
  const isXLayer = chain === "xlayer";
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

  // ── 3. API Key 검증 ───────────────────────────────────────────────────────
  const keyRecord = await getApiKeyRecord(apiKey);
  if (!keyRecord || !keyRecord.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  // ── 4. 현재 구독의 키와 일치하는지 + 만료 여부 확인 ────────────────────
  const subscription = await getSubscription(keyRecord.address);
  if (subscription) {
    if (subscription.apiKey !== apiKey) {
      return NextResponse.json({ error: "API key has been rotated. Please use your current key." }, { status: 401 });
    }
    const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    if (new Date() >= expiresAt) {
      return NextResponse.json({ error: "Subscription expired. Please renew to continue." }, { status: 403 });
    }
  }

  // ── 5. 체인 지원 확인 ──────────────────────────────────────────────────────
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer.`,
    }, { status: 400 });
  }

  // ── 6. Gas Tank 잔고 확인 ─────────────────────────────────────────────────
  const gasBalance   = await getGasBalance(keyRecord.address);
  const chainBalance = gasBalance[chain] ?? 0;
  if (chainBalance <= 0.0001) {
    return NextResponse.json({
      error: `Insufficient gas tank on ${chain}. Deposit native tokens to your gas tank.`,
    }, { status: 402 });
  }

  // ── 7. paymentId → bytes32 ────────────────────────────────────────────────
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

  // ── 8. 릴레이 실행 ────────────────────────────────────────────────────────
  if (isXLayerEIP7702) {
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

  // ── 9. 실제 가스비 계산 (TX 영수증에서 추출) ──────────────────────────────
  let gasCostNative = 0;
  if (result.txHash) {
    try {
      const provider = new ethers.JsonRpcProvider(CHAIN_RPC[chain]);
      const receipt = await provider.getTransactionReceipt(result.txHash);
      if (receipt) {
        const gasUsed = receipt.gasUsed;
        const gasPrice = receipt.gasPrice ?? 0n;
        gasCostNative = parseFloat(ethers.formatEther(gasUsed * gasPrice));
      }
    } catch {
      // RPC 오류 시 0으로 유지
    }
  }

  // ── 10. TX 기록 (실제 가스비 포함) ───────────────────────────────────────
  const tokenAmount = parseFloat(ethers.formatUnits(amount, tokenCfg.decimals));

  await recordRelayedTx(keyRecord.address, {
    apiKey,
    address:      keyRecord.address,
    chain,
    fromUser:     from,
    toUser:       to,
    tokenAmount,
    tokenSymbol:  token,
    gasCostNative,
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
    gasCostNative,
    method:      isXLayerEIP7702 ? "eip7702_xlayer" : isXLayerEIP3009 ? "eip3009" : "eip7702",
  });
}
