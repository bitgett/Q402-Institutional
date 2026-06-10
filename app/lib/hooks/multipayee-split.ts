/**
 * Q402 Hook #3 — MultiPayeeSplit.
 *
 * Lifecycle: beforeSettle (transform).
 *
 * Turns one payment intent into an N-way split — royalty /
 * revenue-share / protocol-fee fan-out. The owner opts in per-wallet
 * (multiPayeeSplit.enabled), and the split legs are supplied EXPLICITLY
 * per-payment (params.splits). A stored wallet default is NEVER
 * auto-applied: `config.defaultSplits` is retained only for backward
 * compatibility and is intentionally ignored here (see the FUND-SAFETY
 * note in run() — silently redirecting a confirmed "pay 0xX" across other
 * addresses is a consent violation). A split happens only when THIS
 * payment names its legs.
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

    // FUND-SAFETY (P1): split ONLY on an EXPLICIT per-payment request.
    // A wallet-level stored default split is NEVER auto-applied — silently
    // redirecting a normal "pay 1 to 0xX" across other addresses is a
    // consent violation (the caller confirmed 0xX, not the legs; the demo
    // that surfaced this paid a named recipient but settled to three
    // others). `ms.defaultSplits` is retained in config for backward
    // compatibility but intentionally ignored here; the dashboard no longer
    // lets you set one. Splits happen only when THIS payment names them.
    const splits: SplitSpec[] | undefined = ctx.params?.splits;
    if (!splits || splits.length === 0) return { action: "allow" };

    // Single-leg "split": a no-op ONLY if the leg is the same recipient
    // as the payment's `to`. If the one leg points ELSEWHERE, allowing
    // would settle to `to` (ignoring the leg) — i.e. the funds go to a
    // different address than the split declared. That's a silent
    // misdirection, so deny it as a contradictory config instead.
    if (splits.length === 1) {
      const only = splits[0];
      if (only.recipient.toLowerCase() === ctx.recipient.toLowerCase()) {
        return { action: "allow" };
      }
      return {
        action: "deny",
        code: "SPLIT_SINGLE_LEG_MISMATCH",
        reason: "A 1-leg split must target the payment recipient; a different single leg is ambiguous (funds would go to `to`, not the leg).",
        status: 400,
        meta: { to: ctx.recipient.toLowerCase(), leg: only.recipient.toLowerCase() },
      };
    }

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
