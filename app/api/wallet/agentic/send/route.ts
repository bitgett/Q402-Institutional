/**
 * POST /api/wallet/agentic/send
 *
 * Server-mediated send from the caller's Agentic Wallet. Because Q402
 * holds the wallet's AES-GCM-encrypted private key in this flow, signing
 * happens on the server — the trust model differs from the canonical
 * /api/relay path (where the user signs locally). Callers should treat
 * this route as custody-lite: convenient, server-trusted, and bounded by
 * the wallet's per-wallet limits.
 *
 * Phase 1 MVP scope:
 *   - Single recipient only (batch lives at /api/wallet/agentic/batch).
 *   - BNB chain only. Multichain unlock follows `hasMultichainScope` in
 *     a later phase.
 *   - Auth: **owner EIP-191 signature only**. The API-key (MCP, mode C)
 *     path is intentionally NOT enabled in Phase 1 — a leaked apiKey
 *     would otherwise grant spend authority over the agentic wallet
 *     without any wallet-side confirmation. Phase 3 reintroduces that
 *     path behind agentic-scoped keys + enforced limits + allowlists.
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

export const runtime = "nodejs";

// ── Chain config (kept local — MVP is BNB-only) ────────────────────────────
// Mirrors contracts.manifest.json for BNB. Later phases will switch to a
// shared chain-config loader that covers all 9 chains.

const BNB = {
  key: "bnb" as const,
  id: 56,
  name: "BNB Chain",
  rpc: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
  impl: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa" as Address,
  domainName: "Q402 BNB Chain",
  domainVersion: "1",
  tokens: {
    USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address, decimals: 18 },
    USDT: { address: "0x55d398326f99059fF775485246999027B3197955" as Address, decimals: 18 },
  } as const,
} as const;

type SupportedToken = keyof typeof BNB.tokens;

const TRANSFER_AUTH_TYPES = {
  TransferAuthorization: [
    { name: "owner",       type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token",       type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "uint256" },
    { name: "deadline",    type: "uint256" },
  ],
} as const;

const DEADLINE_SECONDS_AHEAD = 600;

// ── Body / validation ──────────────────────────────────────────────────────

interface SendBody {
  /** Required: chain key (MVP only accepts "bnb"). */
  chain?: string;
  /** Required: "USDC" | "USDT". */
  token?: string;
  /** Required: recipient EOA. */
  to?: string;
  /** Required: human-readable amount as a decimal string (e.g. "1.50"). */
  amount?: string;

  // Auth — owner EIP-191 trio only in Phase 1.
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

/** Cryptographically-random uint256 nonce for the EIP-712 witness. */
function randomUint256Nonce(): bigint {
  const bytes = ethers.randomBytes(32);
  return BigInt(ethers.hexlify(bytes));
}

/**
 * Resolve the caller's owner address via the owner EIP-191 signature.
 * Returns the lowercased owner address or a NextResponse to short-circuit.
 *
 * Phase 1: signature-only. apiKey-mode is gated on Phase 3 work.
 */
