/**
 * POST /api/wallet/agentic/send
 *
 * Server-mediated single-recipient send from the caller's Agentic Wallet.
 * Q402 holds the wallet's AES-GCM-encrypted private key, so signing
 * happens on the server — the trust model differs from the canonical
 * /api/relay path (where the user signs locally). Callers should treat
 * this route as custody-lite: convenient, server-trusted, and bounded
 * by the wallet's per-wallet limits.
 *
 * Phase 3 scope:
 *   - All 9 EVM chains. BNB is free during the trial; the remaining 8
 *     require an active multichain subscription (same `hasMultichainScope`
 *     gate as the canonical relay route).
 *   - Single recipient only — batch lives at /api/wallet/agentic/batch.
 *   - Two auth modes:
 *       (1) owner EIP-191 signature  — dashboard + Mode A/B from MCP
 *       (2) apiKey                   — Mode C (server-mediated MCP), where
 *                                       the caller has only the apiKey, no
 *                                       private key. The apiKey's owner
 *                                       address must match `ownerAddress`.
 *     Sandbox keys (`q402_test_`) are rejected here — Agent Wallet sends
 *     must always settle on-chain.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireIntentAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
  isKeystoreReady,
  chargeAgainstDailyLimit,
  refundDailySpend,
} from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope, getApiKeyRecord } from "@/app/lib/db";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import {
  isAgenticChainKey,
  signAgenticPayment,
  submitToRelay,
  internalBaseUrl,
} from "@/app/lib/agentic-wallet-sign";
import type { Address, Hex } from "viem";

export const runtime = "nodejs";

interface SendBody {
  chain?: string;
  token?: string;
  to?: string;
  amount?: string;
  // Owner-sig path (Mode A/B in dashboard) — intent-bound challenge.
  // `nonce` is the action-challenge token issued by
  // /api/auth/action-challenge (NOT the session nonce). `signature`
  // signs the canonical intent message rebuilt server-side from the
  // intent fields below. A successful verify atomically consumes the
  // challenge, so re-submitting the same body fails NONCE_EXPIRED —
  // that is *also* the single-send idempotency guard.
  ownerAddress?: string;
  nonce?: string;
  signature?: string;
  // Mode C — server-mediated, MCP holds only the apiKey
  apiKey?: string;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isPositiveDecimalString(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}

/**
 * Resolve the owner address from either an EIP-191 signature (Mode A/B)
 * or an apiKey (Mode C). Returns the lowercased owner string on success,
 * or a 4xx NextResponse on auth failure.
 */
