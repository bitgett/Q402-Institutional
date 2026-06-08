/**
 * Q402 Hook system — per-wallet config store.
 *
 * Hook configs live in Vercel KV keyed by the lowercased Agent Wallet
 * address. Compliance (global, list-driven) does NOT live here — it
 * reads its own OFAC KV namespace. This store is only for hooks the
 * wallet owner opts into and parameterises (ReputationGate threshold,
 * MultiPayeeSplit default legs).
 *
 * Reads are wrapped to NEVER throw — a KV blip returns `null` (= "no
 * hooks configured"), so the payment pipeline degrades to its
 * pre-hooks behaviour rather than failing closed on an infra hiccup.
 * Hooks that MUST fail closed on error (compliance) do so inside their
 * own run(), not here.
 */

import { kv } from "@vercel/kv";
import type { WalletHookConfig } from "./types";

function walletHookKey(walletId: string): string {
  return `aw:hooks:${walletId.toLowerCase()}`;
}

/**
 * Read a wallet's hook config. Returns `null` ONLY when no config is set
 * (kv.get returns null for an absent key). A genuine KV error
 * (connection failure, timeout) is THROWN, not swallowed — this matters
 * for fail-closed hooks: if we silently returned null on a KV error, a
 * hook's `shouldRun` would read `enabled !== true` and SKIP, turning a
 * fail-CLOSED policy (e.g. SpendCapPolicy's allowlist) into fail-open on
 * an infra blip. By throwing, the dispatcher's shouldRun/run error
 * handling applies the hook's failMode: fail-open hooks skip (degrade
 * to "no policy"), fail-closed hooks deny. That's exactly what failMode
 * is for — swallowing the error here defeated it.
 *
 * Read-only display callers (the GET config route) wrap this in
 * try/catch and surface a 503 instead of a misleading empty config.
 */
export async function getWalletHookConfig(
  walletId: string,
): Promise<WalletHookConfig | null> {
  return (await kv.get<WalletHookConfig>(walletHookKey(walletId))) ?? null;
}

/**
 * Overwrite a wallet's hook config. Validates the shape before writing
 * so a malformed config can't poison the settle path later. Throws on
 * invalid input (caller is the dashboard / API, which surfaces it to
 * the user); throws on KV failure (the write must be durable).
 */
export async function setWalletHookConfig(
  walletId: string,
  config: WalletHookConfig,
): Promise<void> {
  validateWalletHookConfig(config);
  await kv.set(walletHookKey(walletId), config);
}

/**
 * Shape + invariant validation. Kept here (not in the route) so every
 * write path — dashboard, MCP, future bulk import — shares one gate.
 */
export function validateWalletHookConfig(config: WalletHookConfig): void {
  if (config.reputationGate) {
    const rg = config.reputationGate;
    if (typeof rg.enabled !== "boolean") {
      throw new Error("reputationGate.enabled must be boolean");
    }
    if (typeof rg.minScore !== "number" || !Number.isFinite(rg.minScore)) {
      throw new Error("reputationGate.minScore must be a finite number");
    }
    if (rg.onUnknown !== "allow" && rg.onUnknown !== "deny") {
      throw new Error('reputationGate.onUnknown must be "allow" or "deny"');
    }
  }
  if (config.multiPayeeSplit) {
    const ms = config.multiPayeeSplit;
    if (typeof ms.enabled !== "boolean") {
      throw new Error("multiPayeeSplit.enabled must be boolean");
    }
    if (ms.defaultSplits !== undefined) {
      assertSplitsSumTo10000(ms.defaultSplits);
    }
  }
  if (config.spendCap) {
    const sc = config.spendCap;
    if (typeof sc.enabled !== "boolean") {
      throw new Error("spendCap.enabled must be boolean");
    }
    if (sc.allowedRecipients !== undefined) {
      if (!Array.isArray(sc.allowedRecipients)) {
        throw new Error("spendCap.allowedRecipients must be an array");
      }
      for (const r of sc.allowedRecipients) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(r)) {
          throw new Error(`spendCap.allowedRecipients has a non-0x address: ${r}`);
        }
      }
    }
    if (sc.allowedWindowsUtc !== undefined) {
      if (!Array.isArray(sc.allowedWindowsUtc)) {
        throw new Error("spendCap.allowedWindowsUtc must be an array");
      }
      for (const w of sc.allowedWindowsUtc) {
        if (!Number.isInteger(w.startHour) || w.startHour < 0 || w.startHour > 23) {
          throw new Error(`spendCap window startHour must be 0..23: ${w.startHour}`);
        }
        if (!Number.isInteger(w.endHour) || w.endHour < 1 || w.endHour > 24) {
          throw new Error(`spendCap window endHour must be 1..24: ${w.endHour}`);
        }
        if (w.endHour <= w.startHour) {
          throw new Error(`spendCap window endHour must be > startHour: ${w.startHour}..${w.endHour}`);
        }
      }
    }
    if (sc.perCallApprovalUsd !== undefined) {
      if (typeof sc.perCallApprovalUsd !== "number" || !Number.isFinite(sc.perCallApprovalUsd) || sc.perCallApprovalUsd <= 0) {
        throw new Error("spendCap.perCallApprovalUsd must be a positive number");
      }
    }
  }
}

/**
 * A valid split's basis points must sum to EXACTLY 10000 (100%) and
 * every leg must be a positive bps to a well-formed 0x address. A
 * 9999-summing split would silently under-pay; a 10001 would over-pay.
 * Shared by the config validator and the MultiPayeeSplit hook's
 * per-payment path.
 */
export function assertSplitsSumTo10000(
  splits: Array<{ recipient: string; bps: number }>,
): void {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new Error("splits must be a non-empty array");
  }
  let total = 0;
  for (const leg of splits) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(leg.recipient)) {
      throw new Error(`split recipient is not a 0x address: ${leg.recipient}`);
    }
    if (!Number.isInteger(leg.bps) || leg.bps <= 0) {
      throw new Error(`split bps must be a positive integer: ${leg.bps}`);
    }
    total += leg.bps;
  }
  if (total !== 10000) {
    throw new Error(`split bps must sum to 10000, got ${total}`);
  }
}
