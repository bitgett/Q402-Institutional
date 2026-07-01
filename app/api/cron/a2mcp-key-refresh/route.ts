import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/app/lib/cron-auth";
import { refreshRelayKeyIfNeeded } from "@/app/lib/a2mcp-key";

/**
 * Daily: keep the free A2MCP /pay relay key alive. Trial keys (the only gas-FREE
 * option) expire after 30 days; this re-provisions a fresh one shortly before
 * expiry so /pay never silently dies, at zero cost and with no manual step.
 * No-ops until the current key is within a week of expiring.
 */
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const denial = requireCronAuth(req);
  if (denial) return denial;
  const base = process.env.A2MCP_SELF_BASE ?? "https://q402.quackai.ai";
  try {
    const r = await refreshRelayKeyIfNeeded(base);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "refresh failed" }, { status: 500 });
  }
}
