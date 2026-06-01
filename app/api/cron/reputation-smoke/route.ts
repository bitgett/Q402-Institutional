/**
 * GET /api/cron/reputation-smoke?agentId=124025&activeDays=1
 *
 * Operator-only smoke test for the ERC-8004 reputation pipeline. Fires
 * a SINGLE `giveFeedback` against the supplied agentId from the Q402
 * relayer master key, bypassing the weekly cron's top-N ranking + the
 * ISO-week ledger. Lets us verify the write path lands on-chain (and
 * appears on 8004scan) before the first Sunday cron has any real
 * candidates to fire on.
 *
 * Auth: same cron secret as the weekly route. Not user-facing.
 * Side-effects: one BSC tx, ~$0.07-0.10 of relayer BNB.
 *
 * NOT a hot-path route — kept around post-launch as an ops button for
 * manually nudging a specific agent's reputation (e.g. when 8004scan
 * surface a stale display and we want to push fresh feedback).
 */

import { NextRequest, NextResponse } from "next/server";

import { requireCronAuth } from "@/app/lib/cron-auth";
import {
  currentIsoWeek,
  fireWeeklyFeedback,
} from "@/app/lib/erc8004-reputation";

export const runtime = "nodejs";
export const maxDuration = 60;

const RELAY_ENDPOINT = "https://q402.quackai.ai/api/relay/info";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const url = new URL(req.url);
  const rawAgentId = url.searchParams.get("agentId");
  const rawDays = url.searchParams.get("activeDays") ?? "1";

  if (!rawAgentId || !/^\d+$/.test(rawAgentId)) {
    return NextResponse.json(
      { error: "agentId required (positive integer)" },
      { status: 400 },
    );
  }
  const activeDays = Number(rawDays);
  if (!Number.isFinite(activeDays) || activeDays < 0 || activeDays > 7) {
    return NextResponse.json(
      { error: "activeDays must be 0..7" },
      { status: 400 },
    );
  }

  const agentId = BigInt(rawAgentId);
  const isoWeek = currentIsoWeek();

  try {
    const txHash = await fireWeeklyFeedback({
      agentId,
      settlements7d: activeDays,
      isoWeek,
      endpoint: RELAY_ENDPOINT,
      feedbackURI: "",
    });
    return NextResponse.json({
      ok: true,
      agentId: agentId.toString(),
      isoWeek,
      activeDays,
      txHash,
      bscscan: `https://bscscan.com/tx/${txHash}`,
      scan8004: `https://8004scan.io/agents/bsc/${agentId.toString()}`,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[reputation-smoke] giveFeedback failed:", e);
    return NextResponse.json({ error: "giveFeedback_failed", reason }, { status: 502 });
  }
}
