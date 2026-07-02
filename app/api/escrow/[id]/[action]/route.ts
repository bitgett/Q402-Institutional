import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  getEscrow, markEscrowLocked, markEscrowDisputed, markEscrowSettled,
  acquireEscrowActionLock, releaseEscrowActionLock,
  getEscrowSettledMarker, writeEscrowSettledMarker,
  getEscrowLockedMarker, writeEscrowLockedMarker, toPublicEscrow,
  type EscrowOutcome,
} from "@/app/lib/escrow";
import { ESCROW_ENABLED, getEscrowChain, type EscrowChainCfg } from "@/app/lib/escrow-contracts";
import {
  escrowFacilitator, settleEscrowLock, settleEscrowRelease, settleEscrowRefund,
  settleEscrowDispute, settleEscrowResolve, readEscrowOnchainState,
  type LockParams, type Authorization,
} from "@/app/lib/escrow-relayer";
import { requireIntentAuth } from "@/app/lib/auth";
import { getApiKeyRecord } from "@/app/lib/db";
import {
  getActiveAgenticWallet, decryptPrivateKey, chargeAgainstDailyLimit, refundDailySpend,
  acquireWalletChainLock, releaseWalletChainLock,
  type AgenticWalletRecord,
} from "@/app/lib/agentic-wallet";
import { signEscrowLockWithKey, signEscrowVaultActionWithKey } from "@/app/lib/escrow-agentic-sign";
import type { EscrowRecord } from "@/app/lib/escrow";

/**
 * POST /api/escrow/[id]/{lock|release|refund|dispute|resolve}
 *
 * Broadcasts an escrow state transition via the relayer (gas-sponsored). The
 * on-chain signatures are the authority; this route only relays what they allow,
 * and reads every fund-affecting field (vault, token, amount, seller, arbiter)
 * from the STORED record + the on-chain config, never from the client. A SET NX
 * action lock serializes; a durable settled marker blocks a re-settle.
 *
 * ENV-gated (ESCROW_ENABLED) + only chains with a deployed vault (getEscrowChain)
 * are live, so this cannot touch production payment paths.
 */

export const runtime = "nodejs";

