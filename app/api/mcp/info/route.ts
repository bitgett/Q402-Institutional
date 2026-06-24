/**
 * GET /api/mcp/info
 *
 * Public discovery endpoint for the Q402 MCP server. Built so 8004scan
 * (and any other ERC-8004 indexer) can health-check the MCP "service"
 * declared in our agent metadata. Previously we declared the MCP
 * endpoint as `npm://@quackai/q402-mcp` — spec-legal but 8004scan's
 * HTTP-only crawler can't curl that scheme, so the service shows up
 * as "Unhealthy" with no way to verify.
 *
 * Replacing `npm://…` with this HTTPS URL gives the indexer something
 * to GET; the response payload still points at the npm package as the
 * authoritative install target.
 *
 * No auth, no rate-limit override — this is a discovery surface. CORS
 * `*` so 8004scan (or its frontend) can fetch cross-origin. Long-cache
 * headers because the contents only change when MCP releases a new
 * version.
 */

import { NextResponse } from "next/server";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version";

export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // The package version is the variable bit; a 5-minute cache hits the
  // sweet spot between "indexer sees fresh data after publish" and
  // "we don't hammer Vercel egress on every health check".
  "Cache-Control": "public, max-age=300, s-maxage=300",
} as const;

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      type: "https://eips.ethereum.org/EIPS/eip-8004#service.mcp",
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      transport: "stdio",
      registry: {
        npm: `https://www.npmjs.com/package/${PACKAGE_NAME}`,
        anthropicMcp: "https://registry.modelcontextprotocol.io",
      },
      install: {
        npx: `npx -y ${PACKAGE_NAME}@latest`,
        claudeCode: `claude mcp add q402 -- npx -y ${PACKAGE_NAME}@latest`,
      },
      tools: [
        { name: "q402_pay", description: "Execute a single gasless stablecoin payment." },
        { name: "q402_batch_pay", description: "Execute many payments in one relayed call." },
        { name: "q402_balance", description: "Read stablecoin holdings for the agent or user." },
        { name: "q402_quote", description: "Price a payment before signing." },
        { name: "q402_receipt", description: "Fetch and verify a Trust Receipt." },
        { name: "q402_agentic_info", description: "Read the connected Agent Wallet's snapshot incl. reputation." },
        { name: "q402_wallet_status", description: "Per-chain EIP-7702 delegation status for the configured EOA." },
        { name: "q402_doctor", description: "Diagnose configuration + chain health." },
        { name: "q402_clear_delegation", description: "Revoke an EIP-7702 delegation on demand." },
        { name: "q402_recurring_create", description: "Schedule a recurring payment." },
        { name: "q402_recurring_list", description: "List the caller's recurring payment rules." },
        { name: "q402_recurring_cancel", description: "Cancel a recurring payment rule." },
        { name: "q402_recurring_fires", description: "Per-rule fire history." },
        { name: "q402_recurring_pause", description: "Pause a recurring rule." },
        { name: "q402_recurring_resume", description: "Resume a paused recurring rule." },
        { name: "q402_recurring_skip_next", description: "Skip the next fire of a recurring rule." },
        { name: "q402_bridge_quote", description: "Quote the CCIP fee for a USDC bridge (LINK vs native)." },
        { name: "q402_bridge_send", description: "Execute a CCIP USDC bridge via the Agent Wallet (Mode C)." },
        { name: "q402_bridge_history", description: "Recent CCIP bridges for the configured wallet." },
        { name: "q402_bridge_gas_tank", description: "Bridge Gas Tank fee model + deposit address." },
        { name: "q402_yield_reserves", description: "List Q402 Yield markets + supply APY: Aave V3 on BNB, Morpho on Base." },
        { name: "q402_yield_positions", description: "The Agent Wallet's Aave/Morpho positions + aggregate USD value." },
        { name: "q402_yield_deposit", description: "Supply stablecoins into Aave (BNB, USDC/USDT) or Morpho (Base, USDC) to earn yield." },
        { name: "q402_yield_withdraw", description: "Withdraw stablecoin from Aave (BNB) or Morpho (Base) (amount \"max\" = full)." },
        { name: "q402_stake", description: "Stake Q (QuackAI) into QuackAiStake on BNB, gaslessly (Mode C; amount \"max\" supported)." },
        { name: "q402_unstake", description: "Unstake matured Q from QuackAiStake on BNB by record index, or all matured (Mode C)." },
        { name: "q402_stake_positions", description: "Read-only: the Agent Wallet's Q stakes (indices, maturity, exitable) + liquid Q." },
        { name: "q402_request_create", description: "Create a payment request (invoice); the creator sponsors the gas." },
        { name: "q402_request_status", description: "Read a payment request's status by id." },
        { name: "q402_request_pay", description: "Pay an open payment request from the Agent Wallet (Mode C)." },
      ],
      // Hint for indexers + humans — the canonical hosts.
      docs: "https://q402.quackai.ai/docs",
      dashboard: "https://q402.quackai.ai/dashboard",
      // Server-side timestamp so an aggressive cache can still tell the
      // payload is live (vs a 404 from a misrouted edge node).
      asOf: new Date().toISOString(),
    },
    { status: 200, headers: CORS_HEADERS },
  );
}
