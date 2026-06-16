import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getSubscription, hasMultichainScope } from "@/app/lib/db";
import {
  AGENTIC_CHAINS,
  internalBaseUrl,
  type AgenticChainKey,
} from "@/app/lib/agentic-wallet-sign";
import {
  getPaymentRequest,
  markRequestPaid,
  acquireRequestPayLock,
  releaseRequestPayLock,
} from "@/app/lib/payment-request";

/**
 * POST /api/request/[id]/pay - settle a payment request. Two modes:
 *
 *  1. WITNESS mode (creator-sponsored) - body { from, witnessSig,
 *     authorization, nonce, deadline }. The payer signed a TransferAuthorization
 *     in their own wallet; this route injects the CREATOR's apiKey and forwards
 *     to /api/relay, so the creator's quota/gas-tank pays the gas.
 *
 *  2. SERVER mode (agent, payer-sponsored) - body { payerApiKey, walletId? }.
 *     A Mode C agent pays from its OWN server-managed Agent Wallet via the
 *     existing /api/wallet/agentic/send path; the payer sponsors its own gas.
 *
 * Both end at markRequestPaid. Tamper-safety: chain / token / recipient /
 * amount are read from the stored request, never the client. A SET NX lock
 * serializes settlement; on success it is left to expire so it doubles as a
 * re-pay guard alongside the status flip to `paid`.
 */

export const runtime = "nodejs";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

