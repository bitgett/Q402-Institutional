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
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
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

// Minimum gas-tank balance (in native token) required to relay one TX. Calibrated
// per-chain to roughly $0.05–$0.10 USD-equivalent so the floor is consistent
// across chains. The previous unified `0.0001` was BNB-shaped: on ETH it gated
// at ~$0.30 (over-strict, blocked deposits that could pay), on AVAX/X Layer it
// was effectively $0.003 (too lax — relay could attempt and fail with OOG).
const MIN_GAS_BALANCE: Record<ChainKey, number> = {
  bnb:    0.0001,    // ~$0.06 at $600/BNB
  eth:    0.00003,   // ~$0.10 at $3500/ETH
  avax:   0.003,     // ~$0.09 at $30/AVAX
  xlayer: 0.002,     // ~$0.10 at $50/OKB
  stable: 0.05,      // $0.05 (USDT0 is $1-pegged)
  mantle: 0.2,       // ~$0.10 at $0.50/MNT (Mantle L2, low gas)
  injective: 0.005,  // ~$0.10 at $20/INJ (Injective EVM uses Cosmos fee model — ~0.1 INJ per deploy, far less per relay)
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
    nonce?:       string;  // uint256 nonce for avax/bnb/eth/mantle/injective (v1.2 contract)
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

  // ── 1. Required field validation (all chains) ────────────────────────────
  if (!apiKey || !chain || !token || !from || !to || !amount || !deadline || !witnessSig) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // ── 1aa. Per-chain token policy (server-side allowlist) ──────────────────
  // SDK rejects unsupported tokens at pay() time, but a direct API caller
  // could still try chain="injective" + token="USDC". Mirror the SDK's
  // supportedTokens guard here so the server is the source of truth and
  // the asymmetric defense (SDK strict, server tolerant) is closed.
  // For Injective, native USDC via Circle CCTP is announced for Q2 2026 —
  // until then USDT is the only token Q402 settles on Injective EVM.
  const CHAIN_TOKEN_ALLOWLIST: Partial<Record<ChainKey, ReadonlyArray<"USDC" | "USDT">>> = {
    injective: ["USDT"],
  };
  const allowedTokens = CHAIN_TOKEN_ALLOWLIST[chain];
  if (allowedTokens && !allowedTokens.includes(token)) {
    return NextResponse.json(
      {
        error:
          chain === "injective" && token === "USDC"
            ? "USDC is not yet supported on Injective. Native USDC via Circle CCTP is announced for Q2 2026; until then use USDT on Injective."
            : `Token "${token}" is not supported on chain "${chain}". Supported: ${allowedTokens.join(", ")}.`,
        code: "TOKEN_NOT_SUPPORTED_ON_CHAIN",
      },
      { status: 400 }
    );
  }

  // ── 1a. Address format validation ────────────────────────────────────────
  if (!ETH_ADDR.test(from) || !ETH_ADDR.test(to)) {
    return NextResponse.json({ error: "Invalid address format" }, { status: 400 });
  }

  // ── 1b. amount validation (positive integer bigint) ──────────────────────
  let amountBigInt: bigint;
  try {
    amountBigInt = BigInt(amount);
    if (amountBigInt <= 0n) throw new Error("zero");
  } catch {
    return NextResponse.json({ error: "amount must be a positive integer string" }, { status: 400 });
  }

  // ── 1c. deadline validation (must be a future timestamp) ─────────────────
  const deadlineSec = Number(deadline);
  if (!Number.isFinite(deadlineSec) || deadlineSec * 1000 <= Date.now()) {
    return NextResponse.json({ error: "deadline has passed or is invalid" }, { status: 400 });
  }

  // ── 2. Chain-specific field validation ────────────────────────────────────
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
      { error: "EIP-7702 chains (avax/bnb/eth/mantle/injective) require authorization object" },
      { status: 400 }
    );
  }
  // avax/bnb/eth/mantle/injective also require `nonce` — it's part of the signed witness, so a
  // server-synthesized fallback would never match the caller's signature. Fail
  // fast with a clear 400 instead of letting the onchain verify path reject it.
  if (!isXLayer && !isStable && !nonce) {
    return NextResponse.json(
      { error: "nonce is required for avax/bnb/eth/mantle/injective (uint256 string, must match the signed witness)" },
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

  // ── 2b. Parse nonce-like fields up front (Q402-SEC-001 follow-up) ────────────
  // BigInt() throws on malformed input. If we let that throw later — after
  // section 7c's decrementCredit() — a malformed nonce burns a credit slot
  // without a successful relay. Parse here, return 400 on garbage, so the
  // entitlement-ordering invariant ("no quota burn before commit") holds for
  // every required nonce field on every chain.
  let parsedPaymentNonce: bigint = 0n;
  let parsedXLayerNonce:  bigint = 0n;
  let parsedStableNonce:  bigint = 0n;
  try {
    if (!isXLayer && !isStable) parsedPaymentNonce = BigInt(nonce!);
    if (isXLayerEIP7702)        parsedXLayerNonce  = BigInt(xlayerNonce!);
    if (isStableEIP7702)        parsedStableNonce  = BigInt(stableNonce!);
  } catch {
    return NextResponse.json(
      { error: "nonce/xlayerNonce/stableNonce must be a valid uint256 string (decimal or 0x-hex)" },
      { status: 400 }
    );
  }
  // EIP-3009 nonce is a bytes32 hex string, not a BigInt — validate shape only.
  if (isXLayerEIP3009 && !/^0x[0-9a-fA-F]{64}$/.test(eip3009Nonce!)) {
    return NextResponse.json(
      { error: "eip3009Nonce must be 0x-prefixed bytes32 hex" },
      { status: 400 }
    );
  }

  // ── 3. API Key validation ────────────────────────────────────────────────
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

  // ── 4. Key matches current subscription + not expired ────────────────────
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

  // ── 4a. TX credit quick pre-check (stale OK — real gate is atomic decrement) ──
  if (!isSandbox) {
    const quickCredits = await getQuotaCredits(keyRecord.address);
    if (quickCredits <= 0) {
      return NextResponse.json({
        error: "No TX credits remaining. Purchase additional credits to continue.",
      }, { status: 429 });
    }
  }

  // ── 5. Supported-chain check ──────────────────────────────────────────────
  // Q402-SEC-001: moved ahead of the credit decrement so an unsupported-chain
  // request no longer burns a quota slot.
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer, stable, mantle, injective.`,
    }, { status: 400 });
  }

  // ── 5a. authorization lock — only official impl contract + chainId allowed ─
  // If a client sends a wrong delegation address or chainId it would revert
  // on-chain and refund, but "which deployed contract this request binds to"
  // has to be explicitly pinned by the server for institutional verifiability.
  // This mirrors contracts.manifest.json's chains[chain].implContract 1:1.
  // Q402-SEC-001: also moved before the credit decrement.
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

  // ── 6. Gas Tank balance check (sandbox skips this) ───────────────────────
  if (!isSandbox) {
    const gasBalance   = await getGasBalance(keyRecord.address);
    const chainBalance = gasBalance[chain] ?? 0;
    if (chainBalance <= MIN_GAS_BALANCE[chain]) {
      return NextResponse.json({
        error: `Insufficient gas tank on ${chain}. Deposit native tokens to your gas tank.`,
      }, { status: 402 });
    }
  }

  // ── 6a. Relayer key readiness (live only) ────────────────────────────────
  // Q402-SEC-001: verify the relay infrastructure is actually usable BEFORE
  // decrementing credits. Previously loadRelayerKey() ran after decrementCredit(),
  // so a misconfigured RELAYER_PRIVATE_KEY would silently drain every caller's
  // quota on 503 return.
  let relayerAddress: Address = "0x" as Address;
  if (!isSandbox) {
    const key = loadRelayerKey();
    if (!key.ok) {
      return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
    }
    relayerAddress = key.address as Address;
  }

  // ── 7b. nonce (uint256) for avax/bnb/eth/mantle/injective transferWithAuthorization ─────────
  // Parsed up front in section 2b so a malformed value can't escape past the
  // credit reservation in section 7c.
  const paymentNonce: bigint = parsedPaymentNonce;

  const tokenCfg = getTokenConfig(chain, token);
  let result: import("@/app/lib/relayer").SettleResult = { success: false, error: "No relay path matched" };

  // ── 7c. Atomic credit reservation (just before relay — race-safe) ────────
  // initQuotaIfNeeded: lazy-migrates legacy accounts to the quota key on first relay (SET NX)
  // decrementCredit:   Redis DECRBY — if result < 0, refund immediately and block
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

  // ── 8. Execute relay (sandbox → mock, live → on-chain) ───────────────────
  // Relayer address was resolved in section 6a; `relayerAddress` is in scope.

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
      nonce:       parsedStableNonce,
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
      nonce:       parsedXLayerNonce,
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
    // Don't leak internal RPC errors or contract revert reasons to callers
    console.error(`[relay] failed chain=${chain} from=${from}: ${result.error}`);
    return NextResponse.json({ error: "Relay failed. Check your signature and parameters." }, { status: 400 });
  }

  // ── 9. Gas cost — computed directly from the receipt by relayer.ts ───────
  const gasCostNative = result.gasCostNative ?? 0;

  // ── 10. Record the TX (including actual gas cost) ────────────────────────
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

  // ── 11. Webhook dispatch (non-blocking, LIVE only) ───────────────────────
  // Q402-SEC-002: sandbox relays are simulated — no on-chain TX exists.
  // Emitting HMAC-signed `relay.success` events for sandbox calls let a
  // downstream consumer that only validates the signature mistake a
  // fabricated event for a real settlement. Skip webhook dispatch entirely
  // for sandbox so sandbox traffic cannot be used to forge trusted events.
  const webhookCfg = isSandbox ? null : await getWebhookConfig(keyRecord.address);
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
