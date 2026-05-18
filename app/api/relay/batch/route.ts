/**
 * POST /api/relay/batch
 *
 * Multi-recipient gasless settlement. The same EIP-712 + EIP-7702 wire
 * shape as /api/relay, but the body carries N recipients instead of one.
 * The endpoint sequentially relays each transfer through the existing
 * /api/relay route — same auth, same scope policy, same credit logic,
 * same atomic decrement, same receipt machinery — and aggregates the
 * results.
 *
 * Why fan out instead of inlining: /api/relay is the canonical settlement
 * pipeline. Reimplementing it here would duplicate ~800 lines of guarded
 * logic (rate limits, key scope, authorization lock, gas-tank balance,
 * trial-BNB enforcement, credit reservation, settlement, receipt + webhook
 * + alert dispatch, refund-on-failure). Sequential internal fetches preserve
 * every invariant for free at the cost of N round-trips inside the same
 * Vercel function — acceptable for batch sizes capped at 20.
 *
 * Scope limits — enforced server-side off `keyRecord.plan`:
 *   trial keys (plan === "trial")        → max 5 recipients
 *   paid keys (everything else)          → max 20 recipients
 *
 * Execution model:
 *   - Sequential. The first transfer installs the EIP-7702 delegation on
 *     the owner's EOA (or confirms an existing one); subsequent transfers
 *     rely on that delegation being in place.
 *   - First-failure abort. If recipient[0] fails, the batch aborts before
 *     any subsequent relay attempt — there's no point trying recipient[1]
 *     when delegation never installed. Failures after the first are
 *     surfaced in the result array but do NOT abort the batch.
 *   - Per-transfer credit reservation is handled by /api/relay itself
 *     (atomic decrementCredit + refundCredit on failure). No additional
 *     bookkeeping at this layer.
 *
 * Body:
 *   {
 *     apiKey:      "q402_live_…",
 *     chain:       "bnb" | "eth" | …,
 *     token:       "USDC" | "USDT" | "RLUSD",
 *     facilitator: "0x…",
 *     recipients: [
 *       {
 *         from, to, amount, nonce, deadline, witnessSig,
 *         authorization: { chainId, address, nonce, yParity, r, s },
 *       },
 *       …
 *     ],
 *   }
 *
 * Response (200, even on partial failure):
 *   {
 *     ok: true,
 *     scope: "trial" | "paid",
 *     limit: 5 | 20,
 *     totalSuccess: N,
 *     totalFailed:  M,
 *     results: [
 *       { success: true,  txHash, blockNumber, receiptId, method },
 *       { success: false, error: "...", code?: "..." },
 *       …
 *     ],
 *   }
 *
 * Errors:
 *   400  Invalid body / unsupported chain / mismatched recipient shape
 *   401  Invalid or inactive API key
 *   403  Batch size exceeds scope limit
 *   429  Per-IP rate limit
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const ALLOWED_TOKENS = new Set(["USDC", "USDT", "RLUSD"]);

const MAX_RECIPIENTS_TRIAL = 5;
const MAX_RECIPIENTS_PAID  = 20;

interface BatchRecipient {
  from?:        string;
  to?:          string;
  amount?:      string;
  nonce?:       string;
  deadline?:    number;
  witnessSig?:  string;
  authorization?: {
    chainId:  number;
    address:  string;
    nonce:    number;
    yParity:  number;
    r:        string;
    s:        string;
  };
  // X Layer / Stable / Mantle alt nonce field names — passed through to
  // /api/relay verbatim. We don't validate which one is correct here;
  // the inner route owns that policy.
  xlayerNonce?:  string;
  stableNonce?:  string;
  eip3009Nonce?: string;
}

interface BatchBody {
  apiKey?:      string;
  chain?:       string;
  token?:       string;
  facilitator?: string;
  recipients?:  BatchRecipient[];
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  // Rate-limit budget (effective per-key throughput):
  //
  //   Outer (per-IP, this route): 10 batches per 60s
  //   Inner (per-API-key, /api/relay): 30 relays per 60s — applied PER ROW
  //
  // So a 20-row paid batch consumes 20 of the inner 30/60s budget; after one
  // full batch you have 10 inner slots left for the next 60s. Effective ceiling
  // is ~1.5 paid batches per 60s before the per-key inner cap throttles you.
  // Trial (5 rows) is ~6 batches per 60s before inner cap kicks in. Document
  // this in the public docs alongside batchPay's input schema.
  if (!(await rateLimit(ip, "relay-batch", 10, 60, false))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: BatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { apiKey, chain, token, facilitator, recipients } = body;

  if (typeof apiKey !== "string" || !apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  if (typeof chain !== "string" || !chain) {
    return NextResponse.json({ error: "chain is required" }, { status: 400 });
  }
  // Authoritative batch-chain scope. Browser SDK + Node client also
  // reject xlayer / stable for batching — chain-specific nonce field
  // shapes (xlayerNonce / stableNonce) and the X Layer USDC EIP-3009
  // fallback don't compose cleanly with sequential first-fail-abort
  // semantics. Per-recipient pay() loop remains the path for those.
  const BATCHABLE_CHAINS = new Set(["avax", "bnb", "eth", "mantle", "injective"]);
  if (!BATCHABLE_CHAINS.has(chain)) {
    return NextResponse.json(
      {
        error: `chain "${chain}" is not batchable. Batch-supported chains: avax, bnb, eth, mantle, injective. For xlayer / stable use /api/relay in a client-side loop.`,
        code: "CHAIN_NOT_BATCHABLE",
      },
      { status: 400 },
    );
  }
  if (typeof token !== "string" || !ALLOWED_TOKENS.has(token)) {
    return NextResponse.json({ error: "token must be USDC, USDT, or RLUSD" }, { status: 400 });
  }
  if (typeof facilitator !== "string" || !ETH_ADDR.test(facilitator)) {
    return NextResponse.json({ error: "facilitator must be a 0x-prefixed EVM address" }, { status: 400 });
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return NextResponse.json({ error: "recipients must be a non-empty array" }, { status: 400 });
  }

  // Validate per-recipient shape early — surface bad payloads as one 400
  // rather than letting the first inner relay return a partial-success
  // batch with a single error row.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    if (!r || typeof r !== "object") {
      return NextResponse.json({ error: `recipients[${i}] must be an object` }, { status: 400 });
    }
    if (typeof r.to !== "string" || !ETH_ADDR.test(r.to)) {
      return NextResponse.json({ error: `recipients[${i}].to must be a 0x address` }, { status: 400 });
    }
    if (typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) {
      return NextResponse.json({ error: `recipients[${i}].amount must be a positive integer string (raw uint256)` }, { status: 400 });
    }
    if (typeof r.witnessSig !== "string" || !r.witnessSig.startsWith("0x")) {
      return NextResponse.json({ error: `recipients[${i}].witnessSig is required` }, { status: 400 });
    }
  }

  // Resolve the API key once at the outer layer to decide the batch
  // scope limit. Inner /api/relay calls re-resolve the same key — that's
  // fine, the inner check is the security boundary; we just need the
  // plan here for the recipient-count cap.
  const keyRecord = await getApiKeyRecord(apiKey);
  if (!keyRecord || !keyRecord.active) {
    return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
  }

  const isTrialScopedKey = keyRecord.plan === "trial";
  const limit = isTrialScopedKey ? MAX_RECIPIENTS_TRIAL : MAX_RECIPIENTS_PAID;
  if (recipients.length > limit) {
    return NextResponse.json(
      {
        ok: false,
        error: `Batch size ${recipients.length} exceeds the ${isTrialScopedKey ? "trial" : "paid"}-tier limit of ${limit} recipients per call`,
        code: "BATCH_TOO_LARGE",
        scope: isTrialScopedKey ? "trial" : "paid",
        limit,
      },
      { status: 403 },
    );
  }

  // Resolve the canonical /api/relay URL on the same origin so we don't
  // hit Vercel's edge network for an internal hop. `req.nextUrl.origin`
  // is whatever the caller resolved to (production custom domain,
  // preview deploy URL, localhost) — same instance handles the inner
  // call, no cold-start.
  const relayUrl = `${req.nextUrl.origin}/api/relay`;

  // Sequential execution. The first transfer must succeed (delegation
  // install or confirmation); subsequent transfers run regardless of
  // each other's success/failure, so the caller gets a real picture of
  // partial outcomes.
  const results: Array<{
    success: boolean;
    txHash?: string;
    blockNumber?: number;
    receiptId?: string;
    method?: string;
    error?: string;
    code?: string;
  }> = [];

  let totalSuccess = 0;
  let totalFailed  = 0;
  let firstFailed  = false;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const innerBody = {
      apiKey,
      chain,
      token,
      facilitator,
      from: r.from,
      to: r.to,
      amount: r.amount,
      nonce: r.nonce,
      deadline: r.deadline,
      witnessSig: r.witnessSig,
      authorization: r.authorization,
      // Pass through chain-specific nonce alternates so /api/relay's
      // dispatcher routes to the right settlement path.
      ...(r.xlayerNonce  ? { xlayerNonce:  r.xlayerNonce  } : {}),
      ...(r.stableNonce  ? { stableNonce:  r.stableNonce  } : {}),
      ...(r.eip3009Nonce ? { eip3009Nonce: r.eip3009Nonce } : {}),
    };

    let result: { success: boolean; txHash?: string; blockNumber?: number; receiptId?: string; method?: string; error?: string; code?: string };
    try {
      const innerRes = await fetch(relayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(innerBody),
      });
      const innerJson = await innerRes.json();
      if (innerRes.ok && innerJson.success) {
        result = {
          success: true,
          txHash:      innerJson.txHash,
          blockNumber: innerJson.blockNumber,
          receiptId:   innerJson.receiptId,
          method:      innerJson.method,
        };
        totalSuccess++;
      } else {
        result = {
          success: false,
          error: innerJson.error ?? `HTTP ${innerRes.status}`,
          code:  innerJson.code,
        };
        totalFailed++;
        if (i === 0) firstFailed = true;
      }
    } catch (e) {
      result = {
        success: false,
        error: e instanceof Error ? e.message : "Internal relay error",
      };
      totalFailed++;
      if (i === 0) firstFailed = true;
    }
    results.push(result);

    // First-failure abort: if the leading transfer didn't install the
    // delegation, no subsequent transfer can succeed. Bail.
    if (firstFailed) break;
  }

  // Response-status policy:
  //   - all rows OK                  → 200, ok: true
  //   - recipient[0] failed (abort)  → 424 (Failed Dependency), ok: false
  //                                    The delegation install dictates every
  //                                    downstream row; the caller cannot retry
  //                                    sub-rows in isolation. Returning 200
  //                                    here would look like success to any
  //                                    wrapper that only inspects resp.ok,
  //                                    so the response MUST signal failure
  //                                    via the HTTP status as well as the
  //                                    body.
  //   - some rows failed (partial)   → 207 (Multi-Status), ok: false
  //                                    The first transfer succeeded so the
  //                                    delegation IS in place; remaining
  //                                    failures are per-row state, not a
  //                                    batch-wide collapse. ok:false still
  //                                    forces caller attention to the
  //                                    results[] array.
  const isAborted        = firstFailed;
  const isPartialFailure = !firstFailed && totalFailed > 0;
  const status =
      isAborted        ? 424
    : isPartialFailure ? 207
    :                    200;
  return NextResponse.json(
    {
      ok: totalFailed === 0,
      scope: isTrialScopedKey ? "trial" : "paid",
      limit,
      totalSuccess,
      totalFailed,
      aborted: isAborted,
      results,
    },
    { status },
  );
}