async function resolveOwner(req: NextRequest, body: SendBody): Promise<string | NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-send", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // ── Mode A/B — owner sig present, intent-bound challenge required ─────
  // We refuse the legacy "session signature" path here. Fund-moving
  // routes MUST receive a one-time challenge signed over the exact
  // canonical intent (chain | token | recipient | amount | wallet).
  // That single change closes two findings at once: (a) a session
  // signature stolen from localStorage cannot fire a payment, and
  // (b) the single-use challenge IS the idempotency guard — replaying
  // the same signed body returns NONCE_EXPIRED instead of a second
  // settlement.
  if (typeof body.signature === "string" && body.signature.length > 0) {
    if (
      !isAgenticChainKey(body.chain) ||
      (body.token !== "USDC" && body.token !== "USDT") ||
      !isHexAddress(body.to) ||
      !isPositiveDecimalString(body.amount)
    ) {
      // The intent fields are also checked at the top of POST, but we
      // rebuild the canonical message HERE so the auth path doesn't
      // depend on later validation order. Fail closed.
      return NextResponse.json({ error: "INVALID_INTENT_FOR_AUTH" }, { status: 400 });
    }
    const result = await requireIntentAuth({
      address: body.ownerAddress ?? null,
      challenge: body.nonce ?? null,
      signature: body.signature ?? null,
      action: "agentic.send",
      intent: {
        chain: body.chain,
        token: body.token,
        recipient: body.to.toLowerCase(),
        amount: body.amount,
      },
    });
    if (typeof result !== "string") {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }
    return result;
  }

  // ── Mode C — server-mediated via apiKey ────────────────────────────────
  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    // Sandbox keys fabricate txHashes on the relay — never what an Agent
    // Wallet caller wants. Reject up front.
    if (body.apiKey.startsWith("q402_test_")) {
      return NextResponse.json(
        { error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for Agent Wallet sends." },
        { status: 401 },
      );
    }
    const rec = await getApiKeyRecord(body.apiKey);
    if (!rec || !rec.active) {
      return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
    }
    // ownerAddress is optional in Mode C — when supplied it's just a
    // double-check that the caller knows whose wallet it is. When
    // omitted we derive it from the apiKey itself.
    if (typeof body.ownerAddress === "string" && body.ownerAddress.length > 0) {
      if (!isHexAddress(body.ownerAddress)) {
        return NextResponse.json({ error: "INVALID_OWNER" }, { status: 400 });
      }
      if (rec.address.toLowerCase() !== body.ownerAddress.toLowerCase()) {
        return NextResponse.json(
          { error: "OWNER_MISMATCH", message: "apiKey is not bound to the supplied ownerAddress." },
          { status: 403 },
        );
      }
    }
    return rec.address.toLowerCase();
  }

  return NextResponse.json(
    { error: "AUTH_REQUIRED", message: "Provide either an EIP-191 signature or an apiKey." },
    { status: 401 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  if (body.token !== "USDC" && body.token !== "USDT") {
    return NextResponse.json({ error: "INVALID_TOKEN" }, { status: 400 });
  }
  if (!isHexAddress(body.to)) {
    return NextResponse.json({ error: "INVALID_RECIPIENT" }, { status: 400 });
  }
  if (!isPositiveDecimalString(body.amount)) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }

  const owner = await resolveOwner(req, body);
  if (owner instanceof NextResponse) return owner;

  const ready = isKeystoreReady();
  if (!ready.ok) {
    // Detail intentionally absent from the client body — the operator
    // sees the underlying reason in server logs via isKeystoreReady,
    // the caller only learns the surface is unavailable.
    console.error("[agentic-wallet/send] keystore unavailable:", ready.reason);
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }

  const wallet = await getActiveAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json(
      {
        error: "AGENTIC_WALLET_NOT_FOUND",
        message: "Create an Agent Wallet in your dashboard before calling /send.",
      },
      { status: 404 },
    );
  }

  const numAmount = Number(body.amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  if (typeof wallet.perTxMaxUsd === "number" && numAmount > wallet.perTxMaxUsd) {
    return NextResponse.json(
      { error: "PER_TX_LIMIT_EXCEEDED", limit: wallet.perTxMaxUsd, requested: numAmount },
      { status: 403 },
    );
  }

  // Atomic budget reservation. If the relay fails downstream we refund
  // explicitly so the budget releases.
  const reservation = await chargeAgainstDailyLimit(owner, numAmount, wallet.dailyLimitUsd);
  if (!reservation.allowed) {
    return NextResponse.json(
      {
        error: "DAILY_LIMIT_EXCEEDED",
        limit: reservation.limit,
        spent: reservation.spent,
        requested: reservation.requested,
      },
      { status: 403 },
    );
  }
  const refundIfHeld = async () => {
    await refundDailySpend(owner, numAmount).catch(() => {});
  };

  // Subscription gate — BNB is open during the trial. Anything else
  // requires the multichain scope (paid plan or admin grant).
  const sub = await getSubscription(owner);
  if (body.chain !== "bnb" && !hasMultichainScope(sub)) {
    await refundIfHeld();
    return NextResponse.json(
      { error: "SUBSCRIPTION_REQUIRED", message: "Multichain access requires a paid subscription." },
      { status: 402 },
    );
  }

  // ── apiKey resolution: Mode C uses the presented key, dashboard
  //     (owner-sig) uses sub's auto-pick ───────────────────────────────
  // The original auto-pick (`trialApiKey || apiKey` for BNB,
  // `apiKey` for non-BNB) silently substituted the relay-time key for
  // whatever the caller presented. That had two consequences:
  //
  //  1. Rotation hole — a stale apiKey that was still active in KV
  //     could pass Mode C owner-auth, after which the route would
  //     drain the user's *current* paid quota. Closed by the
  //     freshness check.
  //
  //  2. Scope escalation — a trial apiKey (BNB-only at /api/relay)
  //     presented via Mode C for a non-BNB chain would pass freshness
  //     and then ride the user's *paid* key through relay. Closes the
  //     paid-quota drain even when the freshness check passes.
  //
  // We now demand: the presented Mode C key IS the key sent to relay.
  // No substitution. Scope is enforced by what the presented key can
  // actually settle — trial-on-non-BNB is rejected here so the user
  // gets a clean 402 instead of a relay-side 400.
  let apiKey: string | undefined;
  if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
    const presented = body.apiKey;
    const isTrial = presented === sub?.trialApiKey;
    const isPaid = presented === sub?.apiKey;
    if (!isTrial && !isPaid) {
      await refundIfHeld();
      return NextResponse.json(
        {
          error: "STALE_API_KEY",
          message:
            "This apiKey is no longer the live trial or multichain key. " +
            "Rotate to the current key in your dashboard and retry.",
        },
        { status: 401 },
      );
    }
    // Trial keys can settle BNB only. Reject any other chain even if
    // freshness passes, so the presented key's scope determines what
    // actually moves.
    if (isTrial && body.chain !== "bnb") {
      await refundIfHeld();
      return NextResponse.json(
        {
          error: "TRIAL_BNB_ONLY",
          message:
            "Trial apiKeys can only settle on BNB Chain. Present the " +
            "Multichain key (or omit apiKey + sign the owner challenge) " +
            "for non-BNB sends.",
        },
        { status: 402 },
      );
    }
    apiKey = presented;
  } else {
    // Owner-sig path (Mode A/B from dashboard / MCP). Keep the
    // auto-pick semantics that existing dashboard flows expect.
    apiKey =
      body.chain === "bnb"
        ? sub?.trialApiKey || sub?.apiKey
        : sub?.apiKey;
  }

  if (!apiKey) {
    await refundIfHeld();
    return NextResponse.json(
      { error: "NO_API_KEY", message: "Activate a Q402 trial or subscription before using your Agent Wallet." },
      { status: 402 },
    );
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    await refundIfHeld();
    return NextResponse.json({ error: "relay_unavailable" }, { status: 503 });
  }

  // Server-side sign for the chosen chain.
  const pk = decryptPrivateKey(wallet);
  let signed;
  try {
    signed = await signAgenticPayment({
      privateKey: pk as Hex,
      chain: body.chain,
      token: body.token,
      to: body.to as Address,
      amount: body.amount,
      facilitator: relayerKey.address as Address,
    });
  } catch (e) {
    await refundIfHeld();
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AMOUNT_PRECISION_TOO_HIGH") {
      return NextResponse.json(
        { error: "AMOUNT_PRECISION_TOO_HIGH", message: `Amount has more decimals than ${body.token} supports.` },
        { status: 400 },
      );
    }
    if (msg === "INVALID_AMOUNT") {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }
    console.error("[agentic-wallet/send] signing failed:", e);
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }

  let relayResponse: Response;
  try {
    relayResponse = await submitToRelay(internalBaseUrl(), apiKey, signed);
  } catch (e) {
    await refundIfHeld();
    console.error("[agentic-wallet/send] relay forward failed:", e);
    return NextResponse.json({ error: "relay_forward_failed" }, { status: 502 });
  }

  const relayBody = await relayResponse.json().catch(() => null);
  const success =
    relayResponse.ok && relayBody && typeof relayBody === "object" && "txHash" in relayBody;
  // Refund the reservation when the relay didn't actually settle.
  if (!success) {
    await refundIfHeld();
  }

  return NextResponse.json(
    relayBody ?? { error: "relay_response_unreadable" },
    { status: relayResponse.status },
  );
}
