import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/**
 * GET /api/relay/info
 *
 * Returns the relayer (facilitator) wallet address.
 * Required by the Q402 SDK for X Layer EIP-7702 mode — the facilitator address
 * must be included in the EIP-712 TransferAuthorization signature before relay.
 */
export async function GET() {
  const pkRaw = process.env.RELAYER_PRIVATE_KEY;
  if (!pkRaw || pkRaw === "your_private_key_here") {
    return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
  }

  const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as Hex;
  const account = privateKeyToAccount(pk);

  return NextResponse.json({ facilitator: account.address });
}
