import { NextRequest, NextResponse, after } from "next/server";
import { ethers } from "ethers";
import { kv } from "@vercel/kv";
import { isChainDisabled, CHAIN_DISABLED_MESSAGE } from "@/app/lib/chain-status";
import {
  getApiKeyRecord,
  getGasBalance,
  recordRelayedTx,
  getSubscription,
  setSubscription,
  getWebhookConfig,
  getScopedCredits,
  initScopedQuotaIfNeeded,
  decrementScopedCredit,
  refundScopedCredit,
  seedFromLegacy,
  recordWebhookDelivery,
  isCashPaidSubscription,
  incrStatsCounters,
  type CreditScope,
  type RelayedTx,
} from "@/app/lib/db";
type RelayedTxSource = NonNullable<RelayedTx["source"]>;
import {
  createReceipt,
  updateReceiptWebhookStatus,
  apiKeyFingerprint,
  type ReceiptMethod,
} from "@/app/lib/receipt";
import { queueReceiptBackfill } from "@/app/lib/receipt-backfill";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { validateWebhookUrl } from "@/app/lib/webhook-validator";
import { safeWebhookFetch } from "@/app/lib/safe-fetch";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { isSanctioned } from "@/app/lib/hooks/compliance";
import { quackAmountToUsd } from "@/app/lib/quack-price";
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
import { witnessSignerMatches, type WitnessValue } from "@/app/lib/witness-verify";

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
  // Monad: keep the per-relay floor well above the EIP-7702 reserve-balance
  // tripwire (10 MON triggers `unconditionally revert` for delegated EOAs).
  // That rule applies to the user's EOA, not the facilitator, but a floor
  // here also lets the gas-tank exhaustion alert fire well before relayer
  // settles dip into the user-side reserve range.
  monad:  0.05,      // ~$0.10 at $2/MON (rough launch-day price; tune later)
  // Scroll L2: data-availability cost dominates, ~$0.001 effective gas per
  // relay. ETH-denominated floor kept conservative — gas-tank alert window
  // would otherwise trigger more often than makes operational sense.
  scroll: 0.00005,   // ~$0.20 at $4000/ETH; tune once on-chain history accrues
  // Arbitrum One Optimistic Rollup: data-availability cost dominates per-tx gas
  // similar to Scroll. Same conservative ETH floor; revisit after the first
  // week of mainnet relay history accrues to tune up or down.
  arbitrum: 0.00005, // ~$0.20 at $4000/ETH; tune once on-chain history accrues
  // Base OP Stack L2: data-availability cost dominates per-tx gas like Scroll /
  // Arbitrum. Same conservative ETH floor; revisit after mainnet relay history.
  base:    0.00005,  // ~$0.20 at $4000/ETH; tune once on-chain history accrues
};


// Module-level step tracker — set immediately before each KV call inside
// handleRelay so the catch block in POST can report which step blew up.
// Race condition is acceptable for diagnosis (all concurrent calls are
// failing at the same step anyway under the WRONGTYPE bug).
let lastRelayStep = "init";

export async function POST(req: NextRequest) {
  lastRelayStep = "POST-entry";
  try {
    return await handleRelay(req);
  } catch (err) {
    // Last-resort net: an unhandled throw deeper in the relay path (especially
    // a KV WRONGTYPE thrown by a multi-command pipeline) used to bubble all
    // the way out of the handler, and the Vercel runtime turned that into a
    // bare HTTP 500 with an empty body. Downstream consumers (q402-viz
    // backend, MCP, SDK) saw `non-JSON (HTTP 500): ` and lost the actual
    // cause. Returning a JSON shape with the error message + a trimmed
    // stack head keeps the body parseable and tells the caller (and our
    // logs) exactly which downstream KV call blew up, so the next failure
    // is diagnosable in one round-trip instead of three.
    console.error("[relay] unhandled error:", err);
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error
      ? (err.stack ?? "").split("\n").slice(0, 6).map((s) => s.trim()).join(" | ")
      : "";
    // The error message + step name stay (downstream consumers parse them),
    // but the stack is an internal diagnostic — don't return it to external
    // callers in production. The console.error above always retains it.
    const includeStack = process.env.NODE_ENV !== "production";
    return NextResponse.json(
      { error: `relay_failed at step=${lastRelayStep}: ${message}`, step: lastRelayStep, ...(includeStack ? { stack } : {}) },
      { status: 500 },
    );
  }
}