const ACTIONS = new Set(["lock", "release", "refund", "dispute", "resolve"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  if (!ESCROW_ENABLED) {
    return NextResponse.json({ error: "Escrow relay is not enabled" }, { status: 503 });
  }
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "escrow-action", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id, action } = await ctx.params;
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 404 });
  }

  let body: {
    witnessSig?: string; authorization?: Authorization; sig?: string;
    nonce?: string; deadline?: string | number; toSeller?: boolean;
    // Agent-Wallet-funded (server-signed) path auth: apiKey (Mode C, lock only)
    // or an intent-bound owner signature (address + challenge + signature).
    apiKey?: string; address?: string; challenge?: string; signature?: string;
  };
  try { body = await req.json(); } catch { body = {}; }

  const rec = await getEscrow(id);
  if (!rec) return NextResponse.json({ error: "Escrow not found", notFound: true }, { status: 404 });

  // A sandbox (q402_test_) record must NEVER drive a real on-chain broadcast —
  // there is no fabricated-tx simulation for escrow, so sandbox keys can create
  // + read records but cannot move funds. (Mirrors the sandbox boundary the
  // payment relay enforces.)
  if (rec.sandbox) {
    return NextResponse.json({ error: "Sandbox escrows cannot broadcast on-chain actions" }, { status: 400 });
  }

  const cfg = getEscrowChain(rec.chain);
  if (!cfg) {
    return NextResponse.json({ error: `Escrow is not live on chain '${rec.chain}'` }, { status: 400 });
  }

  const deadline = body.deadline != null ? String(body.deadline) : "";
  const eid = rec.onchainEscrowId;

  // A settled escrow can't be re-settled (durable guard mirrors payment-request).
  if ((action === "release" || action === "refund" || action === "resolve")) {
    const prior = await getEscrowSettledMarker(id);
    if (prior) {
      return NextResponse.json({ error: "Escrow already settled", txHash: prior.txHash, outcome: prior.outcome }, { status: 409 });
    }
  }

  // Agent-Wallet-funded escrow: the buyer is a server-managed Agent Wallet the
  // owner controls, so the SERVER signs lock/release/dispute on its behalf
  // (owner-authenticated). The discriminator is the STORED rec.fundingWalletId,
  // never a client field. Refund stays permissionless and resolve is
  // arbiter-signed, so both fall through to the client-signed path below.
  if (rec.fundingWalletId && (action === "lock" || action === "release" || action === "dispute")) {
    return handleAgentFundedAction(rec, cfg, action, body);
  }

  if (!(await acquireEscrowActionLock(id))) {
    return NextResponse.json({ error: "An action for this escrow is already in progress" }, { status: 409 });
  }
  let releaseOnExit = true;
  try {
    // ── LOCK (7702) ─────────────────────────────────────────────────────────
    if (action === "lock") {
      if (rec.status !== "pending") return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });
      // Idempotency + F4 self-heal: if a lock already landed on-chain (durable
      // marker present) but the record is still `pending` (a lost status flip),
      // reconcile instead of broadcasting a SECOND lock (which would revert
      // EscrowExists and waste relayer gas).
      const priorLock = await getEscrowLockedMarker(id);
      if (priorLock) {
        await markEscrowLocked(id, priorLock.txHash);
        return NextResponse.json({ status: "open", txHash: priorLock.txHash, reconciled: true, escrow: toPublicEscrow((await getEscrow(id))!) });
      }
      // F4 hardening: no marker, but if the escrow already exists ON-CHAIN a prior
      // lock landed while BOTH the marker + status writes were lost (KV outage).
      // Reconcile from chain truth instead of re-broadcasting (which would revert
      // EscrowExists) — this is what heals the "funds locked, record stuck" case.
      const onchain = await readEscrowOnchainState(rec.chain, eid);
      if (onchain === 1) {
        // Reconcile from chain truth. We DON'T have the original lock tx hash
        // here (its record write was lost), so leave lockTxHash empty rather than
        // stamping a fake "reconciled" string that would surface as a broken
        // explorer link / corrupt the receipt.
        const recoveredHash = rec.lockTxHash ?? "";
        await writeEscrowLockedMarker(id, { txHash: recoveredHash, lockedAt: new Date().toISOString() }, rec.expiresAt);
        await markEscrowLocked(id, recoveredHash);
        return NextResponse.json({ status: "open", reconciled: "onchain", escrow: toPublicEscrow((await getEscrow(id))!) });
      }
      if (onchain !== null && onchain !== 0) {
        return NextResponse.json({ error: `Escrow already exists on-chain (state ${onchain}); cannot re-lock`, onchainState: onchain }, { status: 409 });
      }
      if (!body.witnessSig || !body.authorization || !body.nonce || !deadline) {
        return NextResponse.json({ error: "lock needs { witnessSig, authorization, nonce, deadline }" }, { status: 400 });
      }
      const facilitator = escrowFacilitator(rec.chain);
      if (!facilitator) return NextResponse.json({ error: "escrow relayer not configured" }, { status: 503 });
      // Server-derived params (tamper-safe) — client supplies only nonce/deadline/sig/auth.
      const p: LockParams = {
        buyer: rec.buyer, seller: rec.seller, vault: cfg.vault, token: cfg.tokens[rec.token],
        amount: ethers.parseUnits(rec.amount, cfg.decimals).toString(),
        salt: rec.salt, releaseDeadline: String(Math.floor(new Date(rec.releaseDeadline).getTime() / 1000)),
        arbiter: rec.arbiter ?? ethers.ZeroAddress, facilitator,
        nonce: String(body.nonce), deadline,
      };
      const r = await settleEscrowLock(rec.chain, p, body.witnessSig, body.authorization);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
      // Durable locked marker BEFORE the status flip: funds are now in the vault,
      // so even if markEscrowLocked's write is lost the escrow is reconciled from
      // this marker. CHECK both writes: if BOTH fail (KV outage) the funds are
      // locked on-chain but the record is stuck — hold the action lock so a retry
      // reconciles from on-chain state (above), and do NOT report a clean success.
      const lockedOk = await writeEscrowLockedMarker(id, { txHash: r.txHash, lockedAt: new Date().toISOString() }, rec.expiresAt);
      let flippedOk = false;
      try { flippedOk = !!(await markEscrowLocked(id, r.txHash)); } catch { flippedOk = false; }
      if (!lockedOk && !flippedOk) {
        releaseOnExit = false; // keep the lock; retry heals from chain truth
        return NextResponse.json({ status: "open", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash, warning: "locked on-chain but the record write failed; retry to reconcile (funds are safe)" });
      }
      return NextResponse.json({ status: "open", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash, escrow: toPublicEscrow((await getEscrow(id))!) });
    }

    // ── DISPUTE ─────────────────────────────────────────────────────────────
    if (action === "dispute") {
      if (rec.status !== "open") return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });
      if (!body.sig || !body.nonce || !deadline) return NextResponse.json({ error: "dispute needs { sig, nonce, deadline }" }, { status: 400 });
      const r = await settleEscrowDispute(rec.chain, eid, String(body.nonce), deadline, body.sig);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
      await markEscrowDisputed(id, r.txHash);
      return NextResponse.json({ status: "disputed", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash });
    }

    // ── RELEASE / REFUND / RESOLVE (terminal payouts) ───────────────────────
    let outcome: EscrowOutcome;
    let r: Awaited<ReturnType<typeof settleEscrowRelease>>;
    if (action === "release") {
      if (rec.status !== "open") return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });
      if (!body.sig || !body.nonce || !deadline) return NextResponse.json({ error: "release needs { sig, nonce, deadline }" }, { status: 400 });
      outcome = "release";
      r = await settleEscrowRelease(rec.chain, eid, String(body.nonce), deadline, body.sig);
    } else if (action === "refund") {
      if (rec.status !== "open" && rec.status !== "disputed") {
        return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });
      }
      outcome = "refund";
      r = await settleEscrowRefund(rec.chain, eid);
    } else {
      // resolve
      if (rec.status !== "disputed") return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });
      if (!body.sig || !body.nonce || !deadline || typeof body.toSeller !== "boolean") {
        return NextResponse.json({ error: "resolve needs { sig, nonce, deadline, toSeller }" }, { status: 400 });
      }
      outcome = body.toSeller ? "resolve-seller" : "resolve-buyer";
      r = await settleEscrowResolve(rec.chain, eid, body.toSeller, String(body.nonce), deadline, body.sig);
    }
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });

    // Durable settled marker BEFORE the status flip (funds already moved).
    const durable = await writeEscrowSettledMarker(id, { outcome, txHash: r.txHash, settledAt: new Date().toISOString() }, rec.expiresAt);
    if (!durable) releaseOnExit = false; // keep the lock; a retry could re-settle
    await markEscrowSettled(id, { outcome, txHash: r.txHash });
    releaseOnExit = false;
    return NextResponse.json({ status: outcome, txHash: r.txHash, explorer: cfg.explorerTx + r.txHash });
  } finally {
    if (releaseOnExit) await releaseEscrowActionLock(id);
  }
}

