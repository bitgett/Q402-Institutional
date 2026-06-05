/**
 * GET /api/cron/treasury-rebalance
 *
 * Auto-sweep cron driven by the GASTANK key. Closes the operational
 * gap between the unified balance monitor (which only ALERTS when a
 * reserve dips below threshold) and an actual on-chain refill.
 *
 * Each tick, for every CCIP chain (eth / avax / arbitrum):
 *   1. Probe the on-chain balances of:
 *        • Q402CCIPSender LINK pool
 *        • Q402CCIPSender native pool
 *        • RELAYER_ADDRESS native
 *      …and the corresponding source-side reserves on GASTANK_ADDRESS.
 *   2. For each target below its threshold, plan a top-up amount that
 *      brings it back to the threshold × 2 (cushion so the next dip
 *      doesn't fire next tick).
 *   3. Gate every planned move against:
 *        • per-day cap (env DAILY_REBALANCE_CAP_USD_*; default $100)
 *          tracked via KV counter that auto-resets at UTC midnight
 *        • GASTANK source-side liquidity (we never sweep more than the
 *          source actually holds)
 *   4. Execute the moves the relayer key would have signed in
 *      /api/admin/sender-topup, but the SIGNER is GASTANK_ADDRESS so
 *      the funds come from user deposits — not the operator's pocket.
 *   5. Fire a Telegram alert per move ("💸 GASTANK → Sender(eth) 0.05
 *      ETH · tx 0x…") so ops sees every sweep in real time.
 *
 * Auth: shared CRON_SECRET via Authorization header (timing-safe).
 *
 * Read+write — the cron submits txs from GASTANK_ADDRESS. The address
 * match assert in loadGasTankKey() is the only thing standing between
 * a misconfig and a misdirected sweep, so a mismatched key fails
 * closed BEFORE any tx is built.
 */

import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { requireCronAuth } from "@/app/lib/cron-auth";
import { sendOpsAlert } from "@/app/lib/ops-alerts";
import { loadGasTankKey } from "@/app/lib/gastank-key";
import { CHAIN_CONFIG } from "@/app/lib/relayer";
import { RELAYER_ADDRESS } from "@/app/lib/wallets";
import { CCIP_CONFIG, type CCIPChainKey } from "@/app/lib/ccip";
import { recordCronStatus, CRON_NAMES } from "@/app/lib/cron-status";

export const runtime = "nodejs";
export const maxDuration = 60;

const CCIP_CHAINS: CCIPChainKey[] = ["eth", "avax", "arbitrum"];

const LINK_TOKEN_PER_CCIP: Record<CCIPChainKey, string> = {
  eth:      "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  avax:     "0x5947BB275c521040051D82396192181b413227A3",
  arbitrum: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
};

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

/** Per-chain native threshold for Sender contract — same as monitor. */
const SENDER_NATIVE_THRESHOLD_WHOLE: Record<CCIPChainKey, number> = {
  eth:      0.01,
  avax:     0.5,
  arbitrum: 0.005,
};

/** Per-chain LINK threshold for Sender contract — same as monitor. */
const SENDER_LINK_THRESHOLD_WHOLE: Record<CCIPChainKey, number> = {
  eth:      1.0,
  avax:     1.0,
  arbitrum: 1.0,
};

/** Per-chain RELAYER native threshold (~3× one-tx budget at 1 gwei). */
const RELAYER_NATIVE_THRESHOLD_WHOLE: Record<CCIPChainKey, number> = {
  eth:      0.003,
  avax:     0.05,
  arbitrum: 0.002,
};

/**
 * Per-chain per-day spend cap (USD equivalent). Hard limit on what
 * the sweep can move out of GASTANK in a single UTC day. Env override:
 * DAILY_REBALANCE_CAP_USD_<chain>. Default $100/chain.
 */
function dailyCapUsd(chain: CCIPChainKey): number {
  const raw = process.env[`DAILY_REBALANCE_CAP_USD_${chain.toUpperCase()}`];
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** Rough USD pricing for cap math — over-cautious is OK here. */
const NATIVE_USD_PER_TOKEN: Record<CCIPChainKey, number> = {
  eth:      1700,
  avax:     30,
  arbitrum: 1700,
};
const LINK_USD = 12;

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailySpendKey(chain: string): string {
  return `cron:treasury-rebalance:spend:${utcDayKey()}:${chain}`;
}

interface SweepPlan {
  chain:        CCIPChainKey;
  target:       "sender-native" | "sender-link" | "relayer-native";
  toAddress:    string;
  asset:        "native" | "LINK";
  amountWei:    bigint;
  amountWhole:  number;
  estUsd:       number;
}

interface SweepResult {
  plan:    SweepPlan;
  ok:      boolean;
  txHash?: string;
  error?:  string;
}

async function probeBalanceWei(provider: ethers.JsonRpcProvider, addr: string): Promise<bigint> {
  return await Promise.race([
    provider.getBalance(addr),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5_000)),
  ]);
}

