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
 * Phase 2 scope:
 *   - All 9 EVM chains. BNB is free during the trial; the remaining 8
 *     require an active multichain subscription (same `hasMultichainScope`
 *     gate as the canonical relay route).
 *   - Single recipient only — batch lives at /api/wallet/agentic/batch.
 *   - Auth: owner EIP-191 signature only. The API-key (MCP, mode C)
 *     path is gated to Phase 3 behind agentic-scoped keys.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/app/lib/auth";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
  isKeystoreReady,
  checkDailyLimit,
  recordDailySpend,
} from "@/app/lib/agentic-wallet";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
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
  ownerAddress?: string;
  nonce?: string;
  signature?: string;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isPositiveDecimalString(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}

async function resolveOwner(req: NextRequest, body: SendBody): Promise<string | NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-send", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

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
    return NextResponse.json(
      { error: "keystore_unavailable", detail: ready.reason },
      { status: 503 },
    );
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

  const limitCheck = await checkDailyLimit(owner, numAmount, wallet.dailyLimitUsd);
  if (!limitCheck.allowed) {
    return NextResponse.json(
      {
        error: "DAILY_LIMIT_EXCEEDED",
        limit: limitCheck.limit,
        spent: limitCheck.spent,
        requested: limitCheck.requested,
      },
      { status: 403 },
    );
  }

  // Subscription gate — BNB is open during the trial. Anything else
  // requires the multichain scope (paid plan or admin grant).
  const sub = await getSubscription(owner);
  if (body.chain !== "bnb" && !hasMultichainScope(sub)) {
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
    return NextResponse.json(
      { error: "NO_API_KEY", message: "Activate a Q402 trial or subscription before using your Agent Wallet." },
      { status: 402 },
    );
  }

  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
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
    console.error("[agentic-wallet/send] relay forward failed:", e);
    return NextResponse.json({ error: "relay_forward_failed" }, { status: 502 });
  }

  const relayBody = await relayResponse.json().catch(() => null);

  if (relayResponse.ok && relayBody && typeof relayBody === "object" && "txHash" in relayBody) {
    await recordDailySpend(owner, numAmount).catch(() => {});
  }

  return NextResponse.json(
    relayBody ?? { error: "relay_response_unreadable" },
    { status: relayResponse.status },
  );
}
