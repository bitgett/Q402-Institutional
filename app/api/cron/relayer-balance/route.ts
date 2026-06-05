/**
 * GET /api/cron/relayer-balance
 *
 * Per-chain on-chain balance probe for the Q402 relayer hot wallet.
 * For each supported chain the cron:
 *   1. Fetches the relayer EOA balance + current maxFeePerGas
 *   2. Computes a one-tx settle cost ceiling (360k gas × maxFeePerGas)
 *   3. Compares to a per-chain "min headroom" threshold (3× one-tx
 *      cost), so the alert fires while there's still time to top up
 *      before the route-level pre-flight check (FIX 26) starts
 *      returning RELAYER_LOW to live callers.
 *   4. Emits one consolidated Telegram alert if any chain is below
 *      threshold.
 *
 * Idempotent — safe to run on whatever cadence (Render heartbeat,
 * Vercel cron, manual curl). State is stored under
 * `cron:relayer-balance:lastAlert:{chain}` with a 6h cooldown so a
 * single low-balance condition doesn't spam the ops channel every
 * tick.
 *
 * Auth: shared CRON_SECRET via Authorization header (timing-safe).
 *
 * Read-only against on-chain state. KV writes only update the alert
 * cooldown bookkeeping + a status row for /api/admin/cron-status.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { JsonRpcProvider, formatEther } from "ethers";
import { requireCronAuth } from "@/app/lib/cron-auth";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { loadRelayerKey } from "@/app/lib/relayer-key";
import { CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Chains to monitor. Mirrors the live settlement surface; sandbox-only
 * chains don't need a hot wallet. Update in lockstep with any new chain
 * addition.
 */
const MONITORED_CHAINS: ChainKey[] = [
  "bnb",
  "eth",
  "avax",
  "xlayer",
  "stable",
  "mantle",
  "injective",
  "monad",
  "scroll",
  "arbitrum",
];

/**
 * 6h cooldown per chain so we don't fire the same alert every tick of
 * a frequent cron (Render heartbeat = 5 min).
 */
const ALERT_COOLDOWN_SEC = 6 * 60 * 60;

function lastAlertKey(chain: string): string {
  return `cron:relayer-balance:lastAlert:${chain}`;
}

interface ChainProbe {
  chain:           ChainKey;
  balanceEth:      number;
  oneTxCostEth:    number;
  minSafeEth:      number;
  belowThreshold:  boolean;
  error?:          string;
}

async function probeChain(chain: ChainKey, relayer: string): Promise<ChainProbe> {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.rpc) {
    return { chain, balanceEth: 0, oneTxCostEth: 0, minSafeEth: 0, belowThreshold: false, error: "no_rpc" };
  }
  try {
    const provider = new JsonRpcProvider(cfg.rpc);
    const [balanceWei, feeData] = await Promise.all([
      Promise.race([
        provider.getBalance(relayer),
        new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
      ]),
      Promise.race([
        provider.getFeeData(),
        new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5000)),
      ]),
    ]);
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const oneTxWei = maxFee * 360_000n;
    // Alert when the relayer can fund < 3 settles. Pre-flight in
    // /api/relay rejects at the 1-tx mark, so a 3× cushion gives ops
    // ~5–15 min depending on chain volume before users start seeing
    // RELAYER_LOW.
    const minSafeWei = oneTxWei * 3n;
    return {
      chain,
      balanceEth:     Number(formatEther(balanceWei)),
      oneTxCostEth:   Number(formatEther(oneTxWei)),
      minSafeEth:     Number(formatEther(minSafeWei)),
      belowThreshold: balanceWei < minSafeWei,
    };
  } catch (e) {
    return {
      chain,
      balanceEth: 0,
      oneTxCostEth: 0,
      minSafeEth: 0,
      belowThreshold: false,
      error: e instanceof Error ? e.message.slice(0, 80) : "rpc_error",
    };
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const startedAt = Date.now();
  const key = loadRelayerKey();
  if (!key.ok) {
    await recordCronStatus(CRON_NAMES.RELAYER_BALANCE, {
      lastStatus: "error",
      lastError:  "RELAYER_PRIVATE_KEY not configured",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "RELAYER_PRIVATE_KEY not configured" }, { status: 500 });
  }
  const relayer = key.address;

  const probes = await Promise.all(MONITORED_CHAINS.map((c) => probeChain(c, relayer)));

  const flagged = probes.filter((p) => p.belowThreshold);
  const alertsSentFor: string[] = [];

  if (flagged.length > 0) {
    // Cooldown filter — only alert for chains that haven't fired in the
    // last 6h. Avoids spamming when ops takes a while to top up.
    const eligible: ChainProbe[] = [];
    for (const f of flagged) {
      const last = await kv.get<number>(lastAlertKey(f.chain));
      if (!last || Date.now() - last > ALERT_COOLDOWN_SEC * 1000) {
        eligible.push(f);
      }
    }
    if (eligible.length > 0) {
      const lines = [
        `<b>⚠ Relayer balance low</b>`,
        ``,
        `Address: <code>${relayer}</code>`,
        ``,
        ...eligible.map((f) =>
          `<b>${f.chain}</b>: ${f.balanceEth.toFixed(6)} (< ${f.minSafeEth.toFixed(6)} = 3× 1-tx cost ${f.oneTxCostEth.toFixed(6)})`,
        ),
        ``,
        `Pre-flight in /api/relay starts returning RELAYER_LOW (503) once balance < 1× tx cost.`,
      ].join("\n");
      try {
        await sendOpsAlert(lines, "warn");
        for (const f of eligible) {
          await kv.set(lastAlertKey(f.chain), Date.now(), { ex: ALERT_COOLDOWN_SEC });
          alertsSentFor.push(f.chain);
        }
      } catch (e) {
        console.error("[cron/relayer-balance] sendOpsAlert failed:", e);
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  await recordCronStatus(CRON_NAMES.RELAYER_BALANCE, {
    lastStatus: "success",
    lastResult: {
      checked:      probes.length,
      flaggedCount: flagged.length,
      alertsSentFor,
      probes:       probes.map((p) => ({
        chain:          p.chain,
        balanceEth:     p.balanceEth,
        minSafeEth:     p.minSafeEth,
        belowThreshold: p.belowThreshold,
        error:          p.error,
      })),
    },
    durationMs,
  });

  return NextResponse.json({
    relayer,
    probes,
    alertsSentFor,
    durationMs,
    asOf: new Date().toISOString(),
  });
}
