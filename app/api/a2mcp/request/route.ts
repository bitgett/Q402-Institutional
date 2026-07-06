import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { createPaymentRequest, toPublicRequest } from "@/app/lib/payment-request";
import {
  A2MCP_ENABLED, ETH_ADDR, isA2mcpChain, isStableToken, validateAmount,
} from "@/app/lib/a2mcp";
import { hasX402Payment, x402Challenge } from "@/app/lib/a2mcp-x402";

const REQ_DESC = "Q402 Payment Request: create a payable, gasless payment-request link";

/**
 * POST /api/a2mcp/request  (OKX.AI ASP #2831, free A2MCP service)
 *
 * Create a real, payable Q402 payment-request. MOVES NO FUNDS — it records a
 * request that anyone can later pay gaslessly. The `recipient` (the party to be
 * paid) is both the payee and the record owner, so no separate auth is needed:
 * a caller can only create a request that pays the recipient they name.
 *
 * Inert unless A2MCP_ENABLED=1.
 */

export const runtime = "nodejs";

function publicBase(req: NextRequest): string {
  return req.nextUrl.origin.replace(/\/$/, "");
}

export async function GET(req: NextRequest) {
  return x402Challenge(`${publicBase(req)}/api/a2mcp/request`, REQ_DESC);
}

export async function POST(req: NextRequest) {
  const resource = `${publicBase(req)}/api/a2mcp/request`;
  if (!hasX402Payment(req)) return x402Challenge(resource, REQ_DESC);

  if (!A2MCP_ENABLED) return NextResponse.json({ error: "A2MCP service is not enabled" }, { status: 503 });
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "a2mcp-request", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { chain, token } = body;
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const memo = typeof body.memo === "string" && body.memo.trim() ? body.memo.trim().slice(0, 200) : undefined;

  if (!isA2mcpChain(chain)) return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
  if (!isStableToken(token)) return NextResponse.json({ error: "token must be USDC or USDT" }, { status: 400 });
  if (!ETH_ADDR.test(recipient)) return NextResponse.json({ error: "recipient must be a valid address" }, { status: 400 });
  const amt = validateAmount(body.amount);
  if (!amt.ok) return NextResponse.json({ error: amt.error }, { status: 400 });

  const record = await createPaymentRequest({
    creatorOwner: recipient, // the payee owns the request they are the recipient of
    recipient,
    chain,
    token,
    amount: amt.amount,
    memo,
    sandbox: false,
  });

  return NextResponse.json(
    {
      requestId: record.id,
      payUrl: `${publicBase(req)}/pay/${record.id}`,
      request: toPublicRequest(record),
    },
    { status: 201 },
  );
}