async function probeErc20Wei(
  provider: ethers.JsonRpcProvider,
  token: string,
  holder: string,
): Promise<bigint> {
  const data = ERC20_BALANCE_OF_SELECTOR +
    holder.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const hex = await Promise.race([
    provider.call({ to: token, data }),
    new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5_000)),
  ]);
  return BigInt(hex);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denial = requireCronAuth(req);
  if (denial) return denial;

  const keyResult = loadGasTankKey();
  if (!keyResult.ok) {
    // No tx will ever be built. Tell Vercel logs + ops what's wrong.
    void sendOpsAlert(
      `<b>⚠ treasury-rebalance cron disabled</b>\n\n` +
      `Reason: ${keyResult.reason}\n` +
      `Detail: ${keyResult.detail}`,
      "warn",
    ).catch(() => { /* best-effort */ });
    await recordCronStatus(CRON_NAMES.TREASURY_REBALANCE, {
      lastStatus: "error",
      lastError:  `gastank_key_${keyResult.reason}: ${keyResult.detail}`,
      durationMs: 0,
    });
    return NextResponse.json(
      { error: "GASTANK_KEY_UNAVAILABLE", reason: keyResult.reason, detail: keyResult.detail },
      { status: 500 },
    );
  }

  const startedAt = Date.now();
  const plans: SweepPlan[] = [];

  for (const chain of CCIP_CHAINS) {
    const cfg = CHAIN_CONFIG[chain];
    if (!cfg?.rpc) continue;
    const sender = CCIP_CONFIG[chain].sender;
    if (sender === "PENDING_DEPLOY") continue;

    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    let senderNative = 0n;
    let senderLink   = 0n;
    let relayerNative = 0n;
    let gastankNative = 0n;
    let gastankLink   = 0n;
    let feeData: ethers.FeeData | null = null;
    try {
      [senderNative, senderLink, relayerNative, gastankNative, gastankLink, feeData] = await Promise.all([
        probeBalanceWei(provider, sender),
        probeErc20Wei(provider, LINK_TOKEN_PER_CCIP[chain], sender),
        probeBalanceWei(provider, RELAYER_ADDRESS),
        probeBalanceWei(provider, keyResult.address),
        probeErc20Wei(provider, LINK_TOKEN_PER_CCIP[chain], keyResult.address),
        Promise.race([
          provider.getFeeData(),
          new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 5_000)),
        ]),
      ]);
    } catch (e) {
      console.error(`[treasury-rebalance] probe failed on ${chain}:`, e);
      continue;
    }

    // ── Gas-budget reservation (FIX 65) ──────────────────────────────
    // GASTANK pays gas for every sweep it submits. Without reservation:
    //   • A sender-native sweep that takes ALL of gastankNative leaves
    //     zero for its own gas → tx fails "insufficient funds".
    //   • A LINK transfer (no value, just calldata) still needs ~55k
    //     gas worth of native to submit. Burning all of gastankNative
    //     on sender-native leaves the LINK transfer dead.
    // Reserve up to 3 txs × 80k gas × current maxFeePerGas, capped so
    // a degenerate gas price spike can't reserve more than the
    // gastank actually holds.
    const maxFeePerGas = feeData?.maxFeePerGas ?? feeData?.gasPrice ?? 0n;
    const GAS_PER_TX  = 80_000n;   // 21k native send + safety / 55k ERC-20 transfer + safety
    const MAX_TXS_PER_TICK = 3n;
    const gasReserveWei = maxFeePerGas * GAS_PER_TX * MAX_TXS_PER_TICK;
    const gasReserveCapped = gasReserveWei > gastankNative
      ? gastankNative
      : gasReserveWei;
    const gastankSpendableNative = gastankNative > gasReserveCapped
      ? gastankNative - gasReserveCapped
      : 0n;

    // ── Sender native ───────────────────────────────────────────────
    let senderNativeSweepPlanned = 0n;
    {
      const thresholdWei = ethers.parseEther(SENDER_NATIVE_THRESHOLD_WHOLE[chain].toString());
      if (senderNative < thresholdWei) {
        const targetWei = thresholdWei * 2n;
        const needed = targetWei - senderNative;
        const sweep = needed > gastankSpendableNative ? gastankSpendableNative : needed;
        if (sweep > 0n) {
          const amountWhole = Number(ethers.formatEther(sweep));
          plans.push({
            chain,
            target:      "sender-native",
            toAddress:   sender,
            asset:       "native",
            amountWei:   sweep,
            amountWhole,
            estUsd:      amountWhole * NATIVE_USD_PER_TOKEN[chain],
          });
          senderNativeSweepPlanned = sweep;
        }
      }
    }
    // ── Sender LINK ─────────────────────────────────────────────────
    // LINK transfers cost native gas too — only plan if gastank has
    // enough native left after the reserve to cover ONE LINK tx.
    {
      const thresholdWei = ethers.parseUnits(SENDER_LINK_THRESHOLD_WHOLE[chain].toString(), 18);
      const linkTxGasNeeded = maxFeePerGas * GAS_PER_TX;
      const gastankNativeRemaining = gastankNative - senderNativeSweepPlanned;
      if (
        senderLink < thresholdWei &&
        gastankLink > 0n &&
        gastankNativeRemaining >= linkTxGasNeeded
      ) {
        const targetWei = thresholdWei * 2n;
        const needed = targetWei - senderLink;
        const sweep = needed > gastankLink ? gastankLink : needed;
        if (sweep > 0n) {
          const amountWhole = Number(ethers.formatUnits(sweep, 18));
          plans.push({
            chain,
            target:      "sender-link",
            toAddress:   sender,
            asset:       "LINK",
            amountWei:   sweep,
            amountWhole,
            estUsd:      amountWhole * LINK_USD,
          });
        }
      }
    }
    // ── Relayer native ──────────────────────────────────────────────
    {
      const thresholdWei = ethers.parseEther(RELAYER_NATIVE_THRESHOLD_WHOLE[chain].toString());
      if (relayerNative < thresholdWei) {
        const targetWei = thresholdWei * 2n;
        const needed = targetWei - relayerNative;
        // Reserve enough native in GASTANK for: (a) the sender-native
        // sweep planned this tick, (b) gas to actually pay for THIS
        // relayer-native tx.
        const gastankAvail = gastankSpendableNative > senderNativeSweepPlanned
          ? gastankSpendableNative - senderNativeSweepPlanned
          : 0n;
        const sweep = needed > gastankAvail ? gastankAvail : needed;
        if (sweep > 0n) {
          const amountWhole = Number(ethers.formatEther(sweep));
          plans.push({
            chain,
            target:      "relayer-native",
            toAddress:   RELAYER_ADDRESS,
            asset:       "native",
            amountWei:   sweep,
            amountWhole,
            estUsd:      amountWhole * NATIVE_USD_PER_TOKEN[chain],
          });
        }
      }
    }
  }

  // ── Atomic daily cap gate (FIX 64) ───────────────────────────────
  // Each plan calls INCRBYFLOAT BEFORE submitting the tx. If the result
  // exceeds the cap, the plan is dropped AND the increment is rolled
  // back via a negative INCRBYFLOAT. If the tx itself fails, we also
  // roll back. This closes the lost-update window where two concurrent
  // cron runs both observed `already=$X` and both passed the gate.
  //
  // The spendKey carries a 36h TTL set explicitly via `kv.expire` after
  // the first increment of the day (a separate KV op because INCRBYFLOAT
  // doesn't accept ex options on Upstash).
  const filtered: SweepPlan[] = [];
  const dropped: Array<{ plan: SweepPlan; reason: string }> = [];
  const reservedPerPlan = new Map<SweepPlan, number>();
  // Track which spendKeys we've already touched this tick so we set
  // the TTL exactly once per key (subsequent INCRBYFLOATs preserve it).
  const ttlSetForKey = new Set<string>();

  for (const p of plans) {
    const cap = dailyCapUsd(p.chain);
    const spendKey = dailySpendKey(p.chain);
    let newTotal: number;
    try {
      newTotal = await (
        kv as unknown as { incrbyfloat: (k: string, v: number) => Promise<number> }
      ).incrbyfloat(spendKey, p.estUsd);
    } catch (e) {
      // INCRBYFLOAT unavailable / KV blip — drop this plan rather than
      // silently fall back to a lossy RMW that re-opens the race.
      dropped.push({
        plan: p,
        reason: `kv_incrbyfloat_failed: ${e instanceof Error ? e.message.slice(0, 80) : "rpc_error"}`,
      });
      continue;
    }
    if (newTotal > cap) {
      // Refund the reservation so the OTHER chain's plans this tick
      // (or the next tick) still have room.
      await (kv as unknown as { incrbyfloat: (k: string, v: number) => Promise<number> })
        .incrbyfloat(spendKey, -p.estUsd)
        .catch(() => { /* TTL will sweep on day rollover */ });
      dropped.push({
        plan: p,
        reason: `daily_cap_${cap}_USD_would_reach_${newTotal.toFixed(2)}`,
      });
      continue;
    }
    if (!ttlSetForKey.has(spendKey)) {
      // 36h TTL — survives UTC rollover lag. expire() on Upstash sets
      // a fresh TTL each call; only run once per key per tick so a
      // long-running tick doesn't keep bumping the expiry.
      await (kv as unknown as { expire: (k: string, s: number) => Promise<number> })
        .expire(spendKey, 36 * 60 * 60)
        .catch(() => { /* worst case TTL just stays at whatever it was */ });
      ttlSetForKey.add(spendKey);
    }
    reservedPerPlan.set(p, p.estUsd);
    filtered.push(p);
  }

  // ── Execute reserved plans ───────────────────────────────────────
  const results: SweepResult[] = [];
  for (const p of filtered) {
    const cfg = CHAIN_CONFIG[p.chain];
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const wallet = new ethers.Wallet(keyResult.privateKey, provider);
    const refundReservation = async (): Promise<void> => {
      const reserved = reservedPerPlan.get(p) ?? 0;
      if (reserved <= 0) return;
      await (kv as unknown as { incrbyfloat: (k: string, v: number) => Promise<number> })
        .incrbyfloat(dailySpendKey(p.chain), -reserved)
        .catch(() => { /* TTL will sweep */ });
    };
    try {
      let tx: ethers.TransactionResponse;
      if (p.asset === "native") {
        tx = await wallet.sendTransaction({
          to:       p.toAddress,
          value:    p.amountWei,
          gasLimit: 21_000n,
        });
      } else {
        const transferData = ERC20_TRANSFER_SELECTOR +
          p.toAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0") +
          p.amountWei.toString(16).padStart(64, "0");
        tx = await wallet.sendTransaction({
          to:   LINK_TOKEN_PER_CCIP[p.chain],
          data: transferData,
        });
      }
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        await refundReservation();
        results.push({ plan: p, ok: false, error: "tx_reverted", txHash: tx.hash });
        continue;
      }
      results.push({ plan: p, ok: true, txHash: tx.hash });

      // Read the live spend total (post-INCRBYFLOAT) for the alert.
      const liveSpend = await kv.get<number | string>(dailySpendKey(p.chain))
        .then(r => typeof r === "string" ? parseFloat(r) : (r ?? 0))
        .catch(() => 0);

      void sendOpsAlert(
        `💸 <b>GASTANK auto-rebalance</b>\n\n` +
        `${p.target} on ${p.chain}\n` +
        `Amount: ${p.amountWhole.toFixed(6)} ${p.asset} (~$${p.estUsd.toFixed(2)})\n` +
        `To: <code>${p.toAddress}</code>\n` +
        `Tx: <code>${tx.hash}</code>\n` +
        `Today's spend on ${p.chain}: $${liveSpend.toFixed(2)} / $${dailyCapUsd(p.chain)}`,
        "warn",
      ).catch(() => { /* best-effort */ });
    } catch (e) {
      await refundReservation();
      results.push({
        plan: p,
        ok:   false,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }

  // ── Cap-dropped alert (once per day per chain) ───────────────────
  for (const d of dropped) {
    const seenKey = `cron:treasury-rebalance:cap-alert:${utcDayKey()}:${d.plan.chain}:${d.plan.target}`;
    const seen = await kv.get<number>(seenKey).catch(() => null);
    if (seen) continue;
    await kv.set(seenKey, Date.now(), { ex: 36 * 60 * 60 });
    void sendOpsAlert(
      `<b>⚠ treasury rebalance hit daily cap</b>\n\n` +
      `Target: ${d.plan.target} on ${d.plan.chain}\n` +
      `Planned: ${d.plan.amountWhole.toFixed(6)} ${d.plan.asset} (~$${d.plan.estUsd.toFixed(2)})\n` +
      `Reason: ${d.reason}\n\n` +
      `Override via DAILY_REBALANCE_CAP_USD_${d.plan.chain.toUpperCase()} env, ` +
      `or top up manually via /api/admin/sender-topup.`,
      "warn",
    ).catch(() => { /* best-effort */ });
  }

  const durationMs = Date.now() - startedAt;
  const executed = results.filter(r => r.ok).length;
  const failed   = results.filter(r => !r.ok).length;
  await recordCronStatus(CRON_NAMES.TREASURY_REBALANCE, {
    lastStatus: failed > 0 ? "error" : "success",
    lastResult: {
      planned:     plans.length,
      reserved:    filtered.length,
      executed,
      failed,
      droppedCap:  dropped.length,
    },
    ...(failed > 0
      ? { lastError: `${failed}_sweeps_failed` }
      : {}),
    durationMs,
  });
  return NextResponse.json({
    gastank:   keyResult.address,
    plans,
    filtered,
    dropped,
    results,
    durationMs,
    asOf: new Date().toISOString(),
  });
}
