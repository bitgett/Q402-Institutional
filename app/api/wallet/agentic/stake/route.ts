/**
 * POST /api/wallet/agentic/stake
 *
 * Gasless Q (QuackAI) staking / unstaking from a server-managed Agent Wallet
 * (Mode C, apiKey) into QuackAiStake on BNB. The server holds the AES-GCM-
 * wrapped key, signs a Stake/Unstake witness + an EIP-7702 authorization to the
 * deployed Q402StakingImplementationBNB, and the relayer pays gas.
 *
 * Q is BNB-only and EXEMPT from the wallet's USD limits (it's the owner's own
 * token) — staking is bounded by a per-day op count (relayer gas rail) + the
 * per-(wallet,chain) lock + a short idempotency window, NOT a USD cap.
 *
 * Body: { apiKey, action: "stake"|"unstake", stakeType?, amount, walletId? }
 */
import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ethers } from "ethers";

import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireIntentAuth } from "@/app/lib/auth";
import {
  decryptPrivateKey,
  isKeystoreReady,
  resolveWallet,
  acquireWalletChainLock,
  releaseWalletChainLock,
} from "@/app/lib/agentic-wallet";
import { getApiKeyRecord, getSubscription, hasMultichainScope } from "@/app/lib/db";
import {
  signStakeAction,
  stakeImplAddress,
  STAKE_TIERS,
  Q_TOKEN,
  type StakeAction,
} from "@/app/lib/staking/sign";
import { AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";
import { readStakePositions } from "@/app/lib/staking/positions";
import {
  settleStakeAction,
  stakeFacilitator,
  chargeStakeOpBudget,
  refundStakeOpBudget,
} from "@/app/lib/staking/relay";
import type { Address, Hex } from "viem";

export const runtime = "nodejs";
export const maxDuration = 60;

// 15 min: comfortably outlives a slow BNB settle so an in-flight claim can't
// expire mid-settlement (which would briefly weaken the double-stake guard).
const IDEM_TTL_SEC = 15 * 60;

interface StakeBody {
  // Mode C — server-mediated MCP path
  apiKey?: string;
  // Mode A/B — dashboard owner-sig (intent-bound challenge)
  ownerAddress?: string;
  nonce?: string;
  signature?: string;
  action?: string;
  stakeType?: number;
  amount?: string;
  /** Signed numeric ceiling for amount:"max" — the balance the user saw at
   *  sign time. The server stakes min(on-chain balance, cap), so it can never
   *  exceed what the user actually consented to. (stake only) */
  cap?: string;
  /** Unstake target: the 0-based record index to exit (QuackAiStake.exit(ith)).
   *  Per-record, all-or-nothing; MUST be >= 1 (index 0 is un-exitable). Resolve
   *  via GET /api/wallet/agentic/stake/positions. "Unstake all matured" is a
   *  client-side loop over the exitable indices. (unstake only) */
  ith?: number;
  walletId?: string;
}

function isPositiveDecimalString(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: StakeBody;
  try {
    body = (await req.json()) as StakeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-wallet-stake", 10, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // ── Validate shape ──────────────────────────────────────────────────────
  const action = body.action;
  if (action !== "stake" && action !== "unstake") {
    return NextResponse.json({ error: "INVALID_ACTION", message: 'action must be "stake" or "unstake".' }, { status: 400 });
  }
  const isStake = action === "stake";

  // STAKE: amount is a positive decimal OR the sentinel "max" (resolves to the
  // wallet's Q balance, capped by the signed cap). UNSTAKE: a record index `ith`
  // (exit(ith) is per-record, all-or-nothing); index 0 is un-exitable. "Unstake
  // all matured" is a client-side loop over the exitable indices, not a route mode.
  let amount = "";
  let isMax = false;
  let unstakeIth = 0;
  if (isStake) {
    isMax = body.amount === "max";
    if (!isMax && !isPositiveDecimalString(body.amount)) {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }
    amount = body.amount as string;
    // "max" must carry a numeric cap (the balance the user saw + signed) so the
    // server stakes min(on-chain balance, cap) — never more than was consented.
    if (isMax && !isPositiveDecimalString(body.cap)) {
      return NextResponse.json({ error: "MAX_CAP_REQUIRED", message: 'amount "max" requires a numeric cap.' }, { status: 400 });
    }
  } else {
    unstakeIth = Number(body.ith);
    if (!Number.isInteger(unstakeIth) || unstakeIth < 1) {
      return NextResponse.json({ error: "INVALID_ITH", message: "unstake requires a record index ith >= 1 (GET .../stake/positions). Index 0 is un-exitable." }, { status: 400 });
    }
  }
  const stakeType = isStake ? Number(body.stakeType ?? 0) : 0;
  if (isStake && !STAKE_TIERS.some((t) => t.stakeType === stakeType)) {
    return NextResponse.json(
      { error: "INVALID_STAKE_TYPE", message: `stakeType must be one of ${STAKE_TIERS.map((t) => t.stakeType).join(", ")}.`, tiers: STAKE_TIERS },
      { status: 400 },
    );
  }

  // The staking impl must be deployed (env wired).
  if (!stakeImplAddress("bnb")) {
    return NextResponse.json({ error: "staking_not_enabled", message: "Q staking is not enabled yet (impl unset)." }, { status: 503 });
  }
  const facilitator = stakeFacilitator();
  if (!facilitator) {
    return NextResponse.json({ error: "relay_unavailable" }, { status: 503 });
  }

  // ── Auth: Mode A/B (owner-sig intent) OR Mode C (apiKey) ──────────────────
  const requestedWalletId =
    typeof body.walletId === "string" && body.walletId.length > 0 ? body.walletId.toLowerCase() : null;
  const isOwnerSig = typeof body.signature === "string" && body.signature.length > 0;
  let owner: string;
  if (isOwnerSig) {
    // Mode A/B — dashboard. The intent binds to (walletId, action, stakeType,
    // amount) so a signature can't be replayed for a different stake.
    if (!requestedWalletId) {
      return NextResponse.json({ error: "walletId_required" }, { status: 400 });
    }
    const authResult = await requireIntentAuth({
      address: body.ownerAddress ?? null,
      challenge: body.nonce ?? null,
      signature: body.signature ?? null,
      action: "agentic.stake",
      intent: isStake
        ? { walletId: requestedWalletId, action, stakeType: String(stakeType), amount, ...(isMax ? { cap: body.cap as string } : {}) }
        : { walletId: requestedWalletId, action, ith: String(unstakeIth) },
    });
    if (typeof authResult !== "string") {
      return NextResponse.json({ error: authResult.error, code: authResult.code }, { status: authResult.status });
    }
    owner = authResult;
  } else {
    // Mode C — apiKey (MCP server-mediated path).
    const presented = typeof body.apiKey === "string" ? body.apiKey : "";
    if (!presented) {
      return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 401 });
    }
    if (presented.startsWith("q402_test_") || presented.startsWith("q402_sandbox_")) {
      return NextResponse.json({ error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for Agent Wallet staking." }, { status: 401 });
    }
    const rec = await getApiKeyRecord(presented);
    if (!rec || !rec.active || rec.isSandbox) {
      return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
    }
    owner = rec.address.toLowerCase();
    // Mode C must present the live multichain key, not a stale/rotated one.
    const subC = await getSubscription(owner);
    if (presented !== subC?.apiKey) {
      return NextResponse.json({ error: "STALE_API_KEY", message: "This apiKey is no longer the live multichain key. Rotate in your dashboard." }, { status: 401 });
    }
  }

  // Both modes: staking requires a paid Multichain plan.
  const sub = await getSubscription(owner);
  if (!hasMultichainScope(sub)) {
    return NextResponse.json({ error: "SUBSCRIPTION_REQUIRED", message: "Q staking requires a paid Multichain plan." }, { status: 402 });
  }

  // ── Wallet + keystore ─────────────────────────────────────────────────────
  const ready = isKeystoreReady();
  if (!ready.ok) {
    return NextResponse.json({ error: "keystore_unavailable" }, { status: 503 });
  }
  const wallet = await resolveWallet(owner, requestedWalletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  if (wallet.deletedAt && Date.now() >= wallet.deletedAt) {
    return NextResponse.json({ error: "AGENTIC_WALLET_ARCHIVED" }, { status: 410 });
  }
  const walletId = wallet.address.toLowerCase();

  // ── Idempotency window (avoid double-stake on a quick retry) ──────────────
  // Include the cap so two "max" calls with DIFFERENT caps (e.g. before vs after
  // a top-up) don't collide on one idempotency slot and block the second for 15m.
  const fpInput = isStake
    ? `${owner}:${walletId}:stake:${stakeType}:${amount}:${body.cap ?? ""}`
    : `${owner}:${walletId}:unstake:ith:${unstakeIth}`;
  const fp = ethers.keccak256(ethers.toUtf8Bytes(fpInput)).slice(2, 26);
  const idemKey = `aw:stake:${fp}`;
  const claimed = await kv.set(idemKey, { status: "processing", at: Date.now() }, { nx: true, ex: IDEM_TTL_SEC });
  if (!claimed) {
    const prior = await kv.get<{ status: string; txHash?: string }>(idemKey);
    return NextResponse.json(
      { status: prior?.status ?? "processing", txHash: prior?.txHash, idempotent: true, message: "An identical stake op is in flight or recently settled. Retry later or vary the amount." },
      { status: 200 },
    );
  }

  // ── Per-(wallet,chain) lock — serialize with sends/yield on the same wallet ─
  const lockToken = await acquireWalletChainLock(walletId, "bnb");
  if (!lockToken) {
    await kv.del(idemKey).catch(() => {});
    return NextResponse.json({ error: "WALLET_BUSY", message: "Another action on this wallet is in flight. Retry shortly." }, { status: 409 });
  }

  // ── Op-budget (relayer gas rail) ──────────────────────────────────────────
  const opBudget = await chargeStakeOpBudget(owner);
  const cleanup = async () => {
    await releaseWalletChainLock(walletId, "bnb", lockToken).catch(() => {});
    await kv.del(idemKey).catch(() => {});
    await refundStakeOpBudget(owner).catch(() => {});
  };
  if (!opBudget.allowed) {
    await cleanup();
    return NextResponse.json({ error: "STAKE_DAILY_OP_CAP", message: `Daily Q staking op cap reached (${opBudget.cap}/day). Retry tomorrow.`, cap: opBudget.cap }, { status: 429 });
  }

  // ── Sign + settle ─────────────────────────────────────────────────────────
  let privateKey: Hex;
  try {
    privateKey = decryptPrivateKey(wallet) as Hex;
  } catch {
    await cleanup();
    return NextResponse.json({ error: "key_decrypt_failed" }, { status: 503 });
  }

  // STAKE "max": resolve to min(on-chain Q balance, signed cap) at settle time —
  // reading on-chain (not a cached UI number) keeps it exact + never exceeds what
  // the user signed. UNSTAKE: validate the requested record is actually exitable
  // now, so we return a clear error instead of burning relayer gas on a revert.
  let settleAmount = amount;
  if (isStake && isMax) {
    try {
      const capRaw = ethers.parseUnits(body.cap as string, 18);
      const provider = new ethers.JsonRpcProvider(AGENTIC_CHAINS.bnb.rpc);
      const q = new ethers.Contract(Q_TOKEN, ["function balanceOf(address) view returns (uint256)"], provider);
      const availRaw = (await q.balanceOf(wallet.address)) as bigint;
      const useRaw = availRaw < capRaw ? availRaw : capRaw;
      if (useRaw <= 0n) {
        await cleanup();
        return NextResponse.json({ error: "INSUFFICIENT_Q", message: "No Q balance to stake." }, { status: 400 });
      }
      settleAmount = ethers.formatUnits(useRaw, 18);
    } catch (e) {
      await cleanup();
      return NextResponse.json({ error: "MAX_RESOLVE_FAILED", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  } else if (!isStake) {
    try {
      const { positions } = await readStakePositions(wallet.address);
      const pos = positions.find((p) => p.ith === unstakeIth);
      if (!pos) {
        await cleanup();
        return NextResponse.json({ error: "NO_SUCH_STAKE", message: `No active stake at index ${unstakeIth} (already exited or never existed).` }, { status: 400 });
      }
      if (!pos.exitable) {
        await cleanup();
        return NextResponse.json({ error: "NOT_MATURED", message: "This stake has not matured yet — it cannot be unstaked.", unlockAt: pos.unlockAt }, { status: 400 });
      }
    } catch (e) {
      await cleanup();
      return NextResponse.json({ error: "POSITIONS_READ_FAILED", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  let result;
  try {
    const signed = await signStakeAction({
      privateKey,
      expectedOwner: wallet.address as Address,
      chain: "bnb",
      action: action as StakeAction,
      stakeType,
      ...(isStake ? { amount: settleAmount } : { ith: unstakeIth }),
      facilitator,
    });
    result = await settleStakeAction(signed);
  } catch (e) {
    await cleanup();
    return NextResponse.json({ error: "stake_sign_failed", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  if (result.uncertain) {
    // Broadcast but unconfirmed — keep the idempotency claim + op-budget (do NOT
    // refund/clear), release only the lock, and tell the caller to verify.
    await releaseWalletChainLock(walletId, "bnb", lockToken).catch(() => {});
    await kv.set(idemKey, { status: "uncertain", txHash: result.txHash, at: Date.now() }, { ex: IDEM_TTL_SEC }).catch(() => {});
    return NextResponse.json(
      { status: "uncertain", txHash: result.txHash, message: "Broadcast but not confirmed — verify on-chain before retrying (a retry could double the stake)." },
      { status: 502 },
    );
  }

  if (!result.success) {
    // The tx WAS broadcast and reverted — the relayer already paid gas, so the
    // op-budget slot stays CONSUMED (mirrors yield; the cap bounds relayer gas
    // abuse incl. spammed reverts). Release the lock + clear the claim only.
    await releaseWalletChainLock(walletId, "bnb", lockToken).catch(() => {});
    await kv.del(idemKey).catch(() => {});
    return NextResponse.json({ error: "stake_failed", message: result.error ?? "Transaction reverted." }, { status: 502 });
  }

  // Success — mark idempotency settled, release the lock (keep the op-budget spent).
  await kv.set(idemKey, { status: "settled", txHash: result.txHash, at: Date.now() }, { ex: IDEM_TTL_SEC }).catch(() => {});
  await releaseWalletChainLock(walletId, "bnb", lockToken).catch(() => {});

  return NextResponse.json({
    status: "settled",
    action,
    chain: "bnb",
    ...(isStake ? { stakeType, amount: settleAmount } : { ith: unstakeIth }),
    txHash: result.txHash,
    walletId,
  });
}
