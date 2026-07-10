/**
 * POST /api/oft/quote
 *
 * Public USDT0 (LayerZero OFT) bridge quote. No auth. Companion to
 * /api/ccip/quote. Returns the native LayerZero fee, the OFT-reported delivered
 * amount, the slippage-floored minAmountLD, and the path credit limits.
 *
 * Body: { src, dst, amount, owner? }
 *   owner is optional — the fee does not depend on the specific recipient, so a
 *   probe address is used when omitted.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { isOftChain, isOftLane, OFT_CONFIG, quoteOftBridge, type OftChainKey } from "@/app/lib/usdt0";

export const runtime = "nodejs";
export const maxDuration = 30;

const PROBE = "0x000000000000000000000000000000000000dEaD";

interface QuoteBody { src?: string; dst?: string; amount?: string; owner?: string; }

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "oft-quote", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: QuoteBody;
  try {
    body = (await req.json()) as QuoteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.src || !isOftChain(body.src)) {
    return NextResponse.json({ error: "src must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  if (!body.dst || !isOftChain(body.dst)) {
    return NextResponse.json({ error: "dst must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  const src = body.src as OftChainKey;
  const dst = body.dst as OftChainKey;
  if (src === dst) return NextResponse.json({ error: "src and dst must differ" }, { status: 400 });
  if (!isOftLane(src, dst)) return NextResponse.json({ error: `Lane ${src} -> ${dst} is not a supported USDT0 route` }, { status: 400 });
  if (!body.amount || !/^\d+$/.test(body.amount)) {
    return NextResponse.json({ error: "amount must be a non-negative integer string (raw local-decimal USDT0)" }, { status: 400 });
  }
  if (BigInt(body.amount) === 0n) return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  const owner = body.owner && /^0x[a-fA-F0-9]{40}$/.test(body.owner) ? body.owner : PROBE;

  try {
    const q = await quoteOftBridge(src, dst, BigInt(body.amount), owner);
    return NextResponse.json({
      src, dst, amount: body.amount,
      nativeFee: { raw: q.nativeFee.toString(), whole: Number(q.nativeFee) / 1e18 },
      amountReceived: q.amountReceivedLD.toString(),
      minAmountLD: q.minAmountLD.toString(),
      pathLimit: { minLD: q.limitMinLD.toString(), maxLD: q.limitMaxLD.toString() },
      decimals: OFT_CONFIG[src].decimals,
    }, { status: 200 });
  } catch (e) {
    return NextResponse.json({
      error: "OFT_QUOTE_FAILED",
      detail: e instanceof Error ? e.message.slice(0, 200) : "unknown",
    }, { status: 502 });
  }
}
