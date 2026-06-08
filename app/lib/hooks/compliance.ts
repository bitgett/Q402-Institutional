/**
 * Q402 Hook #1 — ComplianceGate.
 *
 * Lifecycle: beforeAuthorize (blocks the SIGNATURE itself, before any
 * idempotency claim or daily-limit charge — a sanctioned recipient is
 * rejected outright, consuming no reservation).
 *
 * GLOBAL, not per-wallet opt-in: compliance screening applies to every
 * payment from every wallet. There is no config to disable it.
 *
 * Source of truth: a daily cron (/api/cron/ofac-refresh) populates a KV
 * SET `ofac:sanctioned` with the OFAC-sanctioned EVM addresses (lowercased)
 * and a `ofac:meta` record with the last refresh time + count. The hook
 * does an O(1) SISMEMBER on the recipient.
 *
 * ── The availability / fail-closed tension ──
 *
 * Pure fail-closed compliance ("block if you can't verify") is legally
 * conservative but operationally catastrophic — a single cron hiccup
 * would halt 100% of payments. The resolution:
 *
 *   - The KV set has NO TTL. A late/failed cron does NOT empty it; the
 *     last good snapshot persists. So "stale" means "data is a day old",
 *     not "data is gone" — membership checks stay meaningful.
 *   - A confirmed membership → deny COMPLIANCE_BLOCKED (the real action).
 *   - A KV READ ERROR (set genuinely unreachable) → the hook throws,
 *     and with failMode "closed" the dispatcher denies COMPLIANCE_ERROR.
 *     This is the only "couldn't check at all" path.
 *   - A STALE list (meta missing or > 48h) does NOT block by default —
 *     it fires a throttled ops alert so the cron gets fixed, while the
 *     still-populated set keeps screening. A compliance-strict
 *     deployment sets OFAC_STALE_BEHAVIOR=block to halt instead.
 */

import { kv } from "@vercel/kv";
import type { Hook, HookContext, HookOutcome } from "./types";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

const SANCTIONED_SET_KEY = "ofac:sanctioned";
const META_KEY = "ofac:meta";
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const STALE_ALERT_DEDUP_KEY = "ofac:stale-alert"; // SETNX, 12h TTL

interface OfacMeta {
  lastRefresh: number;
  count: number;
  source: string;
}

interface KvSetOps {
  sismember: (key: string, member: string) => Promise<number>;
  sadd: (key: string, ...members: string[]) => Promise<number>;
  scard: (key: string) => Promise<number>;
}

function setOps(): KvSetOps {
  return kv as unknown as KvSetOps;
}

/**
 * O(1) membership check against the sanctioned set. Throws on KV error
 * so the dispatcher's fail-closed path engages — a recipient we cannot
 * screen is treated as unscreenable, not as clean.
 */
export async function isSanctioned(address: string): Promise<boolean> {
  const member = address.toLowerCase();
  const r = await setOps().sismember(SANCTIONED_SET_KEY, member);
  return r === 1;
}

/**
 * Replace the sanctioned set with a fresh snapshot. Called by the cron.
 * Guards against wiping the good list with a bad fetch: refuses to apply
 * an empty list (a 404 returning HTML, a network blip) — the caller must
 * have validated a non-empty address list first.
 *
 * NOTE: this ADDs to the set rather than recreating it, because Upstash
 * has no atomic "replace set" and DEL+SADD has a window where the set is
 * empty (screening gap). Sanctioned addresses are only ever ADDED to the
 * OFAC list in practice (removals are rare and handled by a separate
 * reconcile path, deferred to a later phase), so additive refresh keeps
 * screening continuous.
 */
export async function applySanctionedSnapshot(
  addresses: string[],
  source: string,
): Promise<{ added: number; total: number }> {
  if (addresses.length === 0) {
    throw new Error("refusing to apply an empty sanctioned snapshot");
  }
  const lowered = addresses
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (lowered.length === 0) {
    throw new Error("snapshot contained no valid 0x addresses");
  }
  // SADD in chunks — Upstash caps args per call.
  let added = 0;
  for (let i = 0; i < lowered.length; i += 1000) {
    const chunk = lowered.slice(i, i + 1000);
    added += await setOps().sadd(SANCTIONED_SET_KEY, ...chunk);
  }
  const total = await setOps().scard(SANCTIONED_SET_KEY);
  const meta: OfacMeta = { lastRefresh: Date.now(), count: total, source };
  await kv.set(META_KEY, meta);
  return { added, total };
}

export async function getOfacMeta(): Promise<OfacMeta | null> {
  try {
    return (await kv.get<OfacMeta>(META_KEY)) ?? null;
  } catch {
    return null;
  }
}

export const complianceGate: Hook = {
  name: "ComplianceGate",
  lifecycle: "beforeAuthorize",
  failMode: "closed",

  // Always runs — compliance is not opt-in.
  shouldRun(): boolean {
    return true;
  },

  async run(ctx: HookContext): Promise<HookOutcome> {
    // Membership check first — this is the actual screen. A KV throw
    // here propagates to the dispatcher → fail-closed deny.
    const sanctioned = await isSanctioned(ctx.recipient);
    if (sanctioned) {
      return {
        action: "deny",
        code: "COMPLIANCE_BLOCKED",
        reason: "Recipient is on the OFAC sanctioned-address list. This payment cannot be processed.",
        status: 451, // Unavailable For Legal Reasons
        meta: { recipient: ctx.recipient.toLowerCase() },
      };
    }

    // Staleness: alert (or, if strict, block) when the list is old. This
    // runs AFTER a clean membership check, so a stale-but-populated list
    // still screened the recipient above.
    await checkStaleness(ctx);

    return { action: "allow" };
  },
};

async function checkStaleness(ctx: HookContext): Promise<HookOutcome | void> {
  const meta = await getOfacMeta();
  const isStale = !meta || Date.now() - meta.lastRefresh > STALE_AFTER_MS;
  if (!isStale) return;

  const strict = process.env.OFAC_STALE_BEHAVIOR === "block";
  if (strict) {
    // Compliance-strict deployment: a stale list halts the rail. The
    // dispatcher returns this deny; ops must refresh to resume.
    throw new Error(
      `OFAC list stale (lastRefresh=${meta?.lastRefresh ?? "never"}) and OFAC_STALE_BEHAVIOR=block`,
    );
  }

  // Default: alert, don't block. Throttle to one page per 12h.
  try {
    const claimed = await kv.set(STALE_ALERT_DEDUP_KEY, "1", { nx: true, ex: 12 * 60 * 60 });
    if (claimed === "OK") {
      void sendOpsAlert(
        `<b>⚠ OFAC screening list is STALE</b>\n\n` +
        `Last refresh: ${meta ? new Date(meta.lastRefresh).toISOString() : "NEVER"}\n` +
        `Set size: ${meta?.count ?? "unknown"}\n` +
        `Source: ${meta?.source ?? "unknown"}\n\n` +
        `Screening is still running against the last good snapshot, but the ` +
        `ofac-refresh cron hasn't updated in >48h. Check the cron + ` +
        `OFAC_LIST_URL. Set OFAC_STALE_BEHAVIOR=block to halt the rail on ` +
        `staleness instead of alerting. (Triggered on a payment to ` +
        `${ctx.recipient.toLowerCase()}.)`,
        "warn",
      ).catch(() => { /* best-effort */ });
    }
  } catch {
    /* alert dedup KV blip — non-fatal */
  }
}
