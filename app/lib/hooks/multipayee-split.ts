/**
 * Q402 Hook #3 — MultiPayeeSplit.
 *
 * Lifecycle: beforeSettle (transform).
 *
 * Turns one payment intent into an automatic N-way split — royalty /
 * revenue-share / protocol-fee fan-out. The owner opts in per-wallet
 * (multiPayeeSplit.enabled) and supplies the legs either as a stored
 * default (config.defaultSplits) or per-payment (params.splits).
 *
 * Returns a `split` outcome; the send route fans the single settlement
 * into one sub-settlement per leg. The daily reservation was charged
 * for the FULL amount and the legs sum to exactly that, so there is no
 * double-charge and no under/over-pay.
 *
 * ── Exact-sum math (the correctness-critical part) ──
 *
 * Splits are basis points (sum to 10000). Naive `total × bps / 10000`
 * per leg leaves rounding dust — e.g. 1.00 USDC split 1/3 each would
 * lose a unit. We compute in RAW token units (BigInt), give every leg
 * `floor(totalRaw × bps / 10000)`, and assign ALL remainder to the
 * LAST leg. The legs then sum to totalRaw to the wei, so the on-chain
 * spend matches the reserved amount precisely.
 *
 * Decimals are per (chain, token) — USDC is 6-dec on most chains but
 * 18-dec on BNB, and Stable/Mantle USDT vary — so we read the manifest
 * decimals rather than assuming 6.
 */

import { parseUnits, formatUnits } from "viem";
import type { Hook, HookContext, HookOutcome, SplitSpec } from "./types";
import { getWalletHookConfig, assertSplitsSumTo10000 } from "./config";
import { CHAIN_CONFIG, type ChainKey } from "@/app/lib/relayer";

function tokenDecimals(chain: string, token: string): number {
  const cfg = CHAIN_CONFIG[chain as ChainKey];
  if (!cfg) return 6;
  const t = token.toUpperCase() === "USDT" ? cfg.usdt : cfg.usdc;
  return t?.decimals ?? 6;
}

export const multiPayeeSplit: Hook = {
  name: "MultiPayeeSplit",
  lifecycle: "beforeSettle",
  failMode: "closed", // a misconfigured split must not silently single-pay

  async shouldRun(ctx: HookContext): Promise<boolean> {
    const cfg = await getWalletHookConfig(ctx.walletId);
    return cfg?.multiPayeeSplit?.enabled === true;
  },

  async run(ctx: HookContext): Promise<HookOutcome> {
    const cfg = await getWalletHookConfig(ctx.walletId);
    const ms = cfg?.multiPayeeSplit;
    if (!ms || !ms.enabled) return { action: "allow" };

    // Per-payment legs override the stored default. No legs at all →
    // nothing to split, settle as a normal single payment.
    const splits: SplitSpec[] | undefined = ctx.params?.splits ?? ms.defaultSplits;
    if (!splits || splits.length === 0) return { action: "allow" };

    // A single-leg "split" to the original recipient is a no-op — let it
    // settle single. (Also avoids a degenerate split with one 10000-bps
    // leg adding a pointless fan-out.)
    if (splits.length === 1) return { action: "allow" };

    try {
      assertSplitsSumTo10000(splits);
    } catch (e) {
      return {
        action: "deny",
        code: "SPLIT_INVALID",
        reason: e instanceof Error ? e.message : "invalid split",
        status: 400,
      };
    }

    // ── Exact-sum raw-unit math ──────────────────────────────────────
    const decimals = tokenDecimals(ctx.chain, ctx.token);
    let totalRaw: bigint;
    try {
      totalRaw = parseUnits(ctx.amount, decimals);
    } catch {
      return { action: "deny", code: "SPLIT_AMOUNT_INVALID", reason: `amount ${ctx.amount} not parseable at ${decimals} decimals`, status: 400 };
    }
    if (totalRaw <= 0n) {
      return { action: "deny", code: "SPLIT_AMOUNT_INVALID", reason: "amount must be > 0", status: 400 };
    }

    const parts: Array<{ recipient: string; amount: string }> = [];
    let assigned = 0n;
    for (let i = 0; i < splits.length; i++) {
      const leg = splits[i];
      const isLast = i === splits.length - 1;
      // Last leg absorbs all rounding remainder so the legs sum exactly.
      const legRaw = isLast
        ? totalRaw - assigned
        : (totalRaw * BigInt(leg.bps)) / 10000n;
      if (legRaw <= 0n) {
        return {
          action: "deny",
          code: "SPLIT_LEG_TOO_SMALL",
          reason: `split leg ${i} (${leg.bps} bps of ${ctx.amount}) rounds to zero at ${decimals} decimals`,
          status: 400,
          meta: { legIndex: i, bps: leg.bps, decimals },
        };
      }
      assigned += legRaw;
      parts.push({ recipient: leg.recipient.toLowerCase(), amount: formatUnits(legRaw, decimals) });
    }

    return { action: "split", parts };
  },
};
