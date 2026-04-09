import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { getRelayedTxs } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";

const PROVISION_MSG = (addr: string) =>
  `Q402 API Key Request\nAddress: ${addr.toLowerCase()}`;

/**
 * GET /api/transactions?address=0x...&sig=0x...
 *
 * Returns relayed TX history for the given address.
 * Requires the same EIP-191 signature used for provisioning (cached in sessionStorage).
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "transactions", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address   = req.nextUrl.searchParams.get("address");
  const signature = req.nextUrl.searchParams.get("sig");

  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
  if (!signature) return NextResponse.json({ error: "sig required" }, { status: 400 });

  const addr = address.toLowerCase();

  // Verify wallet ownership — same message as provision
  try {
    const recovered = ethers.verifyMessage(PROVISION_MSG(addr), signature);
    if (recovered.toLowerCase() !== addr) throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const txs = await getRelayedTxs(addr);

  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthCount = txs.filter(tx => new Date(tx.relayedAt) >= monthStart).length;

  return NextResponse.json({ txs, thisMonthCount, totalCount: txs.length });
}