async function handleRelay(req: NextRequest): Promise<NextResponse> {
  let body: {
    apiKey:       string;
    chain:        ChainKey;
    token:        "USDC" | "USDT" | "RLUSD" | "Q";
    from:         string;
    to:           string;
    amount:       string;
    deadline:     number;
    nonce?:       string;  // uint256 nonce for avax/bnb/eth/mantle/injective/monad/scroll/arbitrum/arbitrum (v1.2 contract)
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
  lastRelayStep = "rateLimit:ip";
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

  // ── Internal-trust gate for caller-supplied provenance fields ────────────
  //
  // Body fields `source` and `ruleId` let an internal caller (the recurring
  // cron, the agentic-wallet send route, etc.) classify the resulting
  // RelayedTx row so the dashboard's "Recurring only" Transactions filter
  // and external accounting tooling can split scheduled payouts from
  // one-off sends. External customers calling /api/relay directly must
  // NOT be able to lie here (e.g. tag a one-shot send as "recurring"
  // to dodge accounting alerts), so the trust check below only honours
  // these fields when the X-Q402-Internal-Trust header carries a
  // constant-time match against CRON_SECRET. Without the header — or
  // with a mismatched value — both fields are dropped and `source` for
  // this tx falls back to undefined (treated as "All" in the filter,
  // never "Recurring only"). Mirrors the requireCronAuth shape used by
  // the cron routes themselves.
  let trustedSource: RelayedTxSource | undefined;
  let trustedRuleId: string | undefined;
  const internalTrust = req.headers.get("x-q402-internal-trust") ?? "";
  const cronSecretValue = process.env.CRON_SECRET ?? "";
  if (cronSecretValue.length > 0 && internalTrust.length === cronSecretValue.length) {
    const a = Buffer.from(internalTrust);
    const b = Buffer.from(cronSecretValue);
    if (timingSafeEqual(a, b)) {
      const rawSource = (body as { source?: unknown }).source;
      if (
        rawSource === "recurring" ||
        rawSource === "send" ||
        rawSource === "batch" ||
        rawSource === "api" ||
        rawSource === "request"
      ) {
        trustedSource = rawSource;
      }
      const rawRuleId = (body as { ruleId?: unknown }).ruleId;
      if (typeof rawRuleId === "string" && rawRuleId.length > 0 && rawRuleId.length <= 64) {
        trustedRuleId = rawRuleId;
      }
    }
  }

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

  // ── 1a. Held chains (chain-status.ts) — clean 400 before quota/auth work.
  // settlePayment() also stops these as the universal chokepoint; this just
  // returns a tidy error earlier in the request.
  if (isChainDisabled(chain)) {
    return NextResponse.json({ error: CHAIN_DISABLED_MESSAGE }, { status: 400 });
  }

  // ── 1aa. Per-chain token policy (server-side allowlist) ──────────────────
  // SDK rejects unsupported tokens at pay() time, but a direct API caller
  // could still try chain="injective" + token="USDC" or chain="bnb" + token="RLUSD".
  // Mirror the SDK's supportedTokens guard here so the server is the source
  // of truth and the asymmetric defense (SDK strict, server tolerant) is closed.
  //
  // The full multi-chain matrix below is what the protocol shipped on v1.27.
  // The emergency feature flag BNB_FOCUS_MODE (see app/lib/feature-flags.ts)
  // can collapse the matrix to BNB+USDC/USDT for emergency narrowing; the
  // 11-chain entries stay in this file so flipping the flag back to false
  // (current default) restores the full surface with zero code churn.
  //
  //   - Injective: USDC + USDT (native Circle USDC via CCTP, live since 2026-06).
  //   - Ethereum:  USDC / USDT / RLUSD (Ripple USD, NY DFS regulated, decimals 18).
  //   - RLUSD is intentionally Ethereum-only — Ripple has not deployed RLUSD on
  //     the XRPL EVM Sidechain yet, and Q402 is EVM-only so XRPL native is
  //     out of scope. Non-Ethereum chains reject RLUSD via the absence of the
  //     token from their allowlist entry.
  const FULL_CHAIN_TOKEN_ALLOWLIST: Partial<Record<ChainKey, ReadonlyArray<"USDC" | "USDT" | "RLUSD" | "Q">>> = {
    injective: ["USDT", "USDC"],
    eth:       ["USDC", "USDT", "RLUSD"],
    bnb:       ["USDC", "USDT", "Q"],
    avax:      ["USDC", "USDT"],
    xlayer:    ["USDC", "USDT"],
    mantle:    ["USDC", "USDT"],
    stable:    ["USDC", "USDT"],
    monad:     ["USDC", "USDT"],
    scroll:    ["USDC", "USDT"],
    arbitrum:  ["USDC", "USDT"],
    base:      ["USDC", "USDT"],
  };
  const SPRINT_CHAIN_TOKEN_ALLOWLIST: Partial<Record<ChainKey, ReadonlyArray<"USDC" | "USDT" | "RLUSD" | "Q">>> = {
    bnb: ["USDC", "USDT", "Q"],
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

  // ── 1a-OFAC. Global sanctioned-address screen ────────────────────────────
  // /api/relay is the chokepoint for EVERY settlement path — agentic
  // send/batch, recurring payouts, direct SDK, MCP eoa/local, the viz.
  // Screening HERE is what makes OFAC truly global: a direct relay call
  // to a sanctioned recipient is blocked too, closing the
  // "swap-the-endpoint" bypass. FAIL CLOSED — a confirmed hit AND a KV
  // read error both reject (451 / 503). The direct relay/recurring paths
  // have no other compliance gate, so a transient inability to screen
  // must pause settlement (client retries) rather than wave it through.
  try {
    if (await isSanctioned(to)) {
      return NextResponse.json(
        { error: "COMPLIANCE_BLOCKED", message: "Recipient is on the OFAC sanctioned-address list. This payment cannot be processed." },
        { status: 451 },
      );
    }
  } catch (e) {
    void sendOpsAlert(
      `relay OFAC screen READ failed (failing CLOSED, 503) for recipient ${to.toLowerCase()} on ${chain}. ` +
        `Settlements are pausing until KV / the ofac:sanctioned set recovers. ` +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      "critical",
    );
    return NextResponse.json(
      { error: "compliance_screen_unavailable", message: "Recipient compliance screening is temporarily unavailable. Retry shortly." },
      { status: 503 },
    );
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
  // Base x402 rail: USDC EIP-3009 transferWithAuthorization, Q402 as the
  // facilitator sponsoring gas. Selected by sending `eip3009Nonce` (+ the
  // EIP-3009 signature in `witnessSig`) with NO `authorization`, mirroring the
  // X Layer EIP-3009 fallback. The Q402 (EIP-7702) rail on Base uses
  // `authorization` instead — so the rail is chosen by which fields the client
  // signs, no extra selector field needed.
  const isBaseEIP3009 = chain === "base" && !!eip3009Nonce && !authorization;
  // Any USDC EIP-3009 settlement (x402-compatible). The USDC token contract
  // verifies the signature against its own EIP-712 domain; the relayer only
  // submits transferWithAuthorization() and pays the gas.
  const isEIP3009 = isXLayerEIP3009 || isBaseEIP3009;
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
  if (!isXLayer && !isStable && !isBaseEIP3009 && !authorization) {
    return NextResponse.json(
      { error: chain === "base"
          ? "base requires either `authorization` (Q402 EIP-7702 rail; USDC or USDT) or `eip3009Nonce` (x402 EIP-3009 rail; USDC only)"
          : "EIP-7702 chains (avax/bnb/eth/mantle/injective/monad/scroll/arbitrum) require authorization object" },
      { status: 400 }
    );
  }
  // avax/bnb/eth/mantle/injective/monad/scroll/arbitrum also require `nonce` — it's part of the signed witness, so a
  // server-synthesized fallback would never match the caller's signature. Fail
  // fast with a clear 400 instead of letting the onchain verify path reject it.
  if (!isXLayer && !isStable && !isBaseEIP3009 && !nonce) {
    return NextResponse.json(
      { error: "nonce is required for avax/bnb/eth/mantle/injective/monad/scroll/arbitrum and the Base Q402 rail (uint256 string, must match the signed witness)" },
      { status: 400 }
    );
  }

  // ── 2a. EIP-3009 settlement is USDC-only (X Layer fallback + Base x402 rail) ──
  // transferWithAuthorization (9-param v,r,s) is implemented by Circle USDC.
  // X Layer / Base USDT do not expose the same EIP-3009 surface, so route USDT
  // through the EIP-7702 (Q402) rail instead.
  if (isEIP3009 && token !== "USDC") {
    return NextResponse.json(
      { error: isBaseEIP3009
          ? "The Base x402 (EIP-3009) rail supports USDC only. Use the Q402 EIP-7702 rail (send `authorization`) for USDT."
          : "EIP-3009 fallback on X Layer supports USDC only. Use EIP-7702 (authorization + xlayerNonce) for USDT." },
      { status: 400 }
    );
  }

  // ── 2b. Parse nonce-like fields up front (Q402-SEC-001 follow-up) ────────────
  // BigInt() throws on malformed input. If we let that throw later — after
  // section 7c's decrementScopedCredit() — a malformed nonce burns a credit slot
  // without a successful relay. Parse here, return 400 on garbage, so the
  // entitlement-ordering invariant ("no quota burn before commit") holds for
  // every required nonce field on every chain.
  let parsedPaymentNonce: bigint = 0n;
  let parsedXLayerNonce:  bigint = 0n;
  let parsedStableNonce:  bigint = 0n;
  try {
    if (!isXLayer && !isStable && !isBaseEIP3009) parsedPaymentNonce = BigInt(nonce!);
    if (isXLayerEIP7702)        parsedXLayerNonce  = BigInt(xlayerNonce!);
    if (isStableEIP7702)        parsedStableNonce  = BigInt(stableNonce!);
  } catch {
    return NextResponse.json(
      { error: "nonce/xlayerNonce/stableNonce must be a valid uint256 string (decimal or 0x-hex)" },
      { status: 400 }
    );
  }
  // EIP-3009 nonce is a bytes32 hex string, not a BigInt — validate shape only.
  if (isEIP3009 && !/^0x[0-9a-fA-F]{64}$/.test(eip3009Nonce!)) {
    return NextResponse.json(
      { error: "eip3009Nonce must be 0x-prefixed bytes32 hex" },
      { status: 400 }
    );
  }

  // ── 3. API Key validation ────────────────────────────────────────────────
  lastRelayStep = "getApiKeyRecord";
  const keyRecord = await getApiKeyRecord(apiKey);
  if (!keyRecord || !keyRecord.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  // ── 3a. Sandbox key detection ────────────────────────────────────────────
  // Only trust the DB field — never the key prefix (client-facing, spoofable)
  const isSandbox = keyRecord.isSandbox === true;

  // ── 3b. Per-API-key rate limit (30 relay calls / 60s per key, fail-closed) ─
  lastRelayStep = "rateLimit:apiKey";
  if (!(await rateLimit(apiKey, "relay-key", 30, 60, false))) {
    return NextResponse.json({ error: "Too many requests for this API key" }, { status: 429 });
  }

  // F1: per-key on-chain FAILURE limit (distinct from the 30/min attempt cap).
  // A (trial) key + a self-delegated EOA can loop INVALID witness signatures:
  // each reverts on-chain, Q402 pays the gas, and the credit is refunded below
  // — an unpriced drain bounded only by the attempt cap. Block a key that racks
  // up reverts (15-min window) so the bleed can't continue. Fail-open on a KV
  // blip so a transient storage error can't lock out legitimate users.
  const relayFailKey = `relay-fail:${keyRecord.address.toLowerCase()}`;
  let recentRelayFails = 0;
  try {
    recentRelayFails = Number((await kv.get<number>(relayFailKey)) ?? 0);
  } catch {
    // Fail-CLOSED for trial keys: the gas-drain-via-bad-signature vector runs
    // on free trial identities, so if KV is down and we can't bound failures,
    // refuse the trial attempt rather than relay it unmetered. Paid keys
    // fail-open (a KV blip shouldn't block a paying customer).
    if (keyRecord.plan === "trial") {
      return NextResponse.json(
        { error: "Relay temporarily unavailable — please retry shortly." },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
  }
  if (recentRelayFails >= 12) {
    return NextResponse.json(
      { error: "Too many failed relays on this key — temporarily blocked. Verify your signature and retry later." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
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
  lastRelayStep = "getSubscription";
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
    // actually paid cash (amountUSD > 0 + real paidAt). Operational grants
    // (admin-grant.mjs) intentionally leave amountUSD === 0 so they are
    // non-expiring — isCashPaidSubscription returns false for those and
    // this 30-day window is skipped. Trial keys hit the trial-scope expiry
    // below regardless of whether the subscription has since upgraded.
    if (!isSandbox && !isTrialScopedKey && isCashPaidSubscription(subscription)) {
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
        return NextResponse.json({ error: "Trial expired. Upgrade at /payment to continue." }, { status: 403 });
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
        error: `Trial API Key supports BNB Chain only — got "${chain}". Use a Multichain API Key for ${chain} and other paid chains. Upgrade at /payment.`,
        code: "TRIAL_BNB_ONLY",
      },
      { status: 403 },
    );
  }

  // ── 4c. Platform billing permits payer != key owner ──────────────────────
  // The API key is the builder's billing/quota account; `from` is the end
  // user's wallet, signed by that wallet's EOA in the witness. A builder
  // relaying for N end-users uses a single API key with N distinct `from`
  // values. No structural equality check between `from` and the key owner.
  //
  // Defense against API-key leak is operational:
  //   - Per-API-key rate limit (section 3b — 30 relay calls / 60s).
  //   - Daily TX cap via the atomic credit decrement (section 7c).
  //   - Trial-scope 2,000-credit ceiling; paid-scope gas-tank balance gate.
  //   - Fresh-auth required for state-changing dashboard actions, so a
  //     leaked key alone cannot rotate the key or top up the gas tank.
  //   - One-click rotation in /dashboard → Developer.
  //
  // Blast radius of a leak is bounded by quota and gas tank — never by the
  // owner's primary wallet, which the server has no signing authority over.

  // ── 4a. TX credit quick pre-check (stale OK — real gate is atomic decrement) ──
  // Scope-aware: a paid user with depleted trial pool but an active paid key
  // never hits this gate. Trial keys read trial pool; paid keys read paid pool.
  if (!isSandbox) {
    const quickScope: CreditScope = isTrialScopedKey ? "trial" : "paid";
    const quickCredits = await getScopedCredits(keyRecord.address, quickScope);
    if (quickCredits <= 0) {
      return NextResponse.json({
        error: isTrialScopedKey
          ? "No trial credits remaining. Upgrade at /payment to continue."
          : "No TX credits remaining. Purchase additional credits to continue.",
      }, { status: 429 });
    }
  }

  // ── 5. Supported-chain check ──────────────────────────────────────────────
  // Q402-SEC-001: moved ahead of the credit decrement so an unsupported-chain
  // request no longer burns a quota slot.
  const chainCfg = CHAIN_CONFIG[chain];
  if (!chainCfg) {
    return NextResponse.json({
      error: `Chain "${chain}" is not supported. Supported: avax, bnb, eth, xlayer, stable, mantle, injective, monad, scroll, arbitrum, base.`,
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
  // Trial users don't fund their own gas tank — the Free Trial program is
  // gas-sponsored by Q402. The relayer hot wallet still pays gas on-chain,
  // but we don't debit a per-user balance the user never deposited into.
  //
  // Scoped on the KEY's plan, not the subscription's — a paid user using
  // their old trial key still hits trial-scope gas behaviour for that key
  // (and the trial-expiry gate above already rejected it if past window).
  const isActiveTrial =
    isTrialScopedKey &&
    !!subscription?.trialExpiresAt &&
    new Date(subscription.trialExpiresAt) > new Date();
  if (!isSandbox && !isActiveTrial) {
    lastRelayStep = "getGasBalance";
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
  // decrementing credits. Previously loadRelayerKey() ran after decrementScopedCredit(),
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

  // ── 6b. Relayer EOA on-chain balance pre-flight (live only) ──────────────
  // The relayer hot wallet pays the actual settlement gas. If it's dipped
  // below the gas of one tx the relay would still attempt → revert with a
  // viem-level "insufficient funds for transfer" → masked by the generic
  // "Relay failed. Check your signature and parameters." (400) at the
  // bottom of this route, which is misleading: the caller's signature is
  // fine, the relayer is just out of native. Surface this distinctly so
  // (a) the dashboard can show a clear "infrastructure refilling" banner,
  // (b) ops alerting can fire on the 503, and (c) the user's quota isn't
  // wasted on a guaranteed-revert attempt.
  if (!isSandbox) {
    try {
      const probeProvider = new (await import("ethers")).JsonRpcProvider(chainCfg.rpc);
      const [balanceWei, feeData] = await Promise.all([
        probeProvider.getBalance(relayerAddress),
        probeProvider.getFeeData(),
      ]);
      const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      // settlePayment caps gas at 300k for the type-4 path. Add 20%
      // headroom so a marginal-balance relayer doesn't ping-pong between
      // "ready" and "low" between back-to-back relays.
      const minRequired = maxFeePerGas * 360_000n;
      if (balanceWei < minRequired) {
        return NextResponse.json(
          {
            error: "RELAYER_LOW",
            message:
              `Q402 relay infrastructure on ${chain} is refilling. Try again in a few minutes — ` +
              `your quota and Gas Tank balance are untouched.`,
          },
          { status: 503 },
        );
      }
    } catch {
      // RPC unreachable on this chain — let the settlement attempt
      // surface the failure with its own (more specific) error. We
      // don't want to harden the route against transient RPC blips.
    }
  }

  // ── 7b. nonce (uint256) for avax/bnb/eth/mantle/injective/monad/scroll/arbitrum transferWithAuthorization ─────────
  // Parsed up front in section 2b so a malformed value can't escape past the
  // credit reservation in section 7c.
  const paymentNonce: bigint = parsedPaymentNonce;

  const tokenCfg = getTokenConfig(chain, token);
  let result: import("@/app/lib/relayer").SettleResult = { success: false, error: "No relay path matched" };

  // ── 6c. Off-chain witness pre-check (before any credit/gas is spent) ──────
  // The EIP-7702 witness path signs a TransferAuthorization; recover its signer
  // here and reject a clear mismatch up front, so an invalid signature costs
  // neither a quota credit nor relayer gas (a sybil gas-drain vector). Skipped
  // for the EIP-3009 fallback (different scheme) and sandbox. Fail-open by
  // construction — see witnessSignerMatches.
  if (!isSandbox && !isEIP3009) {
    const witnessValue: WitnessValue = {
      owner:       from,
      facilitator: relayerAddress,
      token:       tokenCfg.address,
      recipient:   to,
      amount:      BigInt(amount),
      nonce:       paymentNonce,
      deadline:    BigInt(deadline),
    };
    if (!witnessSignerMatches(chain, chainCfg.chainId, witnessValue, witnessSig)) {
      // Count it toward the per-key failure limit (same as an on-chain revert),
      // then reject without reserving credit or relaying.
      try {
        const n = await kv.incr(relayFailKey);
        if (n === 1) await kv.expire(relayFailKey, 900);
      } catch { /* counter is best-effort */ }
      return NextResponse.json(
        { error: "Signature does not match the payment parameters." },
        { status: 400 },
      );
    }
  }

  // ── 6d. EIP-3009 off-chain pre-check (Base x402 rail) — FAIL-CLOSED ────────
  // The witness pre-check above is skipped for EIP-3009 (different scheme). This
  // guard exists specifically to stop a guaranteed on-chain revert from burning
  // a quota credit + relayer gas, so for the Base x402 rail it is fail-CLOSED: a
  // malformed signature, a signer mismatch, or an inability to read delegation
  // state all reject HERE rather than letting the USDC contract revert on-chain.
  // Base USDC's EIP-712 domain is pinned + verified on-chain (name "USD Coin",
  // version "2"). X Layer's existing EIP-3009 fallback path is left untouched.
  if (!isSandbox && isBaseEIP3009) {
    // (a) Shape-check the signature up front. A malformed value would otherwise
    // throw inside verifyTypedData; catching that as "could not verify" (below)
    // is correct, but checking the 65-byte 0x form here gives a precise error.
    if (typeof witnessSig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(witnessSig)) {
      return NextResponse.json(
        { error: "EIP-3009 signature is malformed (expected a 65-byte 0x signature)." },
        { status: 400 },
      );
    }

    // (b) A q402-delegated wallet (EIP-7702 set-code) cannot settle via EIP-3009:
    // USDC V2_2's SignatureChecker routes code-bearing accounts to ERC-1271,
    // which the Q402 impl does not implement, so the token reverts. Reject up
    // front. RPC failure → 503 (fail-closed): we cannot confirm the wallet is
    // undelegated, and proceeding would risk a guaranteed-revert gas burn.
    try {
      const codeProvider = new (await import("ethers")).JsonRpcProvider(chainCfg.rpc);
      const fromCode = await codeProvider.getCode(from);
      if (fromCode && fromCode !== "0x") {
        return NextResponse.json(
          {
            error: "X402_WALLET_DELEGATED",
            message:
              "This wallet is EIP-7702 delegated (it used the Q402 rail), so the " +
              "USDC EIP-3009 (x402) path cannot verify its signature. Use the Q402 " +
              "rail (send `authorization`) or clear the delegation first.",
          },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        {
          error: "X402_DELEGATION_CHECK_UNAVAILABLE",
          message:
            "Could not confirm this wallet's delegation state on Base right now. " +
            "Retry shortly, or use the Q402 rail. Your quota and Gas Tank are untouched.",
        },
        { status: 503 },
      );
    }

    // (c) Off-chain signer recovery. A recovery FAILURE or a signer MISMATCH
    // both mean the signature would not verify on-chain — reject (fail-closed).
    let recovered: string;
    try {
      recovered = ethers.verifyTypedData(
        { name: "USD Coin", version: "2", chainId: chainCfg.chainId, verifyingContract: tokenCfg.address },
        { TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ] },
        { from, to, value: BigInt(amount), validAfter: 0n, validBefore: BigInt(deadline), nonce: eip3009Nonce! },
        witnessSig,
      );
    } catch {
      try {
        const n = await kv.incr(relayFailKey);
        if (n === 1) await kv.expire(relayFailKey, 900);
      } catch { /* counter is best-effort */ }
      return NextResponse.json(
        { error: "EIP-3009 signature could not be verified." },
        { status: 400 },
      );
    }
    if (recovered.toLowerCase() !== from.toLowerCase()) {
      try {
        const n = await kv.incr(relayFailKey);
        if (n === 1) await kv.expire(relayFailKey, 900);
      } catch { /* counter is best-effort */ }
      return NextResponse.json(
        { error: "EIP-3009 signature does not match the payment parameters." },
        { status: 400 },
      );
    }
  }

  // ── 7c. Atomic credit reservation (just before relay — race-safe) ────────
  // initScopedQuotaIfNeeded: SET NX with a seed pulled from legacy. On a
  //                           clean post-reconciliation account this is a
  //                           no-op (key already exists). On an unmigrated
  //                           account this captures the legacy balance into
  //                           the correct pool exactly once.
  // decrementScopedCredit:    Redis DECRBY on quota:{scope}:{addr}.
  //                           Underflow → refund + 429.
  let creditReserved = false;
  let creditRemaining = 0;
  let creditScope: CreditScope = "paid";
  if (!isSandbox) {
    creditScope = isTrialScopedKey ? "trial" : "paid";
    const seed = await seedFromLegacy(keyRecord.address, creditScope);
    lastRelayStep = "initScopedQuotaIfNeeded";
    await initScopedQuotaIfNeeded(keyRecord.address, creditScope, seed);
    lastRelayStep = "decrementScopedCredit";
    const dec = await decrementScopedCredit(keyRecord.address, creditScope);
    if (!dec.ok) {
      return NextResponse.json({
        error: isTrialScopedKey
          ? "No trial credits remaining. Upgrade at /payment to continue."
          : "No TX credits remaining. Purchase additional credits to continue.",
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

  } else if (isEIP3009) {
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
    // Relay failed — refund the quota credit so the user isn't charged for
    // a failed attempt. The refund MUST be awaited: a fire-and-forget
    // promise can be dropped when the serverless invocation returns, which
    // silently strands the user's quota in the "spent" state for a relay
    // that never landed on chain. If the refund itself also fails (KV
    // transient), page ops so the deficit doesn't go unnoticed.
    if (creditReserved) {
      try {
        // Refund hits the SAME pool we decremented from. The captured
        // `creditScope` is the source of truth — never re-derive from
        // isTrialScopedKey here (it'd still be correct today but is
        // fragile to future scope-determination refactors).
        lastRelayStep = "refundScopedCredit";
        await refundScopedCredit(keyRecord.address, creditScope);
      } catch (e) {
        console.error("[relay] credit refund failed after relay failure:", e);
        await sendOpsAlert(
          `<b>Quota refund failed after relay failure</b>\n` +
          `Address: <code>${keyRecord.address}</code>\n` +
          `Chain: ${chain}\nFrom: <code>${from}</code>\n` +
          `Error: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    }
    // Don't leak internal RPC errors or contract revert reasons to callers
    console.error(`[relay] failed chain=${chain} from=${from}: ${result.error}`);
    // F1: count this on-chain failure toward the per-key block threshold so a
    // signature-revert loop can't bleed gas indefinitely. Best-effort.
    try {
      const n = await kv.incr(relayFailKey);
      if (n === 1) await kv.expire(relayFailKey, 900);
    } catch { /* counter is best-effort */ }
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
  lastRelayStep = "getWebhookConfig";
  const webhookCfg = isSandbox ? null : await getWebhookConfig(keyRecord.address);

  // ── 10a. Trust Receipt — settlement record + cryptographic proof ─────────
  // Created BEFORE recording the TX so we can stamp the receipt id onto the
  // RelayedTx history row (powers the dashboard's "View Receipt" link). If
  // signing/KV fails we degrade gracefully — the on-chain TX already
  // succeeded and the response should still confirm settlement.
  const method: ReceiptMethod =
      isStableEIP7702 ? "eip7702_stable"
    : isXLayerEIP7702 ? "eip7702_xlayer"
    : isEIP3009 ? "eip3009"
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
  lastRelayStep = "createReceipt";
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
  // Routed through `after()` (next/server) so the writes run AFTER the
  // response is flushed but before Vercel tears the serverless function
  // down. A fire-and-forget call here can drop the write on cold-stop or
  // transient KV failure — the user would see the on-chain settlement
  // succeed but the Transactions tab + gas-tank debit would never land.
  //
  // Trial users: gasCostNative is zeroed in the per-user record so the dashboard
  // doesn't show negative gas-tank balance against their $0 deposit. The actual
  // gas is paid by Q402's relayer wallet; aggregate trial-gas burn is tracked
  // separately via the trial_gas_burned:{chain} HINCRBYFLOAT counter below so
  // ops still has visibility into platform spend.
  after(async () => {
    try {
      await recordRelayedTx(keyRecord.address, {
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
        ...(trustedSource ? { source: trustedSource } : {}),
        ...(trustedRuleId ? { ruleId: trustedRuleId } : {}),
        // Tag only the Coinbase x402 (Base USDC EIP-3009) rail so the activity
        // feed can badge it; q402 (the default EIP-7702 rail) stays untagged.
        ...(isBaseEIP3009 ? { rail: "x402" as const } : {}),
      });
    } catch (e) {
      console.error("[relay] TX record failed (after-response):", e);
    }
  });

  // Materialized public-stats counters — feed /api/stats/public so the public
  // panel (settlements / unique payers / unique recipients / volume / per-chain)
  // updates in real time without SCAN-ing on every render. Sandbox calls are
  // excluded; the public view is on-chain settlements only. Runs in its own
  // after() block so a stats-counter failure cannot cascade into the TX-record
  // path above (and vice-versa).
  if (!isSandbox) {
    after(async () => {
      try {
        // Q is not USD-pegged — value it via the TWAP so public volume isn't
        // inflated by the raw token count. Fail to 0 (don't poison the metric).
        // (token is typed USDC/USDT/RLUSD; Q reaches here as a runtime string
        // via the allowlist + getTokenConfig — compare as string.)
        const volumeUsd =
          (token as string) === "Q"
            ? await quackAmountToUsd(Number(tokenAmount)).catch(() => 0)
            : Number(tokenAmount);
        await incrStatsCounters({
          payer:     from,
          recipient: to,
          chain,
          amountUsd: volumeUsd,
        });
      } catch (e) {
        console.error("[relay] stats counter incr failed (after-response):", e);
      }
    });
  }

  // Platform trial-gas burn counter — tracks how much native gas Q402 is
  // covering on behalf of trial users, broken down by chain. Pure ops metric,
  // not user-facing. Same after() guarantee as the TX-record above.
  if (isActiveTrial && gasCostNative > 0) {
    after(async () => {
      try {
        const { kv } = await import("@vercel/kv");
        await kv.hincrbyfloat("trial_gas_burned", chain, gasCostNative);
      } catch (e) {
        console.error("[relay] trial_gas_burned counter failed (after-response):", e);
      }
    });
  }

  // Sync subscription mirrors for dashboard display (fire-and-forget, non-critical).
  // Authoritative counters live in quota:{scope}:{addr}. The mirrors below let
  // the dashboard render without an extra round-trip on most page loads.
  if (subscription && !isSandbox && creditReserved) {
    const mirrorField = creditScope === "trial" ? "trialQuotaBonus" : "paidQuotaBonus";
    const otherScopeMirror = creditScope === "trial"
      ? (subscription.paidQuotaBonus  ?? 0)
      : (subscription.trialQuotaBonus ?? 0);
    setSubscription(keyRecord.address, {
      ...subscription,
      [mirrorField]: creditRemaining,
      // Legacy sum mirror stays in sync for back-compat readers.
      quotaBonus: creditRemaining + otherScopeMirror,
    }).catch(e => console.error("[relay] quota mirror display sync failed (non-fatal):", e));
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
