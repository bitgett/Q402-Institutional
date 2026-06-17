/**
 * Q402 Hook — SpendCapPolicy.
 *
 * Lifecycle: beforeAuthorize.
 *
 * Programmable spend rules layered on top of the Agent Wallet's native
 * perTxMaxUsd / dailyLimitUsd (which are HARD denies enforced in the
 * route). SpendCapPolicy adds the things native caps don't have:
 *
 *   - allowedRecipients[]  — a whitelist. A recipient not on it is
 *     DENIED (RECIPIENT_NOT_ALLOWED). The autonomous-agent use case:
 *     "my agent may only pay these N counterparties."
 *
 *   - allowedWindowsUtc[]  — settlement is only permitted within these
 *     UTC hour windows. Outside → DENY (OUTSIDE_ALLOWED_WINDOW). Use
 *     case: "my agent only transacts during business hours."
 *
 *   - perCallApprovalUsd   — a SOFT cap. An amount at/above it returns
 *     REQUIRE_APPROVAL (human-in-the-loop), distinct from the native
 *     perTxMaxUsd hard ceiling. Use case: "auto-settle small payments,
 *     but anything >= $100 needs a human nod."
 *
 * Opt-in per wallet (spendCap.enabled). failMode "closed" — a spend
 * policy that can't be evaluated must not let a payment through; but
 * the policy reads only stored config (no RPC), so the only error path
 * is a KV blip, which shouldRun already swallows to "skip".
 */

import type { Hook, HookContext, HookOutcome } from "./types";
import { getWalletHookConfig } from "./config";

export const spendCapPolicy: Hook = {
  name: "SpendCapPolicy",
  lifecycle: "beforeAuthorize",
  failMode: "closed",

  async shouldRun(ctx: HookContext): Promise<boolean> {
    const cfg = await getWalletHookConfig(ctx.walletId);
    return cfg?.spendCap?.enabled === true;
  },

  async run(ctx: HookContext): Promise<HookOutcome> {
    const cfg = await getWalletHookConfig(ctx.walletId);
    const sc = cfg?.spendCap;
    if (!sc || !sc.enabled) return { action: "allow" };

    // 1. Recipient whitelist (hard deny). Empty/absent = no whitelist.
    if (sc.allowedRecipients && sc.allowedRecipients.length > 0) {
      const ok = sc.allowedRecipients.some((r) => r.toLowerCase() === ctx.recipient.toLowerCase());
      if (!ok) {
        return {
          action: "deny",
          code: "RECIPIENT_NOT_ALLOWED",
          reason: "Recipient is not on this wallet's allowed-recipients list.",
          status: 403,
          meta: { recipient: ctx.recipient.toLowerCase() },
        };
      }
    }

    // 2. Time window (hard deny). The current UTC hour must fall inside
    //    at least one [startHour, endHour) window.
    if (sc.allowedWindowsUtc && sc.allowedWindowsUtc.length > 0) {
      const hour = new Date().getUTCHours();
      const inWindow = sc.allowedWindowsUtc.some((w) => hour >= w.startHour && hour < w.endHour);
      if (!inWindow) {
        return {
          action: "deny",
          code: "OUTSIDE_ALLOWED_WINDOW",
          reason: `Settlements for this wallet are only allowed during configured UTC windows; current hour ${hour} is outside all of them.`,
          status: 403,
          meta: { utcHour: hour, windows: sc.allowedWindowsUtc },
        };
      }
    }

    // 3. Soft per-call cap (require approval). At/above the threshold a
    //    human must approve — the settlement is HELD, not forbidden.
    if (typeof sc.perCallApprovalUsd === "number" && ctx.amountUsd >= sc.perCallApprovalUsd) {
      return {
        action: "require_approval",
        code: "APPROVAL_REQUIRED_OVER_CAP",
        reason: `This payment of $${ctx.amountUsd} is at or above the wallet's hold threshold of $${sc.perCallApprovalUsd}, so it was held and not sent. Raise the threshold above this amount or turn Spend Cap off, then try again.`,
        status: 202,
        meta: { amountUsd: ctx.amountUsd, perCallApprovalUsd: sc.perCallApprovalUsd },
      };
    }

    return { action: "allow" };
  },
};