/** Random 64-bit nonce as a decimal string — unique per (signer, escrowId). */
function randEscrowNonce(): string {
  return BigInt(ethers.hexlify(ethers.randomBytes(8))).toString();
}

/**
 * Server-signed escrow action for an Agent-Wallet buyer (lock / release /
 * dispute). The owner is authenticated from the caller's credential, ownership
 * of the funding wallet is RE-verified here (never trusted from the record),
 * then the server signs with the wallet's decrypted key. Mirrors the agentic-
 * send authority model; the relayer only sponsors gas + is the named facilitator.
 */
async function handleAgentFundedAction(
  rec: EscrowRecord,
  cfg: EscrowChainCfg,
  action: "lock" | "release" | "dispute",
  body: { apiKey?: string; address?: string; challenge?: string; signature?: string },
): Promise<NextResponse> {
  const walletId = rec.fundingWalletId!;
  const eid = rec.onchainEscrowId;

  // ── G1/G2 auth. Payouts (release/dispute) ALWAYS require a fresh, single-use
  // intent signature — even in Mode C — so a bare apiKey can't drain an escrow.
  // Lock is a capped spend, so an apiKey (Mode C) is accepted like agentic send;
  // an owner intent-sig also works (dashboard).
  // Intent = the action's server-trusted params (the `action` itself is the
  // separate buildIntentMessage arg, so it's not duplicated here). The dashboard
  // rebuilds the SAME object via getActionAuth so the signed message matches.
  const intent: Record<string, string | number> = {
    escrowId: rec.id, onchainEscrowId: eid,
    chain: rec.chain, seller: rec.seller, amount: rec.amount, walletId,
  };
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
  let owner: string;
  if (action === "lock" && apiKey) {
    const keyRec = await getApiKeyRecord(apiKey);
    if (!keyRec || !keyRec.active) return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
    if (keyRec.isSandbox) return NextResponse.json({ error: "Sandbox keys cannot move escrow funds" }, { status: 400 });
    owner = keyRec.address.toLowerCase();
  } else {
    const authed = await requireIntentAuth({
      address: body.address, challenge: body.challenge, signature: body.signature,
      action: `escrow_${action}`, intent,
    });
    if (typeof authed !== "string") {
      return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
    }
    owner = authed;
  }

  // ── G1 ownership: caller must be the escrow creator AND own the funding wallet
  // (re-derived from the credential + registry, never trusted from the record).
  if (owner !== rec.creatorOwner) {
    return NextResponse.json({ error: "Only the escrow creator can act on it" }, { status: 403 });
  }
  const wallet = await getActiveAgenticWallet(owner, walletId);
  if (!wallet || wallet.address.toLowerCase() !== rec.buyer.toLowerCase()) {
    return NextResponse.json({ error: "You do not own the escrow's funding wallet" }, { status: 403 });
  }

  if (!(await acquireEscrowActionLock(rec.id))) {
    return NextResponse.json({ error: "An action for this escrow is already in progress" }, { status: 409 });
  }
  let releaseOnExit = true;
  const hold = () => { releaseOnExit = false; };
  try {
    if (action === "lock") return await agentEscrowLock(rec, cfg, wallet, owner, walletId, hold);
    return await agentEscrowVaultAction(rec, cfg, wallet, action, hold);
  } finally {
    if (releaseOnExit) await releaseEscrowActionLock(rec.id);
  }
}

