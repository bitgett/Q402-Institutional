/**
 * POST /api/wallet/agentic/clear-delegation
 *
 * Mode C "clear my Agent Wallet's EIP-7702 delegation" endpoint. The user
 * doesn't own the Agent Wallet's private key — the server does — so they
 * can't produce the signed authorization themselves. This endpoint:
 *
 *   1. Authenticates the owner via intent-bound EIP-191 sig
 *      (`agentic.clear_delegation` action, intent = { walletId, chain })
 *   2. Decrypts the Agent Wallet's PK server-side
 *   3. Signs an EIP-7702 authorization with `address = 0x0` using that PK
 *      and the Agent Wallet's current on-chain nonce
 *   4. Submits a type-0x04 transaction via `broadcastClear`, paid by the
 *      relayer hot wallet
 *
 * Why this exists: the Q402 payment impl contract has no `receive()` /
 * `fallback()`, so a delegated Agent Wallet rejects all native transfers
 * — including the CCIP auto-fund tx. Clearing the delegation reverts the
 * Agent Wallet back to a plain EOA that accepts native, lets the CCIP
 * bridge run, and then the next /send re-delegates the wallet on its own
 * via the existing type-4 flow in `signAgenticPayment`.
 *
 * Idempotency: the type-4 tx itself reverts on a nonce reuse — running
 * this twice in a row on an already-cleared wallet returns CLEAR_FAILED
 * with the receipt error. The route's own rate limit (1/h per owner)
 * keeps the relayer's exposure bounded.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { requireIntentAuth } from "@/app/lib/auth";
import {
  getActiveAgenticWallet,
  decryptPrivateKey,
} from "@/app/lib/agentic-wallet";
import {
  broadcastClear,
  recoverAuthorizationAddress,
  type SignedAuthorization,
} from "@/app/lib/eip7702";
import { AGENTIC_CHAINS, isAgenticChainKey } from "@/app/lib/agentic-wallet-sign";
import type { ChainKey } from "@/app/lib/relayer";
import {
  claimAndDebitNativeBridge,
  getGasBalance,
  setPendingClearDebit,
} from "@/app/lib/db";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { isCCIPChain } from "@/app/lib/ccip";

export const runtime = "nodejs";
export const maxDuration = 45;

interface ClearBody {
  address?:   string;  // owner EOA
  nonce?:     string;  // challenge
  signature?: string;  // EIP-191 sig over canonical message
  walletId?:  string;
  chain?:     string;  // chain on which to clear
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-clear-delegation", 5, 3600))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: ClearBody;
  try {
    body = (await req.json()) as ClearBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate before auth so the rebuilt intent matches what the user
  //    signed ──────────────────────────────────────────────────────────
  if (!body.walletId || typeof body.walletId !== "string") {
    return NextResponse.json({ error: "walletId_required" }, { status: 400 });
  }
  if (!body.chain || !isAgenticChainKey(body.chain)) {
    return NextResponse.json({ error: "INVALID_CHAIN" }, { status: 400 });
  }
  const chain = body.chain;
  const cfg = AGENTIC_CHAINS[chain];

  // ── Intent-bound auth ────────────────────────────────────────────────
  const authResult = await requireIntentAuth({
    address:   body.address ?? null,
    challenge: body.nonce ?? null,
    signature: body.signature ?? null,
    action:    "agentic.clear_delegation",
    intent: {
      walletId: body.walletId.toLowerCase(),
      chain,
    },
  });
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const owner = authResult;
  const walletId = body.walletId.toLowerCase();

  // ── Per-OWNER rate limit ────────────────────────────────────────────
  // The IP-level limit above (5/h per IP) doesn't close the case where a
  // single owner rotates IPs (VPN, cloud egress) and hammers sponsored
  // clears on non-CCIP chains where Q402 still pays gas. Cap each owner
  // address at 3/h so even with IP rotation the relayer drain is
  // bounded. CCIP chains debit from Gas Tank so they self-cap, but
  // sponsored chains do not — owner-level cap covers both for free.
  //
  // failOpen=true: this layer is defense-in-depth ONLY. The IP cap above
  // (fail-closed) is the primary control; the SETNX clear-lock + the
  // gas-tank debit are independent caps below. If KV is unavailable
  // here, blocking the user's recovery flow (delegation cleared then
  // can't bridge) is worse than the transient over-spend risk a KV
  // blip allows. The other two layers still bound the worst case.
  if (!(await rateLimit(`owner:${owner}`, "agentic-clear-delegation-owner", 3, 3600, true))) {
    return NextResponse.json(
      {
        error:   "RATE_LIMITED",
        message: "Too many clear-delegation requests from this wallet in the last hour. Retry later.",
      },
      { status: 429 },
    );
  }

  // ── Wallet lookup + decrypt ──────────────────────────────────────────
  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet) {
    return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  }
  const agenticPk = decryptPrivateKey(wallet);
  const agentAddr = wallet.address as Address;

  // ── Per-wallet × per-chain SETNX lock ────────────────────────────────
  // Two concurrent clear-delegation requests for the same (walletId, chain)
  // would race the on-chain nonce: the second tx reuses the nonce from the
  // first signAuthorization, gets rejected by EVM, but only after the
  // sponsor relayer pays inclusion gas on the failed type-4. The route's
  // IP-level rate limit (5/h) does NOT close this — a single dashboard
  // session can fire two requests faster than the in-flight one mines.
  //
  // 60s TTL covers the ~45s maxDuration plus a small grace window.
  // Lock is freed in `finally`. SETNX guarantees the second caller sees
  // CLEAR_IN_FLIGHT immediately instead of paying gas for nothing.
  const clearLockKey = `aw:clear-lock:${walletId}:${chain}`;
  const clearLockClaimed = await kv.set(clearLockKey, "1", { nx: true, ex: 60 });
  if (clearLockClaimed !== "OK") {
    return NextResponse.json(
      {
        error: "CLEAR_IN_FLIGHT",
        message: "A clear-delegation tx is already in flight for this wallet on this chain. Retry in ~60s.",
      },
      { status: 409 },
    );
  }

  try {
    return await runClear({ owner, walletId, chain, cfg, agentAddr, agenticPk });
  } finally {
    await kv.del(clearLockKey).catch(() => { /* best-effort lock release */ });
  }
}

