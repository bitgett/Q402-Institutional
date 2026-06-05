/**
 * POST /api/ccip/quote
 *
 * On-chain CCIP fee quote for a hypothetical bridge. No auth, no state
 * change. Returns BOTH LINK and native fees so the caller can compare
 * options before committing to /send.
 *
 * Body:
 *   {
 *     src:          "eth" | "avax" | "arbitrum",
 *     dst:          "eth" | "avax" | "arbitrum",   // must be one of src's supported destinations
 *     amount:       string  // raw 6-decimal USDC (e.g. "1000000" = 1 USDC)
 *     destReceiver: "0x..." // destination Agentic Wallet (used in fee calc — payload size matters)
 *   }
 *
 * Response:
 *   {
 *     src, dst, amount, destReceiver,
 *     fee: {
 *       link:   { raw: "...", whole: 0.05, usd: 0.60 },
 *       native: { raw: "...", whole: 0.000165, usd: 0.66 }
 *     },
 *     recommended: "link" | "native"
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { isCCIPChain, CCIP_CONFIG, quoteBridgeFee, feeToUsd, type CCIPChainKey } from "@/app/lib/ccip";

export const runtime = "nodejs";

interface QuoteBody {
  src?:          string;
  dst?:          string;
  amount?:       string;
  destReceiver?: string;
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: QuoteBody;
  try {
    body = (await req.json()) as QuoteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Input validation ────────────────────────────────────────────────────
  if (!body.src || !isCCIPChain(body.src)) {
    return NextResponse.json({ error: "src must be one of eth/avax/arbitrum" }, { status: 400 });
  }
  if (!body.dst || !isCCIPChain(body.dst)) {
    return NextResponse.json({ error: "dst must be one of eth/avax/arbitrum" }, { status: 400 });
  }
  const src = body.src as CCIPChainKey;
  const dst = body.dst as CCIPChainKey;
  if (src === dst) {
    return NextResponse.json({ error: "src and dst must differ" }, { status: 400 });
  }
  if (!CCIP_CONFIG[src].supportedDestinations.includes(dst)) {
    return NextResponse.json({
      error: `Lane ${src} → ${dst} not supported`,
      supported: CCIP_CONFIG[src].supportedDestinations,
    }, { status: 400 });
  }
  if (!body.amount || !/^\d+$/.test(body.amount)) {
    return NextResponse.json({ error: "amount must be a non-negative integer string (raw 6-decimal USDC)" }, { status: 400 });
  }
  const amountRaw = BigInt(body.amount);
  if (amountRaw === 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }
  if (!body.destReceiver || !isAddress(body.destReceiver)) {
    return NextResponse.json({ error: "destReceiver must be a valid 0x address" }, { status: 400 });
  }

  // ── On-chain quote ──────────────────────────────────────────────────────
  let feeLink: bigint;
  let feeNative: bigint;
  try {
    const q = await quoteBridgeFee(src, dst, amountRaw, body.destReceiver);
    feeLink = q.link;
    feeNative = q.native;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "CCIP_QUOTE_FAILED", detail: msg.slice(0, 200) }, { status: 502 });
  }

  // ── USD estimates (rough — production should pull from price feed) ─────
  // Native USD differs per chain: ETH on eth/arb, AVAX on avax.
  const nativeUsdPerToken = src === "avax" ? 30 : 4000;
  const feeLinkUsd = feeToUsd(feeLink, "LINK", { LINK_USD: 12 });
  const feeNativeUsd = feeToUsd(feeNative, "native", { native_USD: nativeUsdPerToken });

  const linkWhole = Number(feeLink) / 1e18;
  const nativeWhole = Number(feeNative) / 1e18;

  return NextResponse.json({
    src,
    dst,
    amount: body.amount,
    destReceiver: body.destReceiver,
    fee: {
      link:   { raw: feeLink.toString(),   whole: linkWhole,   usd: feeLinkUsd },
      native: { raw: feeNative.toString(), whole: nativeWhole, usd: feeNativeUsd },
    },
    recommended: feeLinkUsd <= feeNativeUsd ? "link" : "native",
  });
}