/** Server-signed gasless lock from an Agent Wallet (the wallet spends into the
 *  vault). Spend-capped + refund-on-failure + on-chain confirm. */
async function agentEscrowLock(
  rec: EscrowRecord, cfg: EscrowChainCfg, wallet: AgenticWalletRecord,
  owner: string, walletId: string, hold: () => void,
): Promise<NextResponse> {
  if (rec.status !== "pending") return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });

  // Idempotent reconcile (no charge): if a lock already landed, heal instead of
  // charging + broadcasting a second one (which reverts EscrowExists).
  const priorLock = await getEscrowLockedMarker(rec.id);
  if (priorLock) {
    await markEscrowLocked(rec.id, priorLock.txHash);
    return NextResponse.json({ status: "open", txHash: priorLock.txHash, reconciled: true, escrow: toPublicEscrow((await getEscrow(rec.id))!) });
  }
  const pre = await readEscrowOnchainState(rec.chain, rec.onchainEscrowId);
  if (pre === 1) {
    const recovered = rec.lockTxHash ?? "";
    await writeEscrowLockedMarker(rec.id, { txHash: recovered, lockedAt: new Date().toISOString() }, rec.expiresAt);
    await markEscrowLocked(rec.id, recovered);
    return NextResponse.json({ status: "open", reconciled: "onchain", escrow: toPublicEscrow((await getEscrow(rec.id))!) });
  }
  if (pre !== null && pre !== 0) {
    return NextResponse.json({ error: `Escrow already exists on-chain (state ${pre})`, onchainState: pre }, { status: 409 });
  }

  const facilitator = escrowFacilitator(rec.chain);
  if (!facilitator) return NextResponse.json({ error: "escrow relayer not configured" }, { status: 503 });

  // ── G4 spend caps (the lock moves the wallet's balance; USDC/USDT = 1:1 USD).
  const amountUsd = Number(rec.amount);
  if (typeof wallet.perTxMaxUsd === "number" && amountUsd > wallet.perTxMaxUsd) {
    return NextResponse.json({ error: "PER_TX_LIMIT_EXCEEDED", limit: wallet.perTxMaxUsd, requested: amountUsd }, { status: 403 });
  }

  // ── G5 serialize per (wallet, chain): the lock signs a fresh EIP-7702 auth
  // whose nonce is the wallet's tx count. Without this lease a concurrent send /
  // lock on the SAME wallet+chain reads the same nonce and one tx silently
  // no-ops (the escrow action lock is per-escrow-id, so it does NOT cover this).
  // Same lease every other agent-wallet fund path holds.
  const wcToken = await acquireWalletChainLock(wallet.address, rec.chain);
  if (!wcToken) {
    return NextResponse.json({ error: "WALLET_BUSY", message: "Another action on this wallet is in flight. Retry in a moment." }, { status: 409 });
  }

  const reservation = await chargeAgainstDailyLimit(owner, walletId, amountUsd, wallet.dailyLimitUsd);
  if (!reservation.allowed) {
    await releaseWalletChainLock(wallet.address, rec.chain, wcToken).catch(() => {});
    return NextResponse.json({ error: "DAILY_LIMIT_EXCEEDED", spent: reservation.spent, limit: reservation.limit, requested: reservation.requested }, { status: 403 });
  }

  let committed = false; // set once funds are confirmed on-chain — never refund after
  try {
    const nonce = randEscrowNonce();
    const lockDeadline = String(Math.floor(Date.now() / 1000) + 900);
    const p: LockParams = {
      buyer: rec.buyer, seller: rec.seller, vault: cfg.vault, token: cfg.tokens[rec.token],
      amount: ethers.parseUnits(rec.amount, cfg.decimals).toString(),
      salt: rec.salt, releaseDeadline: String(Math.floor(new Date(rec.releaseDeadline).getTime() / 1000)),
      arbiter: rec.arbiter ?? ethers.ZeroAddress, facilitator, nonce, deadline: lockDeadline,
    };
    const key = decryptPrivateKey(wallet);
    const { witnessSig, authorization } = await signEscrowLockWithKey(cfg, key, p);
    const r = await settleEscrowLock(rec.chain, p, witnessSig, authorization);
    if (!r.ok) {
      await refundDailySpend(owner, walletId, amountUsd);
      return NextResponse.json({ error: r.error }, { status: 502 });
    }
    // G5: trust chain state, not tx status — a stale-nonce 7702 auth can succeed
    // (status 1) yet create NO escrow. Confirm state == Open (1) or refund + fail.
    const post = await readEscrowOnchainState(rec.chain, rec.onchainEscrowId);
    if (post !== 1) {
      await refundDailySpend(owner, walletId, amountUsd);
      return NextResponse.json({ error: "lock did not take effect on-chain; please retry", txHash: r.txHash }, { status: 502 });
    }
    committed = true; // funds are in the vault — the reservation is now real spend
    const lockedOk = await writeEscrowLockedMarker(rec.id, { txHash: r.txHash, lockedAt: new Date().toISOString() }, rec.expiresAt);
    let flippedOk = false;
    try { flippedOk = !!(await markEscrowLocked(rec.id, r.txHash)); } catch { flippedOk = false; }
    if (!lockedOk && !flippedOk) {
      hold(); // funds locked on-chain but record write lost — hold lock, retry reconciles
      return NextResponse.json({ status: "open", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash, warning: "locked on-chain but the record write failed; retry to reconcile (funds are safe)" });
    }
    // Defensive: don't `!`-assert getEscrow — a KV blip here must not throw into
    // the catch (funds already moved; committed=true blocks a wrongful refund).
    const pub = await getEscrow(rec.id);
    return NextResponse.json({ status: "open", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash, ...(pub ? { escrow: toPublicEscrow(pub) } : {}) });
  } catch (e) {
    // F-2: only refund if the funds did NOT move. A post-commit throw (e.g. a KV
    // blip building the response) must NOT credit the cap back — the spend is real.
    if (!committed) await refundDailySpend(owner, walletId, amountUsd);
    return NextResponse.json({ error: e instanceof Error ? e.message : "lock failed" }, { status: 502 });
  } finally {
    await releaseWalletChainLock(wallet.address, rec.chain, wcToken).catch(() => {});
  }
}

