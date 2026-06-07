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

/**
 * Per-chain native threshold for Sender contract.
 *
 * ETH is set HIGHER than the other chains because ETH gas makes
 * frequent sweeps painful — at ~$2-5 per sweep tx, we want each ETH
 * sweep to cover several days of expected burn, not be a daily drip.
 * The cron's per-chain throttle (CHAIN_SWEEP_INTERVAL_MS) below
 * enforces ETH sweeps at most once per 24h; thresholds here give the
 * pool a ~3-5 day buffer between sweeps at moderate traffic.
 *
 * AVAX + Arbitrum keep tight thresholds (sweep often, gas is free).
 */
const SENDER_NATIVE_THRESHOLD_WHOLE: Record<CCIPChainKey, number> = {
  eth:      0.02,    // ~$34 — 24h-cadence buffer
  avax:     0.5,
  arbitrum: 0.005,
};

const SENDER_LINK_THRESHOLD_WHOLE: Record<CCIPChainKey, number> = {
  eth:      5.0,     // ~$60 — preferred fee path, kept generous
  avax:     1.0,
  arbitrum: 1.0,
};

const RELAYER_NATIVE_THRESHOLD_WHOLE: Record<CCIPChainKey, number> = {
  eth:      0.01,    // ~$17 — 24h-cadence buffer
  avax:     0.05,
  arbitrum: 0.002,
};

/**
 * Per-chain MINIMUM interval between sweep attempts. The viz-backend
 * trigger fires this endpoint every 6h; this map then THROTTLES which
 * chains actually evaluate their plans on a given tick.
 *
 * ETH 24h: at $2-5 gas per sweep, 4× daily sweeps = $240-600/month
 * overhead on a chain with single-digit bridge traffic. Throttling to
 * once per day caps the worst case to $60-150/month and most days
 * are no-op (thresholds above survive ~3-5 days).
 *
 * AVAX + Arbitrum 6h: gas is effectively free (<$0.10/sweep), so
 * frequent sweeps are pure operational hygiene.
 */
const CHAIN_SWEEP_INTERVAL_MS: Record<CCIPChainKey, number> = {
  eth:      24 * 60 * 60 * 1000, // 24h
  avax:      6 * 60 * 60 * 1000, // 6h
  arbitrum:  6 * 60 * 60 * 1000, // 6h
};

