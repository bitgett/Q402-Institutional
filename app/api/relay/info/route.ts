import { NextResponse } from "next/server";
import { loadRelayerKey } from "@/app/lib/relayer-key";

/**
 * GET /api/relay/info
 *
 * Returns the relayer (facilitator) wallet address.
 * Required by the Q402 SDK for X Layer EIP-7702 mode — the facilitator address
 * must be included in the EIP-712 TransferAuthorization signature before relay.
 *
 * Validates that the env-derived address matches RELAYER_ADDRESS — if the env
 * is wrong, fails closed (503) rather than returning a wallet that the dashboard
 * and Telegram alerts won't recognize.
 */
export async function GET() {
  const key = loadRelayerKey();
  if (!key.ok) {
    return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
  }
  // The facilitator address is effectively constant; edge-cache it so the SDK /
  // dashboard reads hit the CDN. Success only (the 503 above stays uncached).
  const res = NextResponse.json({ facilitator: key.address });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return res;
}
