import { NextRequest, NextResponse } from "next/server";
import { ESCROW_ENABLED, getEscrowChain } from "@/app/lib/escrow-contracts";
import { escrowFacilitator } from "@/app/lib/escrow-relayer";

/**
 * GET /api/escrow/info?chain=bnb
 *
 * Public per-chain escrow config the SDK/MCP needs to build + sign an
 * EscrowLock witness and the EIP-7702 authorization: the vault, the lock impl
 * (the 7702 delegation target), the facilitator (relayer) the lock must name,
 * the token allowlist, decimals, and the two EIP-712 domain names. All of this
 * is public on-chain data — nothing secret is exposed.
 */
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!ESCROW_ENABLED) return NextResponse.json({ error: "Escrow is not enabled" }, { status: 503 });
  const chain = req.nextUrl.searchParams.get("chain") ?? "";
  const cfg = getEscrowChain(chain);
  if (!cfg) return NextResponse.json({ error: `Escrow is not live on chain '${chain}'` }, { status: 400 });
  const facilitator = escrowFacilitator(chain);
  if (!facilitator) return NextResponse.json({ error: "escrow relayer not configured" }, { status: 503 });
  return NextResponse.json({
    chain,
    chainId: cfg.chainId,
    rpc: cfg.rpc,
    vault: cfg.vault,
    lockImpl: cfg.lockImpl,
    facilitator,
    tokens: cfg.tokens,
    decimals: cfg.decimals,
    vaultDomainName: cfg.vaultDomainName,
    lockDomainName: cfg.lockDomainName,
    explorerTx: cfg.explorerTx,
  });
}
