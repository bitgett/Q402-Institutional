/**
 * GET /api/redstone/feeds
 *
 * Public discovery of this deployment's RedStone trigger configuration: whether
 * the feature is enabled and which feed ids are readable (the allowlist a
 * trigger's feedId must be in). No secrets — the feed list and data-service id
 * are public RedStone facts. Backs the no-key q402_redstone_feeds MCP tool and
 * the dashboard's trigger builder so a user knows what to type before creating a
 * trigger.
 */

import { NextResponse } from "next/server";
import { redstoneConfig } from "@/app/lib/redstone";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const cfg = redstoneConfig();
  return NextResponse.json({
    enabled: cfg.enabled,
    dataServiceId: cfg.dataServiceId,
    allowedFeeds: cfg.allowedFeeds,
    uniqueSigners: cfg.uniqueSigners,
    staleAfterSec: cfg.staleAfterSec,
  });
}
