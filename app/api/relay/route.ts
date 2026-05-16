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
import {
  createReceipt,
  updateReceiptWebhookStatus,
  apiKeyFingerprint,
  type ReceiptMethod,
} from "@/app/lib/receipt";
import { queueReceiptBackfill } from "@/app/lib/receipt-backfill";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { createHash } from "crypto";
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
import { BNB_FOCUS_MODE, BNB_FOCUS_REJECTION_MESSAGE } from "@/app/lib/feature-flags";
import type { Hex, Address } from "viem";

// Valid Ethereum address pattern
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

// Minimum gas-tank balance (in native token) required to relay one TX. Calibrated
// per-chain to roughly $0.05–$0.10 USD-equivalent so the floor is consistent
// across chains. The previous unified `0.0001` was BNB-shaped: on ETH it gated
// at ~$0.30 (over-strict, blocked deposits that could pay), on AVAX/X Layer it
// was effectively $0.003 (too lax — relay could attempt and fail with OOG).
const MIN_GAS_BALANCE: Record<ChainKey, number> = {
  bnb:    0.0002,    // ~$0.10 at $500/BNB
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
    token:        "USDC" | "USDT" | "RLUSD";
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
  // could still try chain="injective" + token="USDC" or chain="bnb" + token="RLUSD".
  // Mirror the SDK's supportedTokens guard here so the server is the source
  // of truth and the asymmetric defense (SDK strict, server tolerant) is closed.
  //
  // The full multi-chain matrix below is what the protocol shipped on v1.27.
  // During a sprint window the feature flag BNB_FOCUS_MODE collapses the
  // matrix to a single chain/token pair (see app/lib/feature-flags.ts) — the
  // 7-chain entries remain in this file so removing the flag (or pointing
  // Vercel back at main) restores the full surface with zero code churn.
  //
  //   - Injective: USDT only. Native USDC via Circle CCTP is announced for Q2 2026.
  //   - Ethereum:  USDC / USDT / RLUSD (Ripple USD, NY DFS regulated, decimals 18).
  //   - RLUSD is intentionally Ethereum-only — Ripple has not deployed RLUSD on
  //     the XRPL EVM Sidechain yet, and Q402 is EVM-only so XRPL native is
  //     out of scope. Other 6 chains reject RLUSD via the absence of the token
  //     from their allowlist entry.
  const FULL_CHAIN_TOKEN_ALLOWLIST: Partial<Record<ChainKey, ReadonlyArray<"USDC" | "USDT" | "RLUSD">>> = {
    injective: ["USDT"],
    eth:       ["USDC", "USDT", "RLUSD"],
    bnb:       ["USDC", "USDT"],
    avax:      ["USDC", "USDT"],
    xlayer:    ["USDC", "USDT"],
    mantle:    ["USDC", "USDT"],
    stable:    ["USDC", "USDT"],
  };
  const SPRINT_CHAIN_TOKEN_ALLOWLIST: Partial<Record<ChainKey, ReadonlyArray<"USDC" | "USDT" | "RLUSD">>> = {
    bnb: ["USDC", "USDT"],
  };
  const CHAIN_TOKEN_ALLOWLIST = BNB_FOCUS_MODE
    ? SPRINT_CHAIN_TOKEN_ALLOWLIST
    : FULL_CHAIN_TOKEN_ALLOWLIST;
  const allowedTokens = CHAIN_TOKEN_ALLOWLIST[chain];
  if (!allowedTokens || !allowedTokens.includes(token)) {
    return NextResponse.json(
      {
        error:
          BNB_FOCUS_MODE && (chain !== "bnb" || !["USDC", "USDT"].includes(token))
            ? BNB_FOCUS_REJECTION_MESSAGE
            : chain === "injective" && token === "USDC"
              ? "USDC is not yet supported on Injective. Native USDC via Circle CCTP is announced for Q2 2026; until then use USDT on Injective."
              : token === "RLUSD"
                ? `RLUSD is only supported on Ethereum mainnet. Tried chain="${chain}".`
                : `Token "${token}" is not supported on chain "${chain}".${allowedTokens ? ` Supported: ${allowedTokens.join(", ")}.` : ""}`,
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
  // After the Phase 1 trial/paid key separation, a subscription may carry
  // FOUR key slots (apiKey + sandboxApiKey for paid scope, trialApiKey +
  // trialSandboxApiKey for trial scope). The incoming key is "current" if
  // it matches any of those four. We also derive `isTrialScopedKey` from
  // the key record's plan so a paid user who still has an active trial
  // key from before they upgraded gets TRIAL-scope semantics for that
  // key (BNB-only, trial expiry) — NOT paid-scope. Source-of-truth for
  // the key's scope is keyRecord.plan, set at generation time and
  // immutable except via updateApiKeyPlan (which payment-activate only
  // calls on the paid slots).
  const subscription = await getSubscription(keyRecord.address);
  const isTrialScopedKey = keyRecord.plan === "trial";
  if (subscription) {
    const isCurrentKey =
      subscription.apiKey === apiKey ||
      subscription.sandboxApiKey === apiKey ||
      subscription.trialApiKey === apiKey ||
      subscription.trialSandboxApiKey === apiKey;
    if (!isCurrentKey) {
      return NextResponse.json({ error: "API key has been rotated. Please use your current key." }, { status: 401 });
    }
    // Paid-scope expiry: only fires for non-trial keys on accounts that
    // actually paid (amountUSD > 0 + real paidAt). Trial keys hit the
    // trial-scope expiry below regardless of whether the subscription
    // has since upgraded to a paid plan.
    const isPaidAccount = (subscription.amountUSD ?? 0) > 0 && !!subscription.paidAt;
    if (!isSandbox && !isTrialScopedKey && isPaidAccount) {
      const expiresAt = new Date(new Date(subscription.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
      if (new Date() >= expiresAt) {
        return NextResponse.json({ error: "Subscription expired. Please renew to continue." }, { status: 403 });
      }
    }
    // Trial-scope expiry — keyed on trialExpiresAt. Fires for any key
    // generated with plan="trial" (legacy trial subs that wrote into
    // apiKey/sandboxApiKey AND post-Phase-1 trial subs in trialApiKey /
    // trialSandboxApiKey both go through this gate).
    if (!isSandbox && isTrialScopedKey) {
      if (!subscription.trialExpiresAt || new Date() >= new Date(subscription.trialExpiresAt)) {
        return NextResponse.json({ error: "Trial expired. Upgrade at /pricing to continue." }, { status: 403 });
      }
    }
  }

  // ── 4b. Trial-scope keys → BNB-only enforcement ──────────────────────────
  // Trial-scoped keys can only relay on BNB Chain regardless of the global
  // BNB_FOCUS_MODE flag. Free credits + Q402-covered gas only make economic
  // sense on the cheapest chain; anything else, the user should be on a
  // paid plan. Sandbox keys bypass (they don't move funds). Scoped on the
  // KEY's plan, not the subscription's — a paid user using an old trial
  // key still sees BNB-only on that key.
  if (!isSandbox && isTrialScopedKey && chain !== "bnb") {
    return NextResponse.json(
      {
        error: "Trial accounts are restricted to BNB Chain. Upgrade at /pricing for multi-chain access.",
        code: "TRIAL_BNB_ONLY",
      },
      { status: 403 },
    );
  }

  // ── 4c. API key model — `from` is the end-user wallet, NOT the key owner ─
  // Q402's product model is platform-as-billing (Stripe-Connect-style):
  //
  //   - The API key is the BUILDER's billing/quota account.
  //   - The `from` parameter is the END USER's wallet — a different person
  //     for each call. A builder selling a SaaS to N customers relays N
  //     distinct from-addresses through a single API key.
  //   - The witness signature in the body is signed by `from`'s EOA, so the
  //     server never moves anyone's funds without their direct authorization.
  //
  // Earlier revisions added a "from must equal keyRecord.address (or the
  // bound wallet)" enforcement — that BROKE the platform model: any builder
  // would have been forced to mint one API key per end user. Reverted.
  //
  // The real defense against API-key leak in this model is operational, not
  // structural:
  //   - Per-API-key rate limit (section 3b above, 30 relay calls / 60s).
  //   - Daily TX cap (section 7c via decrementCredit + the trial-scope
  //     2,000-credit ceiling for trial keys; paid keys cap on their gas
  //     tank balance).
  //   - Auth-fresh signature on every state-changing dashboard action so
  //     a leaked key alone can't rotate or top up.
  //   - One-click rotation in /dashboard → Developer.
  //
  // The blast radius of a leaked key is therefore bounded by quota and gas
  // tank, NOT by the user's primary wallet — which is what we want for a
  // platform model.

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

  // ── 6. Gas Tank balance check (sandbox + active trial skip this) ─────────
  // Trial users don't fund their own gas tank — Q402 covers the gas during
  // the sprint window. The relayer hot wallet still pays gas on-chain, but
  // we don't debit a per-user balance the user never deposited into.
  //
  // Scoped on the KEY's plan, not the subscription's — a paid user using
  // their old trial key still hits trial-scope gas behaviour for that key
  // (and the trial-expiry gate above already rejected it if past window).
  const isActiveTrial =
    isTrialScopedKey &&
    !!subscription?.trialExpiresAt &&
    new Date(subscription.trialExpiresAt) > new Date();
  if (!isSandbox && !isActiveTrial) {
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
      gasCostNative:  0,
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

  // ── 10. Resolve common settlement fields ─────────────────────────────────
  const tokenAmount    = ethers.formatUnits(amount, tokenCfg.decimals);
  const tokenAmountRaw = amount.toString();
  const relayedAt      = new Date().toISOString();

  // Webhook config fetched once and reused below for both receipt's initial
  // delivery state and the actual dispatch. Sandbox is excluded entirely
  // (Q402-SEC-002).
  const webhookCfg = isSandbox ? null : await getWebhookConfig(keyRecord.address);

  // ── 10a. Trust Receipt — settlement record + cryptographic proof ─────────
  // Created BEFORE recording the TX so we can stamp the receipt id onto the
  // RelayedTx history row (powers the dashboard's "View Receipt" link). If
  // signing/KV fails we degrade gracefully — the on-chain TX already
  // succeeded and the response should still confirm settlement.
  const method: ReceiptMethod =
      isStableEIP7702 ? "eip7702_stable"
    : isXLayerEIP7702 ? "eip7702_xlayer"
    : isXLayerEIP3009 ? "eip3009"
    :                   "eip7702";

  const initialDeliveryStatus =
      !webhookCfg?.active || !webhookCfg.url ? "not_configured"
    :                                          "pending";

  // The receipt input shape — declared once so inline + retry + backfill
  // can all reference the same data without copy-paste drift.
  const apiKeyIdHash = apiKeyFingerprint(apiKey);
  const apiKeyTier   = keyRecord.plan ?? "starter";
  const blockNumberInt = typeof result.blockNumber === "bigint"
                           ? Number(result.blockNumber)
                           : result.blockNumber;
  const receiptInput = {
    txHash:         result.txHash ?? "",
    blockNumber:    blockNumberInt,
    chain,
    payer:          from.toLowerCase(),
    recipient:      to.toLowerCase(),
    token,
    tokenAmount,
    tokenAmountRaw,
    method,
    gasCostNative:  gasCostNative ? gasCostNative.toString() : undefined,
    apiKeyId:       apiKeyIdHash,
    apiKeyTier,
    showTier:       false,
    sandbox:        isSandbox,
    webhook: {
      configured:     !!webhookCfg?.active && !!webhookCfg.url,
      event:          "relay.success",
      deliveryStatus: initialDeliveryStatus,
    },
  } as const;

  let receiptId:  string | null = null;
  let receiptUrl: string | null = null;
  try {
    const receipt = await createReceipt(receiptInput);
    receiptId  = receipt.receiptId;
    // Absolute URL so external integrators can open it as-is (drop into a
    // Slack message, paste into a browser, render in an OG card). Falls
    // back to the request origin when NEXT_PUBLIC_BASE_URL isn't set so
    // local dev still produces a clickable link.
    const origin = (process.env.NEXT_PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    receiptUrl = `${origin}/receipt/${receipt.receiptId}`;
  } catch (firstErr) {
    console.error("[relay] receipt creation failed, retrying once:", firstErr);
    // Inline retry once — covers transient KV blips before falling back to
    // the queued backfill. Two attempts catches the bulk of intermittent
    // failures without changing the response shape.
    try {
      const receipt = await createReceipt(receiptInput);
      receiptId  = receipt.receiptId;
      const origin = (process.env.NEXT_PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
      receiptUrl = `${origin}/receipt/${receipt.receiptId}`;
    } catch (secondErr) {
      console.error("[relay] receipt retry also failed — queuing backfill:", secondErr);
      // Queue for the cron-driven backfill so the receipt still gets
      // created eventually. We AWAIT the enqueue: the response is about
      // to return, so a fire-and-forget here can be silently dropped by
      // the serverless runtime mid-flight, which would break the
      // "every payment gets a receipt" guarantee. KV SADD + SET is two
      // round-trips, ~50ms; worth paying once per (already-rare)
      // double-failure case.
      try {
        await queueReceiptBackfill({
          txHash:            result.txHash ?? "",
          address:           keyRecord.address,
          chain,
          payer:             from.toLowerCase(),
          recipient:         to.toLowerCase(),
          token,
          tokenAmount,
          tokenAmountRaw,
          method,
          gasCostNative:     gasCostNative ? gasCostNative.toString() : undefined,
          apiKeyTier,
          apiKeyId:          apiKeyIdHash,
          sandbox:           isSandbox,
          webhookConfigured: !!webhookCfg?.active && !!webhookCfg.url,
          blockNumber:       blockNumberInt,
          relayedAt,
        });
      } catch (qErr) {
        // KV is genuinely unreachable here — the inline path AND the
        // queue write both failed. The on-chain TX is still real; we
        // log loudly but don't fail the response (failing here would
        // tell the caller the relay didn't happen, which is wrong).
        // We also page the operator: this is the only path where a
        // successful relay can produce no receipt at all. Catching
        // these in real time is the difference between "best-effort"
        // and "every payment gets a receipt".
        console.error("[relay] receipt backfill enqueue failed (KV unreachable):", qErr);
        const errMsg = qErr instanceof Error ? qErr.message : String(qErr);
        sendOpsAlert(
          `Q402 receipt durability breach\n` +
          `tx: <code>${result.txHash}</code>\n` +
          `chain: ${chain}\n` +
          `payer: ${from}\n` +
          `recipient: ${to}\n` +
          `amount: ${tokenAmount} ${token}\n` +
          `error: ${errMsg}\n\n` +
          `Inline retry + backfill enqueue both failed. Manual receipt creation required.`,
          "critical",
        ).catch(() => {});
      }
    }
  }

  // ── 11. Record the TX (including receipt id for dashboard link) ──────────
  // Fire-and-forget — on-chain TX already succeeded; don't block response on KV write
  //
  // Trial users: gasCostNative is zeroed in the per-user record so the dashboard
  // doesn't show negative gas-tank balance against their $0 deposit. The actual
  // gas is paid by Q402's relayer wallet; aggregate trial-gas burn is tracked
  // separately via the trial_gas_burned:{chain} HINCRBYFLOAT counter below so
  // ops still has visibility into platform spend.
  recordRelayedTx(keyRecord.address, {
    apiKey,
    address:      keyRecord.address,
    chain,
    fromUser:     from,
    toUser:       to,
    tokenAmount,
    tokenSymbol:  token,
    gasCostNative: isActiveTrial ? 0 : gasCostNative,
    relayTxHash:  result.txHash ?? "",
    relayedAt,
    receiptId:    receiptId ?? undefined,
  }).catch(e => console.error("[relay] TX record failed (non-fatal):", e));

  // Platform trial-gas burn counter — tracks how much native gas Q402 is
  // covering on behalf of trial users, broken down by chain. Pure ops metric,
  // not user-facing. Read with `HGETALL trial_gas_burned` from the Vercel KV
  // dashboard to see "X BNB burned for trial users this sprint".
  if (isActiveTrial && gasCostNative > 0) {
    void (async () => {
      try {
        const { kv } = await import("@vercel/kv");
        await kv.hincrbyfloat("trial_gas_burned", chain, gasCostNative);
      } catch (e) {
        console.error("[relay] trial_gas_burned counter failed (non-fatal):", e);
      }
    })();
  }

  // Sync subscription.quotaBonus for dashboard display (fire-and-forget, non-critical).
  // The authoritative counter is quota:{addr} (atomically decremented above).
  if (subscription && !isSandbox && creditReserved) {
    setSubscription(keyRecord.address, {
      ...subscription,
      quotaBonus: creditRemaining,
    }).catch(e => console.error("[relay] quotaBonus display sync failed (non-fatal):", e));
  }

  // ── 11b. Webhook dispatch (non-blocking, LIVE only) ──────────────────────

  if (webhookCfg?.active && webhookCfg.url) {
    // SSRF guard — shared ruleset with /api/webhook save + test paths.
    // Re-check at dispatch time so legacy rows stored under older rules
    // can't be used to pivot into internal networks.
    const webhookSafe = validateWebhookUrl(webhookCfg.url) === null;

    if (!webhookSafe && receiptId) {
      // Unsafe URL — dispatch is being skipped. Flip the receipt's webhook
      // state to a terminal "failed" so it doesn't sit in "pending" forever
      // and confuse ops debugging. The receipt's initial state was set to
      // pending under the assumption dispatch would happen; SSRF blocking
      // means it won't, so the receipt should reflect that.
      updateReceiptWebhookStatus(receiptId, {
        deliveryStatus: "failed",
        attempts:       0,
        lastError:      "Webhook URL blocked by SSRF guard",
      }).catch(e => console.error("[relay] receipt webhook update (blocked) failed:", e));
    }

    if (webhookSafe) {
      // receiptId + receiptUrl give ops/support a one-click path from the
      // customer's webhook log entry to the human-verifiable receipt page.
      // Both are nullable when receipt creation failed upstream so the
      // webhook still fires (relay.success is the source of truth, the
      // receipt is the audit layer on top of it).
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
        receiptId,
        receiptUrl,
      });
      const hmac = createHmac("sha256", webhookCfg.secret).update(payload).digest("hex");
      const webhookUrl     = webhookCfg.url;
      const webhookAddr    = keyRecord.address;

      // Retry up to 3 times with exponential backoff.
      // Scheduled via `after()` so Vercel keeps the function alive past the
      // response — `setTimeout`/fire-and-forget isn't guaranteed to survive the
      // serverless shutdown, which was silently dropping retries 2 and 3.
      // Delivery result is recorded in KV for visibility.
      // SHA256 of the payload + HMAC signature, stamped onto the receipt's
      // webhook trace. Lets a customer cross-check the bytes their endpoint
      // saw against the bytes Q402 dispatched, without re-running HMAC.
      const payloadSha256   = createHash("sha256").update(payload).digest("hex");
      const signatureSha256 = createHash("sha256").update(hmac).digest("hex");
      const trackedReceiptId = receiptId; // capture in closure scope

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
            const deliveredAt = new Date().toISOString();
            recordWebhookDelivery(webhookAddr, {
              timestamp: deliveredAt, event: "relay.success",
              ok: true, statusCode: res.status, attempt: i + 1,
              txHash: result.txHash ?? undefined,
            }).catch(() => {});
            if (trackedReceiptId) {
              updateReceiptWebhookStatus(trackedReceiptId, {
                deliveryStatus:  "delivered",
                attempts:        i + 1,
                lastStatusCode:  res.status,
                deliveredAt,
                payloadSha256,
                signatureSha256,
              }).catch(e => console.error("[relay] receipt webhook update (delivered) failed:", e));
            }
            return;
          }
          lastError = res.error;
        }
        // All attempts failed — record for visibility
        recordWebhookDelivery(webhookAddr, {
          timestamp: new Date().toISOString(), event: "relay.success",
          ok: false, statusCode: lastStatus, error: lastError, attempt: DELAYS.length,
          txHash: result.txHash ?? undefined,
        }).catch(() => {});
        if (trackedReceiptId) {
          updateReceiptWebhookStatus(trackedReceiptId, {
            deliveryStatus:  "failed",
            attempts:        DELAYS.length,
            lastStatusCode:  lastStatus,
            lastError,
            payloadSha256,
            signatureSha256,
          }).catch(e => console.error("[relay] receipt webhook update (failed) failed:", e));
        }
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
    method,
    receiptId,
    receiptUrl,
  });
}
