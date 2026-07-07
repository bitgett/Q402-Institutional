/**
 * POST /api/wallet/agentic/memory-by-key
 *
 * Q402 Memory — read-only agent-treasury intelligence, authenticated by apiKey
 * alone (Mode C). Reads the owner's already-recorded stores server-side and
 * summarizes them; moves no money and needs no signature. The apiKey resolves
 * to the owner EOA, which is the exact key the relay-tx / recurring / request /
 * escrow stores are indexed by (the /api/transactions owner-sig gate is on the
 * ROUTE, not the store, so a by-key read here is safe and equivalent).
 *
 * Body: { apiKey, walletId?, action: "summary"|"vendor"|"agent", window?, vendor? }
 *   window ∈ "24h"|"7d"|"30d"|"all" (default "7d")
 *   vendor: address, only for action="vendor" (omit → vendor leaderboard)
 *
 * Powers MCP q402_memory_summary / q402_vendor_history / q402_agent_spend_report.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import { treasurySummary, vendorHistory, agentSpendReport, type MemoryWindow } from "@/app/lib/agentic-treasury";

export const runtime = "nodejs";
export const maxDuration = 30;

const WINDOWS = new Set(["24h", "7d", "30d", "all"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-memory-by-key", 12, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { apiKey?: string; walletId?: string; action?: string; window?: string; vendor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 400 });
  if (apiKey.startsWith("q402_test_") || apiKey.startsWith("q402_sandbox_")) {
    return NextResponse.json({ error: "SANDBOX_KEY_REJECTED", message: "Use a live apiKey for treasury memory." }, { status: 401 });
  }
  const rec = await getApiKeyRecord(apiKey);
  if (!rec || !rec.active || rec.isSandbox) {
    return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  }
  const owner = rec.address.toLowerCase();

  // Scope to a single Agent Wallet only if the caller owns it (else 404, never silently owner-wide).
  let walletId: string | undefined;
  if (typeof body.walletId === "string" && body.walletId) {
    const w = await resolveWallet(owner, body.walletId.toLowerCase());
    if (!w) return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
    walletId = w.address.toLowerCase();
  }
  const window: MemoryWindow = WINDOWS.has(body.window ?? "") ? (body.window as MemoryWindow) : "7d";

  try {
    switch (body.action) {
      case "summary":
        return NextResponse.json(await treasurySummary(owner, walletId, window));
      case "vendor":
        return NextResponse.json(await vendorHistory(owner, walletId, typeof body.vendor === "string" && body.vendor ? body.vendor : undefined, window));
      case "agent":
        return NextResponse.json(await agentSpendReport(owner, window));
      default:
        return NextResponse.json({ error: "INVALID_ACTION", message: "action must be summary | vendor | agent" }, { status: 400 });
    }
  } catch (e) {
    console.error("[memory-by-key]", e);
    return NextResponse.json({ error: "memory_read_failed" }, { status: 502 });
  }
}
