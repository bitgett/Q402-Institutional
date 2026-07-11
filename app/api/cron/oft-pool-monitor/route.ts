import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { formatEther } from "ethers";
import { OFT_CHAINS, OFT_CONFIG, getOftProvider, type OftChainKey } from "@/app/lib/usdt0";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

/**
 * GET /api/cron/oft-pool-monitor
 *
 * Called by Vercel Cron (vercel.json) every 6 hours.
 * Outer guard: Vercel-issued `Authorization: Bearer ${CRON_SECRET}` (fail-closed
 * if unset).
 *
 * ALERT-ONLY, NEVER SWEEPS. Each Q402OftSender holds a NATIVE pool that pays the
 * LayerZero fee (native-only); the pool == the sender's own native balance. Unlike
 * the CCIP senders, OFT pools have NO auto-refill cron — deliberately, because the
 * LayerZero fee is tiny (~$0.20/bridge) and an on-chain sweep to refill it would
 * cost more gas than it moves, especially on Ethereum. So instead of sweeping we
 * just READ the balances (free) and Telegram an operator when a pool is low, who
 * tops it up manually (from the relay, or from an exchange for the thin-native
 * chains). This trades a little manual work for zero wasted sweep gas.
 *
 * "Low" = the pool covers fewer than OFT_POOL_MIN_BRIDGES bridges of runway at the
 * chain's reference fee. `refFee` is a real measured native fee per bridge (from
 * on-chain quotes 2026-07-12); it only feeds the human-readable "~N bridges left"
 * estimate and the threshold, so a little drift is fine — the operator re-checks
 * the live quote before topping up.
 */

const MIN_BRIDGES = Number(process.env.OFT_POOL_MIN_BRIDGES ?? "3");

// Measured native LayerZero fee per 1-USDT0 bridge + native symbol, per chain.
const CHAIN_META: Record<OftChainKey, { refFee: number; symbol: string }> = {
  eth:      { refFee: 0.00006, symbol: "ETH" },
  arbitrum: { refFee: 0.00006, symbol: "ETH" },
  mantle:   { refFee: 0.052,   symbol: "MNT" },
  monad:    { refFee: 4.52,    symbol: "MON" },
  xlayer:   { refFee: 0.00142, symbol: "OKB" },
};

type PoolStatus = {
  chain: OftChainKey;
  sender: string;
  balance: number;   // native, whole units
  bridges: number;   // floor(balance / refFee)
  low: boolean;
  error?: string;
};

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = cronSecret ? `Bearer ${cronSecret}` : "";
  if (
    !cronSecret ||
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read every pool balance in parallel. A per-chain RPC failure must not sink the
  // whole sweep — record it and keep going (an unreadable pool is itself worth an
  // alert, since we can't confirm it's funded).
  const pools: PoolStatus[] = await Promise.all(
    OFT_CHAINS.map(async (chain): Promise<PoolStatus> => {
      const sender = OFT_CONFIG[chain].sender;
      const { refFee } = CHAIN_META[chain];
      if (!sender) {
        return { chain, sender: "", balance: 0, bridges: 0, low: true, error: "no sender configured" };
      }
      try {
        const raw = await getOftProvider(chain).getBalance(sender);
        const balance = Number(formatEther(raw));
        const bridges = Math.floor(balance / refFee);
        return { chain, sender, balance, bridges, low: bridges < MIN_BRIDGES };
      } catch (e) {
        return {
          chain, sender, balance: 0, bridges: 0, low: true,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  const low = pools.filter((p) => p.low);
  let alertSent = false;

  if (low.length > 0) {
    // A pool that can't cover even one bridge (or that we couldn't read) is an
    // error; a merely-thin pool is a warning.
    const severity = low.some((p) => p.error || p.bridges === 0) ? "error" : "warn";
    const lines = low.map((p) => {
      const meta = CHAIN_META[p.chain];
      if (p.error) return `• ${p.chain}: UNREADABLE (${p.error}) — sender ${p.sender || "unset"}`;
      return `• ${p.chain}: ${p.balance.toFixed(6)} ${meta.symbol} (~${p.bridges} bridge${p.bridges === 1 ? "" : "s"} left) — sender ${p.sender}`;
    });
    await sendOpsAlert(
      `OFT bridge pool${low.length > 1 ? "s" : ""} low (< ${MIN_BRIDGES} bridges runway). Top up the sender's native balance from the relay, or from an exchange for thin-native chains.\n${lines.join("\n")}`,
      severity,
    );
    alertSent = true;
  }

  return NextResponse.json({
    checked: pools.length,
    minBridges: MIN_BRIDGES,
    low: low.map((p) => ({ chain: p.chain, bridges: p.bridges, balance: p.balance, error: p.error })),
    pools: pools.map((p) => ({ chain: p.chain, bridges: p.bridges, balance: Number(p.balance.toFixed(6)) })),
    alertSent,
    timestamp: new Date().toISOString(),
  });
}