function chainLastAttemptKey(chain: CCIPChainKey): string {
  return `cron:treasury-rebalance:last-attempt:${chain}`;
}

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
  const throttled: Array<{ chain: CCIPChainKey; minIntervalMs: number; sinceLastMs: number }> = [];

  for (const chain of CCIP_CHAINS) {
    const cfg = CHAIN_CONFIG[chain];
    if (!cfg?.rpc) continue;
    const sender = CCIP_CONFIG[chain].sender;
    if (sender === "PENDING_DEPLOY") continue;

    // Per-chain throttle. ETH gets 24h, others get 6h — see the
    // CHAIN_SWEEP_INTERVAL_MS comment. A "last attempt" stamp is
    // written at the end of every evaluation (success OR failure)
    // so a chain that hit transient errors retries on the NEXT tick
    // past its interval, not 6h later.
    try {
      const lastAttempt = await kv.get<number>(chainLastAttemptKey(chain)) ?? 0;
      const sinceLastMs = Date.now() - lastAttempt;
      const minIntervalMs = CHAIN_SWEEP_INTERVAL_MS[chain];
      if (lastAttempt > 0 && sinceLastMs < minIntervalMs) {
        throttled.push({ chain, minIntervalMs, sinceLastMs });
        continue;
      }
    } catch {
      // KV blip — proceed (better to over-sweep than wedge the cron).
    }

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
    //
    // Target = 10× threshold (was 2×). Rationale: ETH gas makes
    // sweeping itself expensive ($2-5 per tx), so each sweep should
    // be a meaningful refill, not a minimum top-up that triggers
    // another sweep tomorrow. Capped by `gastankSpendableNative` so
    // if GASTANK doesn't have 10× threshold available, we just send
    // what we can — no behaviour change at low balances.
    let senderNativeSweepPlanned = 0n;
    {
      const thresholdWei = ethers.parseEther(SENDER_NATIVE_THRESHOLD_WHOLE[chain].toString());
      if (senderNative < thresholdWei) {
        const targetWei = thresholdWei * 10n;
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
        // 10× target — same "one big sweep, not many small" logic as
        // sender-native above. LINK is the preferred fee path so a
        // generous topup means most days the cron is a no-op.
        const targetWei = thresholdWei * 10n;
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
    // Same 10× target logic. Note the gastankAvail subtracts the
    // sender-native sweep planned earlier this tick so we don't
    // double-spend the same GASTANK ETH.
    {
      const thresholdWei = ethers.parseEther(RELAYER_NATIVE_THRESHOLD_WHOLE[chain].toString());
      if (relayerNative < thresholdWei) {
        const targetWei = thresholdWei * 10n;
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
    // Stamp this chain's last-attempt time AT THE END of the
    // evaluation — covers both "we generated plans" and "no plans
    // needed". Either way the chain has been evaluated this tick;
    // the next eligibility is `now + CHAIN_SWEEP_INTERVAL_MS[chain]`.
    await kv.set(chainLastAttemptKey(chain), Date.now()).catch(() => {});
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
    let tx: ethers.TransactionResponse | null = null;
    try {
      if (p.asset === "native") {
        // 21k is the EOA→EOA exact cost. The sender-native target is
        // the Q402CCIPSender CONTRACT whose `receive()` emits a
        // NativePoolTopup event — event emission + contract code
        // execution overhead pushes the real cost to ~30-35k. The
        // 21k ceiling caused every sender-native tick to hit
        // out-of-gas (revert with data=null reason=null), and the
        // uncertain-outcome branch below preserved the reservation
        // instead of refunding → ops spam every 15min, daily cap
        // bucket over-drained. 50k gives headroom for any
        // event-emitting receive() on any target.
        const isContractTarget = p.target.startsWith("sender-");
        tx = await wallet.sendTransaction({
          to:       p.toAddress,
          value:    p.amountWei,
          gasLimit: isContractTarget ? 50_000n : 21_000n,
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
      // Wait-error triage:
      //   - CALL_EXCEPTION (action=sendTransaction, ethers v6 signal
      //     for "tx mined and reverted") = DEFINITIVE failure. We
      //     KNOW the outcome — refund the reservation just like an
      //     in-band `receipt.status === 0`.
      //   - Network/RPC errors (NETWORK_ERROR, SERVER_ERROR, fetch
      //     timeout, etc.) = TRUE uncertainty. Keep the reservation
      //     and page ops; next cron tick may observe the receipt.
      // Previous code lumped all wait throws as uncertain — turned
      // an out-of-gas revert (every tick, same plan) into per-tick
      // ops spam plus a leaking daily-cap reservation.
      let receipt: Awaited<ReturnType<typeof tx.wait>>;
      try {
        receipt = await tx.wait();
      } catch (waitErr) {
        const err = waitErr instanceof Error ? waitErr.message : String(waitErr);
        const errCode =
          (waitErr as { code?: string } | null)?.code ??
          (waitErr as { error?: { code?: string } } | null)?.error?.code ?? "";
        const isDefinitiveRevert =
          errCode === "CALL_EXCEPTION" ||
          /execution reverted|out of gas|out_of_gas/i.test(err);
        if (isDefinitiveRevert) {
          // Tx ran, ran out of gas / reverted. Refund + emit a
          // throttled (once per day per chain+target+code) alert so
          // the same bug isn't paging ops every 15 minutes.
          await refundReservation();
          results.push({
            plan: p,
            ok:   false,
            error: `tx_reverted_post_wait: ${err.slice(0, 160)}`,
            txHash: tx.hash,
          });
          const dedupKey =
            `cron:treasury-rebalance:revert-alert:${utcDayKey()}:${p.chain}:${p.target}`;
          const already = await kv.get<number>(dedupKey).catch(() => null);
          if (!already) {
            await kv.set(dedupKey, Date.now(), { ex: 36 * 60 * 60 }).catch(() => {});
            void sendOpsAlert(
              `<b>⚠ treasury rebalance tx REVERTED — reservation refunded</b>\n\n` +
              `Target: ${p.target} on ${p.chain}\n` +
              `To: <code>${p.toAddress}</code>\n` +
              `Tx: <code>${tx.hash}</code>\n` +
              `Amount: ${p.amountWhole.toFixed(6)} ${p.asset} (~$${p.estUsd.toFixed(2)})\n\n` +
              `Refund applied. THIS ALERT IS ONCE-PER-DAY per (chain, target) — if you ` +
              `see it the cron is hitting the same revert every tick. Likely root causes: ` +
              `(a) gasLimit too low for contract receive(), (b) target contract paused, ` +
              `(c) manifest sender address out of date.\n\n` +
              `Wait error: ${err.slice(0, 240)}`,
              "warn",
            ).catch(() => { /* best-effort */ });
          }
          continue;
        }
        // Genuinely uncertain (network, RPC). Keep the reservation,
        // throttle the page-ops to once per (day, chain, target).
        results.push({
          plan: p,
          ok:   false,
          error: `wait_failed_uncertain: ${err.slice(0, 160)}`,
          txHash: tx.hash,
        });
        const uncertainDedupKey =
          `cron:treasury-rebalance:uncertain-alert:${utcDayKey()}:${p.chain}:${p.target}`;
        const alreadyUncertain = await kv.get<number>(uncertainDedupKey).catch(() => null);
        if (!alreadyUncertain) {
          await kv.set(uncertainDedupKey, Date.now(), { ex: 36 * 60 * 60 }).catch(() => {});
          void sendOpsAlert(
            `<b>🚨 treasury rebalance tx broadcast but wait() FAILED — OUTCOME UNCERTAIN</b>\n\n` +
            `Target: ${p.target} on ${p.chain}\n` +
            `Tx: <code>${tx.hash}</code>\n` +
            `Amount: ${p.amountWhole.toFixed(6)} ${p.asset} (~$${p.estUsd.toFixed(2)})\n\n` +
            `Reservation NOT refunded — if you refund and the tx mined, the next ` +
            `cron tick over-spends past the daily cap. Verify on-chain: if mined, ` +
            `leave as-is. If dropped, manually INCRBYFLOAT ` +
            `cron:treasury-rebalance:spend:${utcDayKey()}:${p.chain} ` +
            `by -${(reservedPerPlan.get(p) ?? 0).toFixed(2)}.\n\n` +
            `THIS ALERT IS ONCE-PER-DAY per (chain, target).\n\n` +
            `Wait error: ${err.slice(0, 240)}`,
            "error",
          ).catch(() => { /* best-effort */ });
        }
        continue;
      }
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
      // sendTransaction itself threw → tx never broadcast → safe to
      // refund the reservation. If we already have a tx object here
      // it means a pre-wait error path threw; safest is still to
      // surface it. We do NOT refund on wait-failure (handled above).
      if (!tx) {
        await refundReservation();
      }
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
      throttled:   throttled.length,
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
    throttled,
    durationMs,
    asOf: new Date().toISOString(),
  });
}
