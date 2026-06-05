/**
 * GET /api/ccip/lanes
 *
 * Returns the supported CCIP bridge lane matrix. Public (no auth) —
 * this is just a routing table, identical for every caller.
 *
 * Response shape:
 *   {
 *     version: "1.6.0",
 *     chains: ["eth", "avax", "arbitrum"],
 *     lanes: [
 *       { src: "eth",      dst: "avax",     senderContract: "0x..." },
 *       { src: "eth",      dst: "arbitrum", senderContract: "0x..." },
 *       { src: "avax",     dst: "eth",      senderContract: "0x..." },
 *       { src: "avax",     dst: "arbitrum", senderContract: "0x..." },
 *       { src: "arbitrum", dst: "eth",      senderContract: "0x..." },
 *       { src: "arbitrum", dst: "avax",     senderContract: "0x..." },
 *     ]
 *   }
 *
 * Frontends use this to populate source/dest dropdowns. MCP tools use it
 * to validate quote/send args before submitting. Drift between this and
 * the on-chain pool config is caught by ccip-config.test.ts.
 */

import { NextResponse } from "next/server";
import { CCIP_CONFIG, CCIP_CHAINS, ccipLaneMatrix } from "@/app/lib/ccip";
import manifest from "../../../../contracts.manifest.json";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const lanes = ccipLaneMatrix().map(({ src, dst }) => ({
    src,
    dst,
    senderContract: CCIP_CONFIG[src].sender,
  }));

  return NextResponse.json({
    version:    manifest.ccip.version,
    chains:     CCIP_CHAINS,
    lanes,
    feeTokens:  manifest.ccip.feeTokens,
    feePolicy:  manifest.ccip.feePolicy,
  });
}
