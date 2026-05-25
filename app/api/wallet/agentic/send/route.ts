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

import { requireAuth } from "@/app/lib/auth";
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
  // Mode A/B — owner EIP-191 session signature
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

  // ── Mode A/B — owner sig present ────────────────────────────────────────
  if (typeof body.signature === "string" && body.signature.length > 0) {
    const result = await requireAuth(
      body.ownerAddress ?? null,
      body.nonce ?? null,
      body.signature ?? null,
    );
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

  // Pick the most-restrictive apiKey for the chosen chain. Trial keys
  // are BNB-only, so on BNB they drain first; non-BNB chains require
  // the paid key.
  const apiKey =
    body.chain === "bnb"
      ? sub?.trialApiKey || sub?.apiKey
      : sub?.apiKey;
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
