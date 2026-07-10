/**
 * GET /api/oft/confirm?src=<chain>&txHash=0x...
 *
 * Public delivery poll for a USDT0 (LayerZero OFT) bridge. Companion to
 * /api/ccip/confirm. LayerZero delivery is asynchronous; this queries the
 * LayerZero Scan API by the source transaction hash and maps the message
 * status to pending | delivered | failed | unknown.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { isOftChain } from "@/app/lib/usdt0";

export const runtime = "nodejs";
export const maxDuration = 20;

const LZ_SCAN_API = "https://scan.layerzero-api.com/v1/messages/tx";

interface LzMessage {
  status?: { name?: string };
  destination?: { tx?: { txHash?: string } };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "oft-confirm", 60, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const src = req.nextUrl.searchParams.get("src");
  const txHash = req.nextUrl.searchParams.get("txHash");
  if (!src || !isOftChain(src)) {
    return NextResponse.json({ error: "src must be one of eth/arbitrum/mantle/monad/xlayer" }, { status: 400 });
  }
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "txHash must be a 32-byte hex string" }, { status: 400 });
  }

  try {
    const res = await fetch(`${LZ_SCAN_API}/${txHash}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return NextResponse.json({ status: "unknown", detail: `LZ scan HTTP ${res.status}` }, { status: 200 });
    }
    const json = (await res.json()) as { data?: LzMessage[] };
    const msg = json.data?.[0];
    if (!msg) {
      // Not indexed yet — the source tx may be very fresh.
      return NextResponse.json({ status: "pending", note: "Not yet indexed by LayerZero Scan." }, { status: 200 });
    }
    const name = (msg.status?.name ?? "").toUpperCase();
    const status =
      name === "DELIVERED" ? "delivered" :
      name === "FAILED" || name === "BLOCKED" || name === "PAYLOAD_STORED" ? "failed" :
      name === "INFLIGHT" || name === "CONFIRMING" ? "pending" : "unknown";
    return NextResponse.json({
      status,
      lzStatus: name || null,
      dstTxHash: msg.destination?.tx?.txHash ?? null,
    }, { status: 200 });
  } catch (e) {
    return NextResponse.json({
      status: "unknown",
      detail: e instanceof Error ? e.message.slice(0, 150) : "poll failed",
    }, { status: 200 });
  }
}