/** Server-signed release (pays seller) / dispute (freezes for arbiter) for an
 *  Agent-Wallet buyer. No spend recheck — funds already locked. */
async function agentEscrowVaultAction(
  rec: EscrowRecord, cfg: EscrowChainCfg, wallet: AgenticWalletRecord,
  action: "release" | "dispute", hold: () => void,
): Promise<NextResponse> {
  if (rec.status !== "open") return NextResponse.json({ error: `Escrow is ${rec.status}` }, { status: 409 });
  if (action === "dispute" && !rec.arbiter) {
    return NextResponse.json({ error: "This escrow has no arbiter, so it can't be disputed" }, { status: 400 });
  }
  const nonce = randEscrowNonce();
  const deadline = String(Math.floor(Date.now() / 1000) + 900);
  let sig: string;
  try {
    const key = decryptPrivateKey(wallet);
    sig = await signEscrowVaultActionWithKey(cfg, key, action, wallet.address, rec.onchainEscrowId, nonce, deadline);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "signing failed" }, { status: 500 });
  }

  if (action === "dispute") {
    const r = await settleEscrowDispute(rec.chain, rec.onchainEscrowId, nonce, deadline, sig);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
    await markEscrowDisputed(rec.id, r.txHash);
    return NextResponse.json({ status: "disputed", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash });
  }
  // release (terminal payout to seller)
  const r = await settleEscrowRelease(rec.chain, rec.onchainEscrowId, nonce, deadline, sig);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
  const durable = await writeEscrowSettledMarker(rec.id, { outcome: "release", txHash: r.txHash, settledAt: new Date().toISOString() }, rec.expiresAt);
  if (!durable) hold();
  await markEscrowSettled(rec.id, { outcome: "release", txHash: r.txHash });
  hold(); // settled — hold the action lock (mirror client path) so it can't re-settle immediately
  return NextResponse.json({ status: "release", txHash: r.txHash, explorer: cfg.explorerTx + r.txHash });
}
