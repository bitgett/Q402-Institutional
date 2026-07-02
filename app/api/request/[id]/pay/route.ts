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
  getRequestSettledMarker,
  writeRequestSettledMarker,
} from "@/app/lib/payment-request";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

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
  // Mirror the agentic send route's billing-key selection: BNB can be sponsored
  // by the free Trial key, but ONLY while the trial is still active. A wallet
  // whose trial has lapsed must fall back to the paid Multichain key, or the
  // relay rejects the stale trial key with a confusing error. Everything off
  // BNB needs the paid key regardless.
  if (chain === "bnb") {
    const trialValid =
      !!sub.trialApiKey &&
      !!sub.trialExpiresAt &&
      new Date(sub.trialExpiresAt) > new Date();
    if (trialValid) return sub.trialApiKey!;
    return sub.apiKey || sub.trialApiKey || null;
  }
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

  const cronSecret = process.env.CRON_SECRET ?? "";
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

  // Durable re-pay guard: a prior settlement may have moved funds on-chain yet
  // failed to flip the record to `paid` (KV blip mid-settle), leaving it stale
  // `open`. The status check above can't catch that; this request-scoped marker
  // is written the instant funds move, so it blocks any second payer.
  const priorSettle = await getRequestSettledMarker(id);
  if (priorSettle) {
    return NextResponse.json(
      {
        error: "Request already paid",
        status: "paid",
        txHash: priorSettle.txHash,
        receiptId: priorSettle.receiptId ?? null,
      },
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
          headers: {
            "Content-Type": "application/json",
            // Trust header lets /send tag the RelayedTx provenance as "request"
            // so the settlement lands in the Activity "Requests" rail instead of
            // "Manual sends". Without it /send keeps the default "send" tag.
            ...(cronSecret ? { "X-Q402-Internal-Trust": cronSecret } : {}),
          },
          body: JSON.stringify({
            apiKey: body.payerApiKey,
            chain: record.chain,
            token: record.token,
            to: record.recipient,
            amount: record.amount,
            ...(body.walletId ? { walletId: body.walletId } : {}),
            // Provenance tag (honoured only with the trust header above).
            source: "request",
            // Bind idempotency to the REQUEST, not the caller. A request is
            // single-payment, so a deterministic key lets /send dedupe a
            // same-payer retry. We deliberately do NOT honour a client-supplied
            // idempotencyKey — an override would weaken the request-bound dedup.
            // The request-scoped durable marker (written post-settle) is the
            // guard against a DIFFERENT payer re-settling a stale-open request.
            idempotencyKey: `payreq-${record.id}`,
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        return NextResponse.json({ error: "Settlement did not respond. Safe to retry." }, { status: 504 });
      }
      const data = (await sendResp.json().catch(() => ({}))) as {
        txHash?: string;
        receiptId?: string;
        walletId?: string;
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
      // /send echoes the RESOLVED Agent Wallet address it signed from, so the
      // payer is recorded even when the client pinned no walletId (the common
      // MCP case). Falls back to the client value, then "" if neither is known.
      paidBy = (data.walletId ?? body.walletId ?? "").toLowerCase();
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
      // tokens.USDC/USDT are optional (USDG-only chains like Robinhood carry
      // neither), so guard the lookup rather than blindly deref .decimals.
      const reqTokenCfg = chainCfg.tokens[record.token as keyof typeof chainCfg.tokens];
      if (!reqTokenCfg) {
        return NextResponse.json(
          { error: `Token ${record.token} is not supported on ${record.chain}` },
          { status: 400 },
        );
      }
      const decimals = reqTokenCfg.decimals;
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
      paidBy = from.toLowerCase();
    }

    // ── Durable re-pay guard FIRST ──────────────────────────────────────────
    // Funds moved on-chain. Before the (failable) status flip, persist the
    // request-scoped settled marker so a SECOND payer can never re-settle this
    // request even if every markRequestPaid retry below fails and the 120s lock
    // later expires. Witness mode signs a FRESH nonce per attempt, so the
    // on-chain nonce does NOT stop a distinct second payment — this marker is
    // the real fund-safety guard for BOTH modes.
    const durableOk = await writeRequestSettledMarker(
      id,
      {
        txHash,
        paidBy,
        ...(receiptId ? { receiptId } : {}),
        mode: serverMode ? "server" : "witness",
        settledAt: new Date().toISOString(),
      },
      record.expiresAt,
    );
    if (!durableOk) {
      // KV durably down at settlement time: payment is on-chain but the re-pay
      // guard didn't persist. Keep the lock (don't release) as a 120s
      // best-effort and page ops — mirrors the send route's posture.
      releaseOnExit = false;
      void sendOpsAlert(
        `request/pay durable settled-marker write FAILED after retries for ${id} ` +
          `(mode=${serverMode ? "server" : "witness"}, txHash=${txHash}, paidBy=${paidBy}). ` +
          `Funds moved on-chain; a retry after the 120s lock could re-settle — verify before replay.`,
        "critical",
      );
    }

    // Flip status to paid. Retry a few times on a transient KV blip so the
    // request doesn't linger as "open" after the funds moved. Even if all
    // retries fail, the durable marker above already blocks a re-pay, so this
    // is a display-consistency guard, not the fund-safety one.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await markRequestPaid(id, { txHash, paidBy, receiptId });
        break;
      } catch {
        /* transient; retry */
      }
    }
    releaseOnExit = false;

    return NextResponse.json({ status: "paid", txHash, receiptId: receiptId ?? null });
  } finally {
    if (releaseOnExit) await releaseRequestPayLock(id);
  }
}
