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
    try {
      [senderNative, senderLink, relayerNative, gastankNative, gastankLink] = await Promise.all([
        probeBalanceWei(provider, sender),
        probeErc20Wei(provider, LINK_TOKEN_PER_CCIP[chain], sender),
        probeBalanceWei(provider, RELAYER_ADDRESS),
        probeBalanceWei(provider, keyResult.address),
        probeErc20Wei(provider, LINK_TOKEN_PER_CCIP[chain], keyResult.address),
      ]);
    } catch (e) {
      console.error(`[treasury-rebalance] probe failed on ${chain}:`, e);
      continue;
    }

    // ── Sender native ───────────────────────────────────────────────
    {
      const thresholdWei = ethers.parseEther(SENDER_NATIVE_THRESHOLD_WHOLE[chain].toString());
      if (senderNative < thresholdWei) {
        const targetWei = thresholdWei * 2n;
        const needed = targetWei - senderNative;
        const sweep = needed > gastankNative ? gastankNative : needed;
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
        }
      }
    }
    // ── Sender LINK ─────────────────────────────────────────────────
    {
      const thresholdWei = ethers.parseUnits(SENDER_LINK_THRESHOLD_WHOLE[chain].toString(), 18);
      if (senderLink < thresholdWei) {
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
        // Reserve enough native in GASTANK for any planned sender-native
        // sweep this tick — process sender first, relayer second.
        const senderNativeQueued = plans
          .filter(p => p.chain === chain && p.asset === "native")
          .reduce((a, p) => a + p.amountWei, 0n);
        const gastankAvail = gastankNative > senderNativeQueued
          ? gastankNative - senderNativeQueued
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

  // ── Daily cap gate ───────────────────────────────────────────────
  // Per chain, drop any plan that would push today's spend past the cap.
  // Surviving plans get atomically incremented in KV before tx submit so
  // a concurrent run can't double-spend the budget.
  const filtered: SweepPlan[] = [];
  const dropped: Array<{ plan: SweepPlan; reason: string }> = [];
  const perChainSpend = new Map<string, number>();
  for (const p of plans) {
    const cap = dailyCapUsd(p.chain);
    const spendKey = dailySpendKey(p.chain);
    let already = perChainSpend.get(p.chain);
    if (already === undefined) {
      const raw = await kv.get<number | string>(spendKey);
      already = typeof raw === "string" ? parseFloat(raw) : (raw ?? 0);
      if (!Number.isFinite(already)) already = 0;
      perChainSpend.set(p.chain, already);
    }
    if ((already ?? 0) + p.estUsd > cap) {
      dropped.push({ plan: p, reason: `daily_cap_${cap}_USD_already_${(already ?? 0).toFixed(2)}` });
      continue;
    }
    perChainSpend.set(p.chain, (already ?? 0) + p.estUsd);
    filtered.push(p);
  }

  // ── Execute survivors ────────────────────────────────────────────
  const results: SweepResult[] = [];
  for (const p of filtered) {
    const cfg = CHAIN_CONFIG[p.chain];
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const wallet = new ethers.Wallet(keyResult.privateKey, provider);
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
        results.push({ plan: p, ok: false, error: "tx_reverted", txHash: tx.hash });
        continue;
      }
      results.push({ plan: p, ok: true, txHash: tx.hash });

      // Commit the spend after on-chain confirm — short window of
      // double-spend exposure (between confirm and KV write) is
      // acceptable for cron at 5min cadence.
      await kv.set(
        dailySpendKey(p.chain),
        perChainSpend.get(p.chain) ?? 0,
        { ex: 36 * 60 * 60 }, // 36h TTL — survives UTC rollover lag
      ).catch(() => { /* TTL will sweep */ });

      void sendOpsAlert(
        `💸 <b>GASTANK auto-rebalance</b>\n\n` +
        `${p.target} on ${p.chain}\n` +
        `Amount: ${p.amountWhole.toFixed(6)} ${p.asset} (~$${p.estUsd.toFixed(2)})\n` +
        `To: <code>${p.toAddress}</code>\n` +
        `Tx: <code>${tx.hash}</code>\n` +
        `Today's spend on ${p.chain}: $${(perChainSpend.get(p.chain) ?? 0).toFixed(2)} / $${dailyCapUsd(p.chain)}`,
        "warn",
      ).catch(() => { /* best-effort */ });
    } catch (e) {
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