interface RunClearArgs {
  owner:     string;
  walletId:  string;
  chain:     ChainKey;
  cfg:       (typeof AGENTIC_CHAINS)[ChainKey];
  agentAddr: Address;
  agenticPk: string;
}

async function runClear(args: RunClearArgs): Promise<NextResponse> {
  const { owner, walletId, chain, cfg, agentAddr, agenticPk } = args;

  // ── Probe current delegation state ──────────────────────────────────
  // If the wallet is already undelegated, return early — no on-chain
  // work to do, no relayer gas to spend, no error to surface to the user.
  const publicClient = createPublicClient({
    transport: http(cfg.rpc),
  });
  const code = await publicClient.getCode({ address: agentAddr }).catch(() => undefined);
  if (!code || code === "0x") {
    return NextResponse.json({
      alreadyCleared: true,
      address: agentAddr,
      chain,
      message: "Agent Wallet is not delegated — nothing to clear.",
    });
  }
  if (!code.toLowerCase().startsWith("0xef0100")) {
    // Bytecode present but not an EIP-7702 delegation marker → not
    // something we should touch.
    return NextResponse.json(
      { error: "AGENT_WALLET_NOT_DELEGATED", detail: "non-delegation bytecode" },
      { status: 409 },
    );
  }

  // ── Gas Tank pre-check (CCIP chains only) ───────────────────────────
  //
  // The clear-delegation tx is paid by the relayer hot wallet but the
  // outlay should land on the USER's Gas Tank — not Q402. Without this
  // gate every bridge-recovery clear would silently subsidise the user.
  // Estimate cost = ~60k gas × maxFeePerGas (60k = broadcastClear's
  // 50k headroom + a 20% buffer for the actual tx variance).
  //
  // Scope: only debit on chains we already have a native-bridge-usage
  // bucket for (eth/avax/arbitrum). On other chains the existing
  // sponsored behaviour stays for now — separate Gas Tank
  // attribution bucket would need to land first.
  const debitFromGasTank = isCCIPChain(chain);
  let estimatedClearGasEth = 0;
  if (debitFromGasTank) {
    const feeData = await publicClient.estimateFeesPerGas().catch(() => null);
    const probedMaxFeePerGas = feeData?.maxFeePerGas
      ?? (await publicClient.getBlock().then(b => (b.baseFeePerGas ?? 0n) * 2n).catch(() => 0n));
    const estimatedWei = probedMaxFeePerGas * 60_000n;
    estimatedClearGasEth = Number(estimatedWei) / 1e18;
    const gasBal = await getGasBalance(owner);
    const tankAvailEth = gasBal[chain] ?? 0;
    if (tankAvailEth < estimatedClearGasEth) {
      return NextResponse.json(
        {
          error:        "INSUFFICIENT_NATIVE_BALANCE",
          chain,
          requiredEth:  estimatedClearGasEth,
          availableEth: tankAvailEth,
          message:
            `Your Gas Tank native on ${chain} is short ${(estimatedClearGasEth - tankAvailEth).toFixed(6)} ` +
            `to cover the clear-delegation tx. Top up the Gas Tank and retry.`,
        },
        { status: 402 },
      );
    }
  }

  // ── Sign the clearing authorization (address = 0x0) ─────────────────
  const nonce = await publicClient.getTransactionCount({ address: agentAddr });
  const account = privateKeyToAccount(agenticPk as Hex);
  const auth = await account.signAuthorization({
    chainId: cfg.id,
    address: ZERO_ADDR as Address,
    nonce,
  });
  if (auth.yParity === undefined || auth.r === undefined || auth.s === undefined) {
    return NextResponse.json(
      { error: "AUTH_SIG_INCOMPLETE", detail: "signAuthorization returned partial signature" },
      { status: 500 },
    );
  }

  // ── Broadcast via the existing sponsored clear helper ───────────────
  const signedAuth: SignedAuthorization = {
    chainId: cfg.id,
    address: ZERO_ADDR,
    nonce:   nonce,
    yParity: auth.yParity as 0 | 1,
    r:       auth.r,
    s:       auth.s,
  };

  // ── Recover-and-match check ─────────────────────────────────────────
  // The EVM SILENTLY drops a bad authorization entry inside a type-0x04
  // tx — the sponsor still pays gas and the receipt looks "successful",
  // but the delegation is unchanged. If signAuthorization wedged (e.g.
  // it produced a v=0/v=1 mismatch, or the chainId/nonce/address args
  // got corrupted between sign and broadcast) the recover step here
  // catches that BEFORE we pay sponsor gas for nothing. Recovered
  // address must equal the Agent Wallet.
  try {
    const recovered = recoverAuthorizationAddress(signedAuth);
    if (recovered.toLowerCase() !== agentAddr.toLowerCase()) {
      return NextResponse.json(
        {
          error:     "AUTH_SIG_MISMATCH",
          detail:    "authorization recovered to a different address than the Agent Wallet",
          recovered: recovered.toLowerCase(),
          expected:  agentAddr.toLowerCase(),
        },
        { status: 500 },
      );
    }
  } catch (recErr) {
    const msg = recErr instanceof Error ? recErr.message : String(recErr);
    return NextResponse.json(
      { error: "AUTH_SIG_RECOVERY_FAILED", detail: msg.slice(0, 200) },
      { status: 500 },
    );
  }

  let result: Awaited<ReturnType<typeof broadcastClear>>;
  try {
    result = await broadcastClear(chain as ChainKey, agentAddr, signedAuth);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "CLEAR_FAILED", detail: msg.slice(0, 240) },
      { status: 502 },
    );
  }

  // ── finalCode invariant ─────────────────────────────────────────────
  // broadcastClear refetches getCode AFTER mining. If the sponsor tx
  // confirmed but the delegation didn't actually clear (nonce-stale
  // authorization, EVM dropped the auth entry silently, …), finalCode
  // stays non-`0x`. We MUST surface this to the user — silently
  // returning success means the dashboard says "cleared" while the
  // Agent Wallet is still delegated and the next bridge auto-fund will
  // revert again. We also page ops since the sponsor already paid gas
  // for a no-op — that's a relayer ETH leak that needs investigation.
  if (result.finalCode && result.finalCode !== "0x") {
    void sendOpsAlert(
      `<b>🚨 Clear-delegation MINED but delegation persists</b>\n\n` +
      `Owner: <code>${owner}</code>\n` +
      `Wallet: <code>${walletId}</code>\n` +
      `Chain: ${chain}\n` +
      `Agent Wallet: <code>${agentAddr}</code>\n` +
      `txHash: <code>${result.txHash}</code>\n` +
      `finalCode: <code>${result.finalCode.slice(0, 64)}</code>\n` +
      `Sponsor paid ${result.gasUsed} gas for a no-op clear.`,
      "error",
    ).catch(() => { /* best-effort */ });
    return NextResponse.json(
      {
        error:     "CLEAR_DID_NOT_APPLY",
        detail:    "sponsor tx confirmed but the Agent Wallet is still delegated; check ops alert",
        txHash:    result.txHash,
        finalCode: result.finalCode,
      },
      { status: 502 },
    );
  }

  // ── Debit actual gas from user's Gas Tank ──────────────────────────
  let actualClearGasEth = 0;
  if (debitFromGasTank) {
    try {
      // broadcastClear returns gasUsed as a string and writes back to the
      // chain so we can refetch the receipt for the effective gas price.
      const receipt = await publicClient.getTransactionReceipt({ hash: result.txHash as Hex });
      const gasUsedWei  = receipt.gasUsed ?? 0n;
      const gasPriceWei = receipt.effectiveGasPrice ?? 0n;
      const actualWei   = gasUsedWei * gasPriceWei;
      actualClearGasEth = Number(actualWei) / 1e18;
      if (actualClearGasEth > 0) {
        // Atomic claim + INCRBYFLOAT (Lua). The reconcile cron can
        // race here if `setPendingClearDebit` was written by an
        // earlier attempt that timed out after INCRBYFLOAT succeeded
        // but before the row was cleared. The Lua script makes claim
        // + debit a single atomic op so neither orphan-claim nor
        // double-debit is possible.
        await claimAndDebitNativeBridge(result.txHash, owner, chain, actualClearGasEth);
      }
    } catch (debitErr) {
      // Failed to fetch receipt OR record usage. Persist a pending-debit
      // row so the reconciliation cron can backfill the INCRBYFLOAT next
      // tick instead of relying solely on the ops Telegram message
      // (which can be missed / archived). We still page ops with the
      // full delta. We do NOT change the success response shape — the
      // on-chain clear already happened and the user expects to bridge.
      const err = debitErr instanceof Error ? debitErr.message : String(debitErr);
      await setPendingClearDebit({
        txHash:       result.txHash,
        estimatedEth: estimatedClearGasEth,
        ownerLc:      owner,
        chain,
        submittedAt:  Date.now(),
      }).catch((pendingErr) => {
        console.error("[clear-delegation] setPendingClearDebit failed", {
          owner, chain, txHash: result.txHash,
          err: pendingErr instanceof Error ? pendingErr.message : String(pendingErr),
        });
      });
      void sendOpsAlert(
        `<b>🚨 Clear-delegation gas debit FAILED — pending row written</b>\n\n` +
        `Owner: <code>${owner}</code>\n` +
        `Wallet: <code>${walletId}</code>\n` +
        `Chain: ${chain}\n` +
        `Agent Wallet: <code>${agentAddr}</code>\n` +
        `Clear txHash: <code>${result.txHash}</code>\n` +
        `Estimated cost: ${estimatedClearGasEth.toFixed(6)} ETH\n` +
        `Error: ${err.slice(0, 200)}\n\n` +
        `Reconcile cron will retry. Manual fix: INCRBYFLOAT ` +
        `bridge_native_used:${owner.toLowerCase()}.${chain} by the actual gas cost.`,
        "error",
      ).catch(() => { /* best-effort */ });
    }
  }

  return NextResponse.json({
    success:           true,
    txHash:            result.txHash,
    blockNumber:       result.blockNumber,
    gasUsed:           result.gasUsed,
    finalCode:         result.finalCode,
    address:           agentAddr,
    chain,
    // null on non-CCIP chains (sponsored), >0 when we debited the user.
    debitedEth:        debitFromGasTank ? actualClearGasEth : null,
    estimatedDebitEth: debitFromGasTank ? estimatedClearGasEth : null,
  });
}
