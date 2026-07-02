import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/app/lib/auth";
import { getApiKeyRecord } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { AGENTIC_CHAINS, type AgenticChainKey } from "@/app/lib/agentic-wallet-sign";
import {
  createPaymentRequest,
  listPaymentRequestsPage,
  toPublicRequest,
} from "@/app/lib/payment-request";

/**
 * /api/request - Payment Requests collection.
 *
 *   POST  create a request. Auth = apiKey (MCP Mode C) OR session-sig
 *         (dashboard owner). Publishing an intent moves no funds, so the
 *         low-friction apiKey path is allowed. A sandbox key (`q402_test_`)
 *         marks the request `sandbox:true` so it settles in mock mode.
 *   GET   list the authed owner's requests. Session-sig via query params
 *         (?address=&nonce=&sig=), mirroring /api/transactions.
 */

export const runtime = "nodejs";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

function isAgenticChain(c: unknown): c is AgenticChainKey {
  return typeof c === "string" && Object.prototype.hasOwnProperty.call(AGENTIC_CHAINS, c);
}

function publicBaseUrl(req: NextRequest): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  return req.nextUrl.origin.replace(/\/$/, "");
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "request-create", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Auth: apiKey (MCP) OR session-sig (dashboard) ──────────────────────
  let creatorOwner: string;
  let sandbox = false;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
  if (apiKey) {
    const rec = await getApiKeyRecord(apiKey);
    if (!rec || !rec.active) {
      return NextResponse.json({ error: "Invalid or inactive API key" }, { status: 401 });
    }
    creatorOwner = rec.address;
    sandbox = !!rec.isSandbox;
  } else {
    const authed = await requireAuth(
      typeof body.address === "string" ? body.address : null,
      typeof body.nonce === "string" ? body.nonce : null,
      typeof body.signature === "string" ? body.signature : null,
    );
    if (typeof authed !== "string") {
      return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
    }
    creatorOwner = authed;
  }

  // ── Validate request fields (amount is always a human-decimal STRING) ──
  const { chain, token } = body;
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const amount = typeof body.amount === "string" ? body.amount : "";
  const memo = typeof body.memo === "string" && body.memo.trim().length > 0
    ? body.memo.trim().slice(0, 200)
    : undefined;

  if (!isAgenticChain(chain)) {
    return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
  }
  if (token !== "USDC" && token !== "USDT" && token !== "USDG") {
    return NextResponse.json({ error: "token must be USDC, USDT, or USDG" }, { status: 400 });
  }
  if (!ETH_ADDR.test(recipient)) {
    return NextResponse.json({ error: "Invalid recipient address" }, { status: 400 });
  }
  if (!AMOUNT_RE.test(amount) || !(Number(amount) > 0)) {
    return NextResponse.json({ error: "amount must be a positive decimal string" }, { status: 400 });
  }
  // Reject more fractional digits than the token supports on this chain. Without
  // this, an over-precision amount stores fine but the pay route's
  // ethers.parseUnits() throws at settle time, leaving the request permanently
  // unpayable. Validate here so the creator gets a clean 400 instead.
  const reqTokenCfg = AGENTIC_CHAINS[chain].tokens[token];
  if (!reqTokenCfg) {
    return NextResponse.json(
      { error: `${token} is not supported on ${chain}` },
      { status: 400 },
    );
  }
  const maxDecimals = reqTokenCfg.decimals;
  const dot = amount.indexOf(".");
  if (dot !== -1 && amount.length - dot - 1 > maxDecimals) {
    return NextResponse.json(
      { error: `amount has more decimals than ${token} supports on ${chain} (max ${maxDecimals})` },
      { status: 400 },
    );
  }
  // Hard ceiling. A request is a human-entered invoice, not an arbitrary-
  // magnitude intent: without a cap, a junk value like a 400-digit string is a
  // valid decimal that stores fine but is unpayable. Reject anything over
  // $1,000,000 with a clean 400 at create time.
  if (Number(amount) > 1_000_000) {
    return NextResponse.json(
      { error: "amount exceeds the maximum of 1,000,000 per request" },
      { status: 400 },
    );
  }

  const ttlDays =
    typeof body.ttlDays === "number" && body.ttlDays > 0 && body.ttlDays <= 90
      ? body.ttlDays
      : undefined;

  const record = await createPaymentRequest({
    creatorOwner,
    recipient,
    chain,
    token,
    amount,
    memo,
    sandbox,
    ttlDays,
  });

  return NextResponse.json(
    {
      requestId: record.id,
      payUrl: `${publicBaseUrl(req)}/pay/${record.id}`,
      request: toPublicRequest(record),
    },
    { status: 201 },
  );
}

export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "request-list", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce = req.nextUrl.searchParams.get("nonce");
  const signature = req.nextUrl.searchParams.get("sig");

  const authed = await requireAuth(address, nonce, signature);
  if (typeof authed !== "string") {
    return NextResponse.json({ error: authed.error, code: authed.code }, { status: authed.status });
  }

  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const offsetParam = Number(req.nextUrl.searchParams.get("offset"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;
  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  const { records, hasMore } = await listPaymentRequestsPage(authed, { limit, offset });
  return NextResponse.json({ requests: records.map(toPublicRequest), hasMore });
}
