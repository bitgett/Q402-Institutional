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
import { ESCROW_ENABLED, getEscrowChain } from "@/app/lib/escrow-contracts";
import {
  escrowFacilitator, settleEscrowLock, settleEscrowRelease, settleEscrowRefund,
  settleEscrowDispute, settleEscrowResolve, type LockParams, type Authorization,
} from "@/app/lib/escrow-relayer";

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
      // so even if markEscrowLocked's write is lost the escrow can never be
      // stranded as pending/expired (getEscrow reconciles from this marker).
      await writeEscrowLockedMarker(id, { txHash: r.txHash, lockedAt: new Date().toISOString() }, rec.expiresAt);
      await markEscrowLocked(id, r.txHash);
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
