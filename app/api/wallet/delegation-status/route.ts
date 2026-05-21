/**
 * GET /api/wallet/delegation-status?address=0x...
 *
 * Reports the EIP-7702 delegation state of `address` across all 9 Q402
 * chains in a single response. Read-only — runs 9 parallel
 * `eth_getCode` calls behind the server's RPC fan-out (so the caller
 * doesn't have to deal with CORS / rate limits on public RPCs).
 *
 * No auth — the data is fully on-chain and public. The endpoint exists
 * so the MCP `q402_wallet_status` tool (and any future client) can fetch
 * a per-EOA snapshot in one round trip instead of fanning out itself.
 *
 * Rate limit: composite `ip:address`, generous (60/hour per pair) — this
 * is a polling-friendly read endpoint, not the actual broadcast. Keying
 * on the pair instead of address-only prevents a noisy caller from
 * burning a victim's hourly read budget by polling
 * `?address=<victim>` (UX DoS even though the underlying data is public).
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { getAllDelegationStates } from "@/app/lib/eip7702";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json(
      { error: "INVALID_ADDRESS", hint: "Pass ?address=0x... (20-byte hex)." },
      { status: 400 },
    );
  }

  // Composite IP+address quota. Address-only would let any caller burn
  // a victim's hourly read budget (60/h) by hammering /api/wallet/
  // delegation-status?address=victim — UX DoS even though the underlying
  // data is public on-chain. With ip:address as the key, each (caller, target)
  // pair has its own bucket and a noisy address can't lock out anyone else.
  const ip   = getClientIP(req) || "unknown";
  const rlId = `${ip}:${address.toLowerCase()}`;
  const allowed = await rateLimit(rlId, "wallet-delegation-status", 60, 3600);
  if (!allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterSec: 3600 },
      { status: 429 },
    );
  }

  const states = await getAllDelegationStates(address);
  const delegatedCount = states.filter(s => s.delegated).length;

  return NextResponse.json({
    address,
    chains: Object.fromEntries(
      states.map(s => [
        s.chain,
        s.error
          ? { delegated: false, error: s.error }
          : s.delegated
            ? { delegated: true, impl: s.impl }
            : { delegated: false },
      ]),
    ),
    summary: `${delegatedCount} of ${states.length} chains delegated`,
  });
}
