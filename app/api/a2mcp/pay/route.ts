import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import {
  A2MCP_ENABLED, A2MCP_RELAY_KEY, A2MCP_RELAY_URL, A2MCP_PAY_DAILY_CAP, ETH_ADDR,
  isA2mcpChain, isStableToken, payDescriptor,
} from "@/app/lib/a2mcp";

/**
 * POST /api/a2mcp/pay  (OKX.AI ASP #2831, free A2MCP service)
 *
 * Execute a gasless stablecoin payment. The caller sends a Q402 transfer
 * authorization they SIGNED; this route forwards it to the existing, audited
 * /api/relay using a Q402-owned, quota-bounded key. That reuse is the whole
 * safety story: the relay does the sanctions screening, witness verification,
 * chain/gas checks, and settlement, and the injected key's quota is the HARD
 * cap on how much gas Q402 will sponsor for this free endpoint. This route only
 * adds a coarse pre-check + per-IP / per-payer rate-limits.
 *
 * It cannot move anyone else's funds: the on-chain signature (verified by the
 * relay) is the sole authority, and only the signer's own `from` EOA is debited.
 *
 * Inert unless A2MCP_ENABLED=1 AND A2MCP_RELAY_KEY is set.
 */

export const runtime = "nodejs";

function publicBase(req: NextRequest): string {
  return req.nextUrl.origin.replace(/\/$/, "");
}

export async function GET(req: NextRequest) {
  return NextResponse.json(payDescriptor(`${publicBase(req)}/api/a2mcp/pay`));
}

export async function POST(req: NextRequest) {
  if (!A2MCP_ENABLED) return NextResponse.json({ error: "A2MCP service is not enabled" }, { status: 503 });
  if (!A2MCP_RELAY_KEY) return NextResponse.json({ error: "A2MCP relay is not configured" }, { status: 503 });

  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "a2mcp-pay-ip", 20, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { chain, token, from, to, amount, nonce, deadline, witnessSig, authorization, eip3009Nonce } = body;

  // Coarse pre-check — the relay is the authority (re-validates everything +
  // verifies the signature), this just avoids forwarding obvious junk.
  if (!isA2mcpChain(chain)) return NextResponse.json({ error: "Unsupported chain" }, { status: 400 });
  if (!isStableToken(token)) return NextResponse.json({ error: "token must be USDC or USDT" }, { status: 400 });
  if (typeof from !== "string" || !ETH_ADDR.test(from)) return NextResponse.json({ error: "from must be a valid address" }, { status: 400 });
  if (typeof to !== "string" || !ETH_ADDR.test(to)) return NextResponse.json({ error: "to must be a valid address" }, { status: 400 });
  // amount is the ATOMIC base-units integer the payer SIGNED (not a decimal) —
  // the relay does BigInt(amount) and the signature is bound to this exact value,
  // so it must be forwarded verbatim. A decimal here would both break the relay
  // and mismatch the signature.
  if (typeof amount !== "string" || !/^[1-9]\d*$/.test(amount)) {
    return NextResponse.json({ error: "amount must be a positive integer in base units (matching your signed authorization)" }, { status: 400 });
  }
  if (!witnessSig || (!authorization && !eip3009Nonce)) {
    return NextResponse.json({ error: "missing witnessSig and authorization (or eip3009Nonce)" }, { status: 400 });
  }

  // Per-payer bound (on top of the per-IP limit and the key quota) so a single
  // signer cannot monopolize the shared free-tier gas budget.
  if (!(await rateLimit(from.toLowerCase(), "a2mcp-pay-from", 20, 60))) {
    return NextResponse.json({ error: "Too many payments from this address, try again shortly" }, { status: 429 });
  }

  // Hard daily cap on forwarded (gas-costing) calls — a code-level bound that
  // makes an unbounded gas drain impossible regardless of how the key is set up.
  // Increment BEFORE forwarding so the count reflects every call that can settle.
  if (A2MCP_PAY_DAILY_CAP > 0) {
    const dayKey = `a2mcp:paycount:${new Date().toISOString().slice(0, 10)}`;
    try {
      const n = await kv.incr(dayKey);
      if (n === 1) await kv.expire(dayKey, 172800); // ~2 days, self-evicting
      if (n > A2MCP_PAY_DAILY_CAP) {
        return NextResponse.json({ error: "Daily free-relay capacity reached, please try again tomorrow" }, { status: 429 });
      }
    } catch {
      // KV unavailable: fail CLOSED (do not relay) rather than lose the gas cap.
      return NextResponse.json({ error: "Service temporarily unavailable" }, { status: 503 });
    }
  }

  // Forward to the audited relay with the Q402-owned bounded key injected.
  const relayBody = {
    apiKey: A2MCP_RELAY_KEY,
    chain, token, from, to, amount, nonce, deadline, witnessSig, authorization,
    ...(eip3009Nonce ? { eip3009Nonce } : {}),
  };
  let relayRes: Response;
  try {
    // A2MCP_RELAY_URL is a FIXED server origin (never request-derived) so the
    // injected key can never be POSTed to a Host-spoofed attacker endpoint.
    relayRes = await fetch(A2MCP_RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(relayBody),
    });
  } catch {
    return NextResponse.json({ error: "relay unreachable" }, { status: 502 });
  }
  const data = await relayRes.json().catch(() => ({ error: "relay returned a non-JSON response" }));
  return NextResponse.json(data, { status: relayRes.status });
}
