import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  getApiKeyRecord,
  getGasBalance,
  recordRelayedTx,
  getSubscription,
  setSubscription,
  getWebhookConfig,
  getQuotaCredits,
  initQuotaIfNeeded,
  decrementCredit,
  refundCredit,
  recordWebhookDelivery,
} from "@/app/lib/db";
import { createHmac, randomBytes } from "crypto";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
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

// Valid Ethereum address pattern
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;


export async function POST(req: NextRequest) {
  let body: {
    apiKey:       string;
    chain:        ChainKey;
    token:        "USDC" | "USDT";
    from:         string;
    to:           string;
    amount:       string;
    deadline:     number;
    nonce?:       string;  // uint256 nonce for avax/bnb/eth (v1.2 contract)
    paymentId?:   string;  // legacy bytes32 (fallback if nonce absent)
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
    xlayerNonce?:  string;
    stableNonce?:  string;
    facilitator?:  string;
  };

  // ── 0. Rate limit: 60 relay calls / 60 s per IP (fail-closed — KV down = block) ──
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "relay", 60, 60, false))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    apiKey, chain, token, from, to, amount, deadline,
    nonce, paymentId, witnessSig, authorization, eip3009Nonce, xlayerNonce, stableNonce,
  } = body;

  // ── 1. 공통 필수 필드 검증 ────────────────────────────────────────────────
  if (!apiKey || !chain || !token || !from || !to || !amount || !deadline || !witnessSig) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // ── 1a. 주소 형식 검증 ────────────────────────────────────────────────────
  if (!ETH_ADDR.test(from) || !ETH_ADDR.test(to)) {
    return NextResponse.json({ error: "Invalid address format" }, { status: 400 });
  }

  // ── 1b. amount 검증 (양의 정수 bigint) ────────────────────────────────────
  let amountBigInt: bigint;
  try {
    amountBigInt = BigInt(amount);
    if (amountBigInt <= 0n) throw new Error("zero");
  } catch {
    return NextResponse.json({ error: "amount must be a positive integer string" }, { status: 400 });
  }

  // ── 1c. deadline 검증 (미래 타임스탬프) ──────────────────────────────────
  const deadlineSec = Number(deadline);
  if (!Number.isFinite(deadlineSec) || deadlineSec * 1000 <= Date.now()) {
    return NextResponse.json({ error: "deadline has passed or is invalid" }, { status: 400 });
  }

  // ── 2. 체인별 추가 필드 검증 ──────────────────────────────────────────────
  const isXLayer      = chain === "xlayer";
  const isStable      = chain === "stable";
  const isXLayerEIP7702 = isXLayer && !!authorization && !!xlayerNonce;
  const isXLayerEIP3009 = isXLayer && !!eip3009Nonce && !authorization;
  const isStableEIP7702 = isStable && !!authorization && !!stableNonce;

  if (isXLayer && !isXLayerEIP7702 && !isXLayerEIP3009) {
    return NextResponse.json(
      { error: "xlayer requires either (authorization + xlayerNonce) for EIP-7702 mode, or eip3009Nonce for EIP-3009 mode" },
      { status: 400 }
    );
  }
  if (isStable && !isStableEIP7702) {
    return NextResponse.json(
      { error: "stable requires authorization + stableNonce for EIP-7702 mode" },
      { status: 400 }
    );
  }
  if (!isXLayer && !isStable && !authorization) {
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

  // ── 3a. Sandbox key detection ────────────────────────────────────────────
  // Only trust the DB field — never the key prefix (client-facing, spoofable)
  const isSandbox = keyRecord.isSandbox === true;

  // ── 3b. Per-API-key rate limit (30 relay calls / 60s per key, fail-closed) ─
  if (!(await rateLimit(apiKey, "relay-key", 30, 60, false))) {
    return NextResponse.json({ error: "Too many requests for this API key" }, { status: 429 });
  }

  // ── 4. 현재 구독의 키와 일치하는지 + 만료 여부 확인 ────────────────────
  const subscription = await getSubscription(keyRecord.address);
  if (subscription) {
    // Allow both the live key and the sandbox key
    const isCurrentKey = subscription.apiKey === apiKey || subscription.sandboxApiKey === apiKey;
    if (!isCurrentKey) {
      return NextResponse.json({ error: "API key has been rotated. Please use your current key." }, { status: 401 });
    }
    // Expiry check: only for paid accounts (amountUSD > 0) with a real paidAt timestamp.
    // Provisioned free accounts have paidAt="" — skip to avoid false "expired" errors.
    // Sandbox requests also bypass expiry (they don't consume the paid quota).
    const isPaidAccount = (subscription.amountUSD ?? 0) > 0 && !!subscription.paidAt;
    if (!isSandbox && isPaidAccount) {
      const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() >= expiresAt) {
        return NextResponse.json({ error: "Subscription expired. Please renew to continue." }, { status: 403 });
      }
    }
  }

  // ── 4a. TX 크레딧 빠른 사전 체크 (stale OK — 실제 게이트는 원자 차감) ──────
  if (!isSandbox) {
    const quickCredits = await getQuotaCredits(keyRecord.address);
    if (quickCredits <= 0) {
      return NextResponse.json({
        error: "No TX credits remaining. Purchase additional credits to continue.",
      }, { status: 429 });
    }
  }

  // ── 4b. 일일 burst 상한 (단일 고객이 Gas Tank 독점 소진 방지) ──────────────
  // 플랜별 일일 최대: starter=50, growth=1000, scale=10000, others=무제한
  const DAILY_CAP: Record<string, number> = {
    starter: 50, basic: 100, growth: 1_000, pro: 1_000,
    scale: 10_000, business: 10_000,
  };
  const dailyCap = DAILY_CAP[keyRecord.plan?.toLowerCase()];
  if (dailyCap !== undefined && !isSandbox) {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const { rateLimit: rl } = await import("@/app/lib/ratelimit");
    const withinDailyCap = await rl(`relay:daily:${keyRecord.address}`, "daily", dailyCap, 86400);
    if (!withinDailyCap) {
      return NextResponse.json({
        error: `Daily relay cap reached (${dailyCap}/day for ${keyRecord.plan} plan). Resets at midnight UTC.`,
      }, { status: 429 });
    }
  }

  // ── 5. 체인 지원 확인 ──────────────────────────────────────────────────────
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer, stable.`,
    }, { status: 400 });
  }

  // ── 6. Gas Tank 잔고 확인 (sandbox는 스킵) ───────────────────────────────
  if (!isSandbox) {
    const gasBalance   = await getGasBalance(keyRecord.address);
    const chainBalance = gasBalance[chain] ?? 0;
    if (chainBalance <= 0.0001) {
      return NextResponse.json({
        error: `Insufficient gas tank on ${chain}. Deposit native tokens to your gas tank.`,
      }, { status: 402 });
    }
  }

  // ── 7. nonce (uint256) for avax/bnb/eth transferWithAuthorization ─────────
  // SDK sends `nonce` as a uint256 string. Legacy `paymentId` as fallback.
  let paymentNonce: bigint;
  if (nonce) {
    paymentNonce = BigInt(nonce);
  } else if (paymentId) {
    // Derive uint256 nonce from paymentId hash (truncate bytes32 to uint256)
    const hash = paymentId.startsWith("0x") && paymentId.length === 66
      ? paymentId
      : ethers.keccak256(ethers.toUtf8Bytes(paymentId));
    paymentNonce = BigInt(hash);
  } else {
    // Auto-generate from tx context
    paymentNonce = BigInt(ethers.keccak256(
      ethers.toUtf8Bytes(`${from}-${to}-${amount}-${deadline}-${Date.now()}`)
    ));
  }

  const tokenCfg = getTokenConfig(chain, token);
  let result: import("@/app/lib/relayer").SettleResult = { success: false, error: "No relay path matched" };

  // ── 7b. 크레딧 원자 예약 (relay 직전 — 경쟁 안전) ────────────────────────
  // initQuotaIfNeeded: 첫 릴레이 시 기존 계정을 quota 키로 lazy-migrate (SET NX)
  // decrementCredit:   Redis DECRBY — 결과 < 0이면 즉시 보상 후 차단
  let creditReserved = false;
  let creditRemaining = 0;
  if (!isSandbox) {
    await initQuotaIfNeeded(keyRecord.address, subscription?.quotaBonus ?? 0);
    const dec = await decrementCredit(keyRecord.address);
    if (!dec.ok) {
      return NextResponse.json({
        error: "No TX credits remaining. Purchase additional credits to continue.",
      }, { status: 429 });
    }
    creditReserved = true;
    creditRemaining = dec.remaining;
  }

  // ── 8. 릴레이 실행 (sandbox → mock, live → on-chain) ─────────────────────
  if (isSandbox) {
    // Sandbox: return a mock result without hitting the chain
    await new Promise(r => setTimeout(r, 400)); // simulate latency
    result = {
      success: true,
      txHash:         `0x${randomBytes(32).toString("hex")}`,
      blockNumber:    BigInt(Math.floor(Math.random() * 50_000_000) + 1_000_000),
      gasCostNative:  0.00042,
    };
  } else if (isStableEIP7702) {
    const pkRaw = process.env.RELAYER_PRIVATE_KEY!;
    const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
    const relayerAddress = privateKeyToAccount(pk).address as Address;

    const stableParams: PayParams = {
      owner:       from as Address,
      facilitator: relayerAddress,
      token:       tokenCfg.address as Address,
      amount:      BigInt(amount),
      to:          to as Address,
      nonce:       BigInt(stableNonce!),
      deadline:    BigInt(deadline),
      witnessSig:  witnessSig as Hex,
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
    result = await settlePayment(stableParams);

  } else if (isXLayerEIP7702) {
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

  } else if (!isSandbox) {
    // avax / bnb / eth — EIP-7702 via Q402PaymentImplementation.transferWithAuthorization()
    const pkRaw2 = process.env.RELAYER_PRIVATE_KEY!;
    const pk2 = (pkRaw2.startsWith("0x") ? pkRaw2 : `0x${pkRaw2}`) as Hex;
    const relayerAddress2 = privateKeyToAccount(pk2).address as Address;

    const payParams: PayParams = {
      owner:       from as Address,
      facilitator: relayerAddress2,
      token:       tokenCfg.address as Address,
      amount:      BigInt(amount),
      to:          to as Address,
      nonce:       paymentNonce,
      deadline:    BigInt(deadline),
      witnessSig:  witnessSig as Hex,
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
    // Relay failed — refund the credit we reserved so the user isn't double-charged
    if (creditReserved) {
      refundCredit(keyRecord.address).catch(e =>
        console.error("[relay] credit refund failed after relay failure:", e)
      );
    }
    // Don't leak internal RPC errors or contract revert reasons to callers
    console.error(`[relay] failed chain=${chain} from=${from}: ${result.error}`);
    return NextResponse.json({ error: "Relay failed. Check your signature and parameters." }, { status: 400 });
  }

  // ── 9. 가스비 — relayer.ts가 receipt에서 직접 계산해서 반환 ───────────────
  const gasCostNative = result.gasCostNative ?? 0;

  // ── 10. TX 기록 (실제 가스비 포함) ───────────────────────────────────────
  const tokenAmount = parseFloat(ethers.formatUnits(amount, tokenCfg.decimals));

  const relayedAt = new Date().toISOString();
  // Fire-and-forget — on-chain TX already succeeded; don't block response on KV write
  recordRelayedTx(keyRecord.address, {
    apiKey,
    address:      keyRecord.address,
    chain,
    fromUser:     from,
    toUser:       to,
    tokenAmount,
    tokenSymbol:  token,
    gasCostNative,
    relayTxHash:  result.txHash ?? "",
    relayedAt,
  }).catch(e => console.error("[relay] TX record failed (non-fatal):", e));

  // Sync subscription.quotaBonus for dashboard display (fire-and-forget, non-critical).
  // The authoritative counter is quota:{addr} (atomically decremented above).
  if (subscription && !isSandbox && creditReserved) {
    setSubscription(keyRecord.address, {
      ...subscription,
      quotaBonus: creditRemaining,
    }).catch(e => console.error("[relay] quotaBonus display sync failed (non-fatal):", e));
  }

  // ── 11. Webhook 발동 (non-blocking, sandbox 포함) ─────────────────────────
  const webhookCfg = await getWebhookConfig(keyRecord.address);
  if (webhookCfg?.active && webhookCfg.url) {
    // SSRF guard (same ruleset as /api/webhook registration)
    let webhookSafe = false;
    try {
      const wh = new URL(webhookCfg.url);
      const h = wh.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      webhookSafe = !(
        /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h) ||
        /^(::1$|::ffff:|fe80:|fc00:|fd[0-9a-f]{2}:)/i.test(h) ||
        /^(metadata\.google\.internal|169\.254\.169\.254)/.test(h) ||
        /^0[0-7]+\./.test(h)
      );
    } catch { /* invalid URL — skip */ }

    if (webhookSafe) {
      const payload = JSON.stringify({
        event:        "relay.success",
        sandbox:      isSandbox,
        txHash:       result.txHash,
        chain,
        from,
        to,
        amount:       tokenAmount,
        token,
        gasCostNative,
        timestamp:    relayedAt,
      });
      const hmac = createHmac("sha256", webhookCfg.secret).update(payload).digest("hex");
      const webhookUrl     = webhookCfg.url;
      const webhookAddr    = keyRecord.address;

      // Retry up to 3 times with exponential backoff (fire-and-forget after response).
      // Delivery result is recorded in KV for visibility.
      const dispatchWebhook = async () => {
        const DELAYS = [0, 1_000, 3_000];
        let lastStatus: number | undefined;
        let lastError:  string | undefined;
        for (let i = 0; i < DELAYS.length; i++) {
          if (DELAYS[i] > 0) await new Promise(r => setTimeout(r, DELAYS[i]));
          try {
            const res = await fetch(webhookUrl, {
              method:  "POST",
              headers: {
                "Content-Type":     "application/json",
                "X-Q402-Signature": `sha256=${hmac}`,
                "X-Q402-Event":     "relay.success",
                ...(i > 0 ? { "X-Q402-Retry": String(i) } : {}),
              },
              body:   payload,
              signal: AbortSignal.timeout(8_000),
            });
            lastStatus = res.status;
            if (res.ok) {
              recordWebhookDelivery(webhookAddr, {
                timestamp: new Date().toISOString(), event: "relay.success",
                ok: true, statusCode: res.status, attempt: i + 1,
              }).catch(() => {});
              return;
            }
            lastError = `HTTP ${res.status}`;
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
          }
        }
        // All attempts failed — record for visibility
        recordWebhookDelivery(webhookAddr, {
          timestamp: new Date().toISOString(), event: "relay.success",
          ok: false, statusCode: lastStatus, error: lastError, attempt: DELAYS.length,
        }).catch(() => {});
      };
      dispatchWebhook().catch(() => {});
    } // end webhookSafe
  }

  return NextResponse.json({
    success:     true,
    txHash:      result.txHash,
    blockNumber: result.blockNumber?.toString(),
    tokenAmount,
    token,
    chain,
    gasCostNative,
    method:      isStableEIP7702 ? "eip7702_stable" : isXLayerEIP7702 ? "eip7702_xlayer" : isXLayerEIP3009 ? "eip3009" : "eip7702",
  });
}
