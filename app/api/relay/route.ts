import { NextRequest, NextResponse, after } from "next/server";
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
import { rateLimit, refundRateLimit, getClientIP } from "@/app/lib/ratelimit";
import { validateWebhookUrl } from "@/app/lib/webhook-validator";
import { safeWebhookFetch } from "@/app/lib/safe-fetch";
import { loadRelayerKey } from "@/app/lib/relayer-key";
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
    nonce, witnessSig, authorization, eip3009Nonce, xlayerNonce, stableNonce,
  } = body;

  // Reject legacy paymentId field — SDK must send `nonce` (uint256 string).
  if ((body as { paymentId?: unknown }).paymentId !== undefined) {
    return NextResponse.json(
      { error: "paymentId is deprecated — upgrade SDK (v1.3+) to use nonce" },
      { status: 400 }
    );
  }

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
  // avax/bnb/eth also require `nonce` — it's part of the signed witness, so a
  // server-synthesized fallback would never match the caller's signature. Fail
  // fast with a clear 400 instead of letting the onchain verify path reject it.
  if (!isXLayer && !isStable && !nonce) {
    return NextResponse.json(
      { error: "nonce is required for avax/bnb/eth (uint256 string, must match the signed witness)" },
      { status: 400 }
    );
  }

  // ── 2a. EIP-3009 fallback on X Layer is USDC-only ────────────────────────────
  // The USDC_EIP3009_ABI in relayer.ts targets X Layer USDC (9-param v,r,s form).
  // X Layer USDT uses a different authorization surface — don't pretend to support it.
  if (isXLayerEIP3009 && token !== "USDC") {
    return NextResponse.json(
      { error: "EIP-3009 fallback on X Layer supports USDC only. Use EIP-7702 (authorization + xlayerNonce) for USDT." },
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
  // 플랜별 일일 최대. Exhaustive — unknown/typo'd plan names fall through to
  // UNKNOWN_PLAN_CAP rather than silently skipping the cap (prior behavior let
  // an unknown plan burn the Gas Tank). All plan names here must match
  // PLAN_QUOTA in app/lib/db.ts.
  const DAILY_CAP: Record<string, number> = {
    starter:           50,
    basic:            100,
    growth:         1_000,
    pro:            1_000,
    scale:         10_000,
    business:      10_000,
    enterprise:   100_000,
    enterprise_flex: 500_000,
  };
  const UNKNOWN_PLAN_CAP = 1_000;
  const planKey  = (keyRecord.plan ?? "").toLowerCase();
  const knownPlan = Object.prototype.hasOwnProperty.call(DAILY_CAP, planKey);
  const dailyCap  = knownPlan ? DAILY_CAP[planKey] : UNKNOWN_PLAN_CAP;
  if (!knownPlan) {
    console.warn(`[relay] unknown plan "${keyRecord.plan}" addr=${keyRecord.address} — applying default cap ${UNKNOWN_PLAN_CAP}/day`);
  }
  const dailyCapKey      = `relay:daily:${keyRecord.address}`;
  let   dailyCapCharged  = false;
  if (!isSandbox) {
    // failOpen=false — daily cap is the primary abuse guard on paid relays.
    // If KV is down we'd rather return 429 than silently let a single key burn
    // through the Gas Tank. Recovery = retry once KV heals.
    const withinDailyCap = await rateLimit(dailyCapKey, "daily", dailyCap, 86400, false);
    if (!withinDailyCap) {
      return NextResponse.json({
        error: `Daily relay cap reached (${dailyCap}/day for ${keyRecord.plan} plan). Resets at midnight UTC.`,
      }, { status: 429 });
    }
    dailyCapCharged = true;
  }

  // ── 5. 체인 지원 확인 ──────────────────────────────────────────────────────
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer, stable.`,
    }, { status: 400 });
  }

  // ── 5a. authorization 강제 잠금 — 공식 impl contract + chainId 만 허용 ─────
  // 클라이언트가 잘못된 delegation 주소나 chainId를 보내면 on-chain revert로
  // 이어져 결국 환불되지만, "어느 배포 컨트랙트와 계약하는지"는 서버가
  // 명시적으로 잠가야 기관 관점에서 증빙 가능한 결합이 된다.
  // contracts.manifest.json의 chains[chain].implContract와 1:1 대응.
  if (authorization) {
    if (Number(authorization.chainId) !== chainCfg.chainId) {
      return NextResponse.json({
        error: `authorization.chainId ${authorization.chainId} does not match ${chain} (expected ${chainCfg.chainId})`,
      }, { status: 400 });
    }
    const expectedImpl = chainCfg.implContract.toLowerCase();
    const actualImpl   = String(authorization.address ?? "").toLowerCase();
    if (!ETH_ADDR.test(String(authorization.address ?? "")) || actualImpl !== expectedImpl) {
      return NextResponse.json({
        error: `authorization.address must be the official Q402 ${chain} implementation contract`,
      }, { status: 400 });
    }
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
  // xlayer/stable carry their own nonce in xlayerNonce/stableNonce and never
  // consume this value. Section 2 rejects missing `nonce` on avax/bnb/eth with
  // a 400, so if we get here with a required-nonce chain, `nonce` is present.
  const paymentNonce: bigint =
    (!isXLayer && !isStable) ? BigInt(nonce!) : 0n;

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
      // Refund daily cap — no relay will happen, so the slot wasn't actually used.
      if (dailyCapCharged) {
        refundRateLimit(dailyCapKey, "daily", 86400).catch(e =>
          console.error("[relay] daily cap refund failed after credit underflow:", e)
        );
      }
      return NextResponse.json({
        error: "No TX credits remaining. Purchase additional credits to continue.",
      }, { status: 429 });
    }
    creditReserved = true;
    creditRemaining = dec.remaining;
  }

  // ── 8. 릴레이 실행 (sandbox → mock, live → on-chain) ─────────────────────
  // Live mode: derive + verify the relayer key matches RELAYER_ADDRESS in
  // wallets.ts. If env was rotated to a different wallet, fail closed (503)
  // rather than silently signing from an unmonitored address.
  let relayerAddress: Address = "0x" as Address;
  if (!isSandbox) {
    const key = loadRelayerKey();
    if (!key.ok) {
      return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
    }
    relayerAddress = key.address as Address;
  }

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
    const stableParams: PayParams = {
      owner:       from as Address,
      facilitator: relayerAddress as Address,
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
    const xlayerParams: XLayerEIP7702PayParams = {
      owner:       from as Address,
      facilitator: relayerAddress as Address,
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
    const payParams: PayParams = {
      owner:       from as Address,
      facilitator: relayerAddress as Address,
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
    // Relay failed — refund quota credit so the user isn't charged for a failed attempt
    if (creditReserved) {
      refundCredit(keyRecord.address).catch(e =>
        console.error("[relay] credit refund failed after relay failure:", e)
      );
    }
    // Refund daily cap — only successful relays should count against the daily limit
    if (dailyCapCharged) {
      refundRateLimit(dailyCapKey, "daily", 86400).catch(e =>
        console.error("[relay] daily cap refund failed after relay failure:", e)
      );
    }
    // Don't leak internal RPC errors or contract revert reasons to callers
    console.error(`[relay] failed chain=${chain} from=${from}: ${result.error}`);
    return NextResponse.json({ error: "Relay failed. Check your signature and parameters." }, { status: 400 });
  }

  // ── 9. 가스비 — relayer.ts가 receipt에서 직접 계산해서 반환 ───────────────
  const gasCostNative = result.gasCostNative ?? 0;

  // ── 10. TX 기록 (실제 가스비 포함) ───────────────────────────────────────
  const tokenAmount = ethers.formatUnits(amount, tokenCfg.decimals);

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
    // SSRF guard — shared ruleset with /api/webhook save + test paths.
    // Re-check at dispatch time so legacy rows stored under older rules
    // can't be used to pivot into internal networks.
    const webhookSafe = validateWebhookUrl(webhookCfg.url) === null;

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

      // Retry up to 3 times with exponential backoff.
      // Scheduled via `after()` so Vercel keeps the function alive past the
      // response — `setTimeout`/fire-and-forget isn't guaranteed to survive the
      // serverless shutdown, which was silently dropping retries 2 and 3.
      // Delivery result is recorded in KV for visibility.
      const dispatchWebhook = async () => {
        const DELAYS = [0, 1_000, 3_000];
        let lastStatus: number | undefined;
        let lastError:  string | undefined;
        for (let i = 0; i < DELAYS.length; i++) {
          if (DELAYS[i] > 0) await new Promise(r => setTimeout(r, DELAYS[i]));
          const res = await safeWebhookFetch(webhookUrl, {
            method:  "POST",
            headers: {
              "Content-Type":     "application/json",
              "X-Q402-Signature": `sha256=${hmac}`,
              "X-Q402-Event":     "relay.success",
              ...(i > 0 ? { "X-Q402-Retry": String(i) } : {}),
            },
            body:   payload,
            timeoutMs: 8_000,
          });
          lastStatus = res.status;
          if (res.ok) {
            recordWebhookDelivery(webhookAddr, {
              timestamp: new Date().toISOString(), event: "relay.success",
              ok: true, statusCode: res.status, attempt: i + 1,
            }).catch(() => {});
            return;
          }
          lastError = res.error;
        }
        // All attempts failed — record for visibility
        recordWebhookDelivery(webhookAddr, {
          timestamp: new Date().toISOString(), event: "relay.success",
          ok: false, statusCode: lastStatus, error: lastError, attempt: DELAYS.length,
        }).catch(() => {});
      };
      after(dispatchWebhook);
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
