/**
 * POST /api/wallet/agentic/send
 *
 * Submit a single-recipient gasless payment from the caller's Agentic
 * Wallet. The server holds the wallet's private key (AES-GCM encrypted
 * in KV), so signing happens here — the client just names the chain,
 * token, recipient, and amount.
 *
 * Phase 1 MVP scope:
 *   - Single recipient only (batch lives at /api/wallet/agentic/batch).
 *   - BNB chain only. Multichain unlock follows the same `hasMultichainScope`
 *     gate as the existing /api/relay route in a later phase.
 *
 * Auth (either, not both):
 *   - Owner EIP-191 signature  → { ownerAddress, nonce, signature }
 *   - API key (MCP, mode C)    → { apiKey }
 *
 * Whichever path is taken, the wallet record's `ownerAddr` and the
 * resolved caller address must agree, and the wallet must not be
 * soft-deleted. Quota is billed against the resolved owner address using
 * their existing apiKey via the canonical /api/relay route.
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
} from "@/app/lib/agentic-wallet";
import { getApiKeyRecord, getSubscription, hasMultichainScope } from "@/app/lib/db";
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

  // Auth — provide either the EIP-191 trio (dashboard) …
  ownerAddress?: string;
  nonce?: string;
  signature?: string;

  // … or an apiKey (MCP server-mediated, mode C).
  apiKey?: string;
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
 * Resolve the caller's owner address from either auth mode.
 * Returns the lowercased owner address or a NextResponse to short-circuit.
 */
async function resolveOwner(
  req: NextRequest,
  body: SendBody,
): Promise<string | NextResponse> {
  if (body.apiKey) {
    const record = await getApiKeyRecord(body.apiKey);
    if (!record || !record.active) {
      return NextResponse.json(
        { error: "INVALID_API_KEY" },
        { status: 401 },
      );
    }
    return record.address.toLowerCase();
  }

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
  if (typeof wallet.perTxMaxUsd === "number") {
    const numAmount = Number(body.amount);
    if (Number.isFinite(numAmount) && numAmount > wallet.perTxMaxUsd) {
      return NextResponse.json(
        {
          error: "PER_TX_LIMIT_EXCEEDED",
          limit: wallet.perTxMaxUsd,
          requested: numAmount,
        },
        { status: 403 },
      );
    }
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

  // Pick the user's most-capable apiKey. Paid live key first; falls back to
  // the trial key on BNB. Sandbox keys are intentionally excluded — sandbox
  // signing through the Agentic Wallet is a Phase 3 feature.
  const apiKey = sub?.apiKey || sub?.trialApiKey;
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
  const amountRaw = ethers.parseUnits(body.amount as string, tokenCfg.decimals);
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
  return NextResponse.json(
    relayBody ?? { error: "relay_response_unreadable" },
    { status: relayResponse.status },
  );
}