async function resolveOwner(
  req: NextRequest,
  body: SendBody,
): Promise<string | NextResponse> {
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

// ── POST ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Chain / token / shape ────────────────────────────────────────────────
  if (body.chain !== "bnb") {
    return NextResponse.json(
      {
        error: "CHAIN_NOT_SUPPORTED",
        message: "Agentic Wallet MVP currently supports BNB Chain only. Multichain unlocks with a paid subscription.",
      },
      { status: 400 },
    );
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

  // ── Auth ─────────────────────────────────────────────────────────────────
  const owner = await resolveOwner(req, body);
  if (owner instanceof NextResponse) return owner;

  // ── Keystore pre-flight ──────────────────────────────────────────────────
  const ready = isKeystoreReady();
  if (!ready.ok) {
    return NextResponse.json(
      { error: "keystore_unavailable", detail: ready.reason },
      { status: 503 },
    );
  }

  // ── Wallet load ──────────────────────────────────────────────────────────
  const wallet = await getActiveAgenticWallet(owner);
  if (!wallet) {
    return NextResponse.json(
      {
        error: "AGENTIC_WALLET_NOT_FOUND",
        message: "Create an Agentic Wallet in your dashboard before calling /send.",
      },
      { status: 404 },
    );
  }

  // ── Per-tx max guard (if configured) ─────────────────────────────────────
  const numAmount = Number(body.amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  if (typeof wallet.perTxMaxUsd === "number" && numAmount > wallet.perTxMaxUsd) {
    return NextResponse.json(
      {
        error: "PER_TX_LIMIT_EXCEEDED",
        limit: wallet.perTxMaxUsd,
        requested: numAmount,
      },
      { status: 403 },
    );
  }

  // ── Daily cap (enforced) ────────────────────────────────────────────────
  // Reads today's UTC running spend from KV and rejects if this TX would
  // overflow the configured cap. Recorded post-relay so a failed/skipped
  // send doesn't consume the budget.
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

  // ── Subscription gate ────────────────────────────────────────────────────
  // BNB chain works for everyone in MVP. The shape mirrors the gate in the
  // canonical relay route so a later refactor can swap them out 1:1.
  const sub = await getSubscription(owner);
  if (body.chain !== "bnb" && !hasMultichainScope(sub)) {
    return NextResponse.json(
      { error: "SUBSCRIPTION_REQUIRED", message: "Multichain access requires a paid subscription." },
      { status: 402 },
    );
  }

  // Pick the user's most-restrictive apiKey for the requested chain. Trial
  // keys are BNB-only, so on BNB we prefer them — the paid pool only drains
  // after the trial allotment is exhausted (or the trial window expired).
  // On non-BNB chains (Phase 2+), the paid key is mandatory.
  const apiKey =
    body.chain === "bnb"
      ? sub?.trialApiKey || sub?.apiKey
      : sub?.apiKey;
  if (!apiKey) {
    return NextResponse.json(
      { error: "NO_API_KEY", message: "Activate a Q402 trial or subscription before using your Agentic Wallet." },
      { status: 402 },
    );
  }

  // ── Facilitator ──────────────────────────────────────────────────────────
  const relayerKey = loadRelayerKey();
  if (!relayerKey.ok) {
    return NextResponse.json({ error: "relay_unavailable" }, { status: 503 });
  }
  const facilitator = relayerKey.address;

  // ── Server-side signing ──────────────────────────────────────────────────
  const tokenCfg = BNB.tokens[body.token as SupportedToken];
  let amountRaw: bigint;
  try {
    amountRaw = ethers.parseUnits(body.amount as string, tokenCfg.decimals);
  } catch {
    return NextResponse.json(
      {
        error: "AMOUNT_PRECISION_TOO_HIGH",
        message: `Amount has more decimal places than ${body.token} supports (${tokenCfg.decimals}).`,
      },
      { status: 400 },
    );
  }
  if (amountRaw <= 0n) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  const nonceUint = randomUint256Nonce();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS_AHEAD);

  const pk = decryptPrivateKey(wallet);
  const account = privateKeyToAccount(pk);
  const walletAddr = account.address as Address;

  const viemChain = {
    id: BNB.id,
    name: BNB.name,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [BNB.rpc] } },
  } as const;

  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(BNB.rpc) });
  const publicClient = createPublicClient({ chain: viemChain, transport: http(BNB.rpc) });

  const witnessSig = (await walletClient.signTypedData({
    domain: {
      name: BNB.domainName,
      version: BNB.domainVersion,
      chainId: BNB.id,
      verifyingContract: walletAddr,
    },
    types: TRANSFER_AUTH_TYPES,
    primaryType: "TransferAuthorization",
    message: {
      owner: walletAddr,
      facilitator: facilitator as Address,
      token: tokenCfg.address,
      recipient: body.to as Address,
      amount: amountRaw,
      nonce: nonceUint,
      deadline,
    },
  })) as Hex;

  const txNonce = await publicClient.getTransactionCount({ address: walletAddr });
  const authorization = await account.signAuthorization({
    chainId: BNB.id,
    address: BNB.impl,
    nonce: txNonce,
  });

  // ── Forward to /api/relay (canonical settlement path) ────────────────────
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${process.env.PORT ?? 3000}`);

  let relayResponse: Response;
  try {
    relayResponse = await fetch(`${baseUrl}/api/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        chain: body.chain,
        token: body.token,
        from: walletAddr,
        to: body.to,
        amount: body.amount,
        nonce: nonceUint.toString(),
        deadline: deadline.toString(),
        witnessSig,
        authorization: {
          chainId: authorization.chainId,
          address: authorization.address,
          nonce: authorization.nonce,
          yParity: authorization.yParity,
          r: authorization.r,
          s: authorization.s,
        },
      }),
    });
  } catch (e) {
    console.error("[agentic-wallet/send] relay forward failed:", e);
    return NextResponse.json({ error: "relay_forward_failed" }, { status: 502 });
  }

  const relayBody = await relayResponse.json().catch(() => null);

  // Persist today's running spend only on a successful settlement. A
  // 4xx/5xx relay response means no funds moved — the next attempt
  // gets the same budget back. Failures here are best-effort.
  if (relayResponse.ok && relayBody && typeof relayBody === "object" && "txHash" in relayBody) {
    await recordDailySpend(owner, numAmount).catch(() => {});
  }

  return NextResponse.json(
    relayBody ?? { error: "relay_response_unreadable" },
    { status: relayResponse.status },
  );
}
