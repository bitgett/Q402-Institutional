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
 * Auth: ADMIN_SECRET via `x-q402-admin-key` header. The weekly cron
 * uses CRON_SECRET (Vercel-managed, also shared with the Render
 * heartbeat), but THIS route triggers a real BNB-spending action on an
 * operator-supplied agentId — too dangerous to share its auth with the
 * driver pool. Holders of CRON_SECRET can fire the weekly cadence; only
 * holders of ADMIN_SECRET can fire arbitrary agents.
 *
 * Allow-list: even with ADMIN_SECRET we only fire feedback for agents
 * that actually exist in our KV (i.e. graduated Q402 wallets). This
 * blocks the misuse case "ADMIN_SECRET holder writes reputation for a
 * non-Q402 agent" — gas costs ~$0.07 per call but the bigger risk is
 * having the relayer publish opinions about agents Q402 doesn't own.
 *
 * Side-effects: one BSC tx, ~$0.07-0.10 of relayer BNB.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { timingSafeEqual } from "node:crypto";

import {
  currentIsoWeek,
  fireWeeklyFeedback,
  parseAgentIdTag,
} from "@/app/lib/erc8004-reputation";
import type { AgenticWalletRecord } from "@/app/lib/agentic-wallet";

export const runtime = "nodejs";
export const maxDuration = 90;

const RELAY_ENDPOINT = "https://q402.quackai.ai/api/relay/info";
const SCAN_COUNT = 200;
const MAX_SCAN_ITERS = 200;

/** Constant-time `x-q402-admin-key` check. Returns `null` on success,
 *  a 401/503 response on failure. */
function requireAdminAuth(req: NextRequest): NextResponse | null {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || adminSecret.length === 0) {
    return NextResponse.json(
      { error: "ADMIN_SECRET unset — refusing to run." },
      { status: 503 },
    );
  }
  const presented = req.headers.get("x-q402-admin-key") ?? "";
  if (presented.length !== adminSecret.length) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(adminSecret))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Identify the multi-wallet record keys (aw:{owner}:{walletId}). */
function isRecordKey(key: string): boolean {
  if (!key.startsWith("aw:")) return false;
  for (const prefix of [
    "aw:export-log:",
    "aw:daily-spend:",
    "aw:daily-spend-c:",
    "aw:batch:",
    "aw:send:",
    "aw:list:",
    "aw:default:",
    "aw:register-tx:",
    "aw:balance:",
    "aw:agent-md:",
    "aw:rep-week:",
    "aw:rep-cache:",
  ]) {
    if (key.startsWith(prefix)) return false;
  }
  const rest = key.slice("aw:".length);
  const parts = rest.split(":");
  if (parts.length === 1) return true; // legacy
  if (parts.length === 2 && /^0x[0-9a-fA-F]{40}$/.test(parts[1])) return true;
  return false;
}

/**
 * Verify the operator-supplied numeric agentId actually corresponds to
 * one of Q402's graduated wallets. Returns true iff some active wallet
 * record has `erc8004AgentId` ending in `:{agentId}` (or equal to it
 * for the legacy raw-numeric form).
 *
 * Scans all `aw:*` keys, classifies records, parses the agent tag.
 * Bounded by MAX_SCAN_ITERS. KV at current scale comfortably under
 * 10k records — well below the timeout.
 */
async function agentIdExistsInKv(agentId: bigint): Promise<boolean> {
  let cursor: string | number = 0;
  let iters = 0;
  do {
    const res: [string | number, string[]] = await kv.scan(cursor, {
      match: "aw:*",
      count: SCAN_COUNT,
    });
    cursor = res[0];
    iters++;
    for (const key of res[1]) {
      if (!isRecordKey(key)) continue;
      const record = await kv.get<AgenticWalletRecord>(key);
      if (!record || !record.erc8004AgentId) continue;
      if (record.deletedAt) continue;
      const parsed = parseAgentIdTag(record.erc8004AgentId);
      if (parsed !== null && parsed === agentId) return true;
    }
  } while (cursor !== "0" && cursor !== 0 && iters < MAX_SCAN_ITERS);
  return false;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireAdminAuth(req);
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

  // Block fires against agentIds that Q402 doesn't own. Misuse fence:
  // ADMIN_SECRET leak + arbitrary agentId would let the attacker burn
  // relayer BNB writing opinions on someone else's agent.
  const owned = await agentIdExistsInKv(agentId);
  if (!owned) {
    return NextResponse.json(
      {
        error: "AGENT_NOT_OWNED",
        message:
          "agentId is not associated with any active Q402 graduated wallet. " +
          "reputation-smoke refuses to fire against unknown agents.",
        agentId: agentId.toString(),
      },
      { status: 403 },
    );
  }

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
