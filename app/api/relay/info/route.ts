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
  return NextResponse.json({ facilitator: key.address });
}