function pickCreatorApiKey(
  sub: Awaited<ReturnType<typeof getSubscription>>,
  chain: string,
  sandbox: boolean,
): string | null {
  if (!sub) return null;
  if (sandbox) {
    return sub.trialSandboxApiKey ?? sub.sandboxApiKey ?? null;
  }
  // Mirror the agentic send route's billing-key selection: BNB prefers the
  // trial key, everything else needs the multichain (paid) key.
  if (chain === "bnb") return sub.trialApiKey || sub.apiKey || null;
  return sub.apiKey || null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "request-pay", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;

  let body: {
    from?: string;
    witnessSig?: string;
    authorization?: unknown;
    nonce?: string;
    deadline?: number | string;
    payerApiKey?: string;
    walletId?: string;
    idempotencyKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const serverMode = typeof body.payerApiKey === "string" && body.payerApiKey.length > 0;
  const from = typeof body.from === "string" ? body.from : "";
  if (!serverMode) {
    // Witness mode requires the payer's signed authorization fields.
    if (!ETH_ADDR.test(from) || !body.witnessSig || !body.nonce || !body.deadline || !body.authorization) {
      return NextResponse.json(
        { error: "Provide either { payerApiKey } (agent) or { from, witnessSig, authorization, nonce, deadline }" },
        { status: 400 },
      );
    }
  }

  const record = await getPaymentRequest(id);
  if (!record) {
    return NextResponse.json({ error: "Request not found", notFound: true }, { status: 404 });
  }
  if (record.status !== "open") {
    return NextResponse.json(
      { error: `Request is ${record.status}`, status: record.status },
      { status: 409 },
    );
  }

  // ── Serialize settlement ────────────────────────────────────────────────
  if (!(await acquireRequestPayLock(id))) {
    return NextResponse.json(
      { error: "A settlement for this request is already in progress" },
      { status: 409 },
    );
  }
  let releaseOnExit = true;
  try {
    let txHash: string | undefined;
    let receiptId: string | undefined;
    let paidBy: string;

    if (serverMode) {
      // ── Agent pays from its own Mode C Agent Wallet (payer-sponsored) ───
      // Reuse the canonical send route end-to-end: it authenticates the
      // payer's apiKey, signs from the server keystore, relays gaslessly,
      // and records the tx under the payer. recipient/amount/chain/token
      // come from the stored request, so the payer can't redirect funds.
      let sendResp: Response;
      try {
        sendResp = await fetch(`${internalBaseUrl()}/api/wallet/agentic/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: body.payerApiKey,
            chain: record.chain,
            token: record.token,
            to: record.recipient,
            amount: record.amount,
            ...(body.walletId ? { walletId: body.walletId } : {}),
            ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        return NextResponse.json({ error: "Settlement did not respond. Safe to retry." }, { status: 504 });
      }
      const data = (await sendResp.json().catch(() => ({}))) as {
        txHash?: string;
        receiptId?: string;
        error?: string;
        message?: string;
      };
      if (!sendResp.ok || !data.txHash) {
        return NextResponse.json(
          { error: data.error ?? data.message ?? "Settlement failed", relayStatus: sendResp.status },
          { status: sendResp.status >= 400 ? sendResp.status : 502 },
        );
      }
      txHash = data.txHash;
      receiptId = data.receiptId;
      paidBy = (body.walletId ?? "").toLowerCase();
    } else {
      // ── Creator-sponsored witness settlement ────────────────────────────
      const sub = await getSubscription(record.creatorOwner);
      if (record.chain !== "bnb" && !record.sandbox && !hasMultichainScope(sub)) {
        return NextResponse.json(
          { error: "The request creator does not have multichain access for this chain." },
          { status: 402 },
        );
      }
      const creatorApiKey = pickCreatorApiKey(sub, record.chain, record.sandbox);
      if (!creatorApiKey) {
        return NextResponse.json(
          { error: "The request creator has no active key to sponsor this payment." },
          { status: 402 },
        );
      }

      // Server-derived raw amount (atomic units) - never trust the client.
      const chainCfg = AGENTIC_CHAINS[record.chain as AgenticChainKey];
      const decimals = chainCfg.tokens[record.token].decimals;
      let amountRaw: string;
      try {
        amountRaw = ethers.parseUnits(record.amount, decimals).toString();
      } catch {
        return NextResponse.json({ error: "Stored request amount is invalid" }, { status: 500 });
      }

      const nonceField =
        record.chain === "xlayer"
          ? { xlayerNonce: body.nonce }
          : record.chain === "stable"
            ? { stableNonce: body.nonce }
            : { nonce: body.nonce };

      const cronSecret = process.env.CRON_SECRET ?? "";
      const relayBody = {
        apiKey: creatorApiKey,
        chain: record.chain,
        token: record.token,
        from,
        to: record.recipient,
        amount: amountRaw,
        ...nonceField,
        deadline: typeof body.deadline === "string" ? body.deadline : String(body.deadline),
        witnessSig: body.witnessSig,
        authorization: body.authorization,
        source: "request",
      };

      let relayResp: Response;
      try {
        relayResp = await fetch(`${internalBaseUrl()}/api/relay`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cronSecret ? { "X-Q402-Internal-Trust": cronSecret } : {}),
          },
          body: JSON.stringify(relayBody),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        return NextResponse.json({ error: "Settlement relay did not respond. Safe to retry." }, { status: 504 });
      }
      const data = (await relayResp.json().catch(() => ({}))) as {
        success?: boolean;
        txHash?: string;
        receiptId?: string;
        error?: string;
      };
      if (!relayResp.ok || !data.success || !data.txHash) {
        return NextResponse.json(
          { error: data.error ?? "Settlement failed", relayStatus: relayResp.status },
          { status: relayResp.status >= 400 ? relayResp.status : 502 },
        );
      }
      txHash = data.txHash;
      receiptId = data.receiptId;
      paidBy = from;
    }

    // Settled. Flip status; keep the lock as a belt-and-suspenders re-pay
    // guard until it expires (the on-chain nonce already prevents replay).
    await markRequestPaid(id, { txHash, paidBy, receiptId }).catch(() => {});
    releaseOnExit = false;

    return NextResponse.json({ status: "paid", txHash, receiptId: receiptId ?? null });
  } finally {
    if (releaseOnExit) await releaseRequestPayLock(id);
  }
}
