/**
 * GET /api/cron/ofac-refresh
 *
 * Daily refresh of the OFAC sanctioned-address set that ComplianceGate
 * (#1) screens against. Fetches a newline-delimited list of sanctioned
 * EVM addresses, validates it's a non-empty list of real 0x addresses,
 * and ADDs them to the `ofac:sanctioned` KV set (additive — see
 * applySanctionedSnapshot for why we don't DEL+recreate).
 *
 * Source: OFAC_LIST_URL (default: the widely-used 0xB10C
 * ofac-sanctioned-digital-currency-addresses ETH list, which is derived
 * from the official Treasury SDN list via CI). The ETH-format file
 * covers all EVM addresses since they share the 0x20-byte format.
 * Point OFAC_LIST_URL at an internal authoritative mirror for a
 * compliance-strict deployment.
 *
 * Safety: a fetch that returns non-list garbage (HTML 404 page, empty
 * body) is REJECTED before touching KV — `applySanctionedSnapshot`
 * throws on an empty/invalid snapshot, so the last good set survives a
 * bad source.
 *
 * Auth: shared CRON_SECRET (requireCronAuth, timing-safe, fail-closed).
 * Schedule: daily (external heartbeat or Vercel cron).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/app/lib/cron-auth";
import { applySanctionedSnapshot } from "@/app/lib/hooks/compliance";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_LIST_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();
  const url = process.env.OFAC_LIST_URL || DEFAULT_LIST_URL;

  let text: string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await recordCronStatus(CRON_NAMES.OFAC_REFRESH, {
      lastStatus: "error",
      lastError: `fetch_failed: ${err}`,
      durationMs: Date.now() - startedAt,
    });
    void sendOpsAlert(
      `<b>🚨 OFAC refresh fetch FAILED</b>\n\nURL: ${url}\nError: ${err}\n\n` +
      `The existing sanctioned set is untouched (still screening). Fix the ` +
      `source or set OFAC_LIST_URL.`,
      "error",
    ).catch(() => {});
    return NextResponse.json({ error: "fetch_failed", detail: err }, { status: 502 });
  }

  // Parse: one address per line, tolerate comments / blank lines.
  const addresses = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l));

  if (addresses.length === 0) {
    await recordCronStatus(CRON_NAMES.OFAC_REFRESH, {
      lastStatus: "error",
      lastError: "empty_or_invalid_list",
      durationMs: Date.now() - startedAt,
    });
    void sendOpsAlert(
      `<b>🚨 OFAC refresh got an EMPTY/invalid list</b>\n\nURL: ${url}\n` +
      `Parsed 0 valid addresses from ${text.length} bytes. Existing set ` +
      `untouched. Likely a 404 returning HTML or a moved source.`,
      "error",
    ).catch(() => {});
    return NextResponse.json({ error: "empty_list" }, { status: 502 });
  }

  let result: { added: number; total: number };
  try {
    result = await applySanctionedSnapshot(addresses, url);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await recordCronStatus(CRON_NAMES.OFAC_REFRESH, {
      lastStatus: "error",
      lastError: `apply_failed: ${err}`,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "apply_failed", detail: err }, { status: 500 });
  }

  await recordCronStatus(CRON_NAMES.OFAC_REFRESH, {
    lastStatus: "success",
    lastResult: { fetched: addresses.length, added: result.added, total: result.total, source: url },
    durationMs: Date.now() - startedAt,
  });

  return NextResponse.json({
    fetched: addresses.length,
    added: result.added,
    total: result.total,
    source: url,
    durationMs: Date.now() - startedAt,
    asOf: new Date().toISOString(),
  });
}
