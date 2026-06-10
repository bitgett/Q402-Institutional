/**
 * Q402 Hook #2 — ReputationGate.
 *
 * Lifecycle: beforeSettle.
 *
 * Lets a wallet owner say "only let my agent pay recipients whose
 * ERC-8004 reputation meets a threshold." The canonical use case is an
 * agent autonomously paying other agents — ReputationGate keeps it from
 * settling to spammy / unproven counterparties.
 *
 * Only Q402 can offer this natively: we run an ERC-8004 ReputationRegistry
 * heartbeat (the weekly `giveFeedback` cron) AND we already sign every
 * settlement, so the gate slots into the existing settle path with no
 * extra round-trip for the user.
 *
 * ── Security model (the load-bearing part) ──────────────────────────────
 *
 * Reputation is keyed by ERC-8004 `agentId`, but a payment goes to an
 * ADDRESS. Without a binding check, ReputationGate would be trivially
 * bypassable: an attacker routes a payment to any address while
 * attaching `recipientAgentId: <some high-rep agent>` and the gate waves
 * it through.
 *
 * So the gate REQUIRES that `getAgentWallet(claimedAgentId)` — the
 * ON-CHAIN bound payment wallet, not the off-chain metadata JSON the
 * agent owner controls — equals the actual `recipient`. If the claimed
 * agent has no bound wallet, or the bound wallet doesn't match, the
 * reputation can't be trusted for this recipient and we fall back to the
 * `onUnknown` policy (allow / deny).
 *
 * failMode: "open". This is an opt-in quality filter, not a legal
 * requirement — a transient BSC RPC error should not wedge the payment
 * rail. An owner who needs a hard guarantee on the unverifiable case
 * sets `onUnknown: "deny"`, which is enforced deterministically (no RPC
 * dependency once we know the agentId is missing/mismatched).
 *
 * ── Config-read failures vs RPC failures (do NOT conflate) ──────────────
 *
 * failMode "open" covers the RPC-blip case AFTER we have read the owner's
 * gate config. It must NOT extend to FAILING TO READ THE CONFIG ITSELF:
 * if KV errors while we fetch `reputationGate`, we don't know whether the
 * owner set `onUnknown: "deny"` (an explicit hard-block of unverifiable
 * recipients). Treating a config-read error as "skip" (the failMode-open
 * path the dispatcher takes on a shouldRun throw) would silently bypass
 * that hard-block. So we deliberately do NOT let a KV error skip the
 * hook: `shouldRun` returns true on a config-read error so `run()` is
 * reached, and `run()` converts a config-read error into a distinct
 * 503 deny (REPUTATION_CONFIG_UNAVAILABLE) rather than allowing. An
 * ABSENT config (kv.get → null, no gate set) still skips, as it should.
 */

import type { Hook, HookContext, HookOutcome } from "./types";
import { getWalletHookConfig } from "./config";
import { readAgent } from "@/app/lib/erc8004";
import { readSummary } from "@/app/lib/erc8004-reputation";
import { parseAgentIdTag } from "@/app/lib/erc8004-reputation";

const ZERO = "0x0000000000000000000000000000000000000000";

export const reputationGate: Hook = {
  name: "ReputationGate",
  lifecycle: "beforeSettle",
  failMode: "open",

  async shouldRun(ctx: HookContext): Promise<boolean> {
    // Distinguish "absent config" (skip — fine) from "KV error" (must NOT
    // skip — a config-read failure on an owner-enabled hard-deny gate would
    // otherwise fail-open). On an error we return true so run() is reached
    // and can apply a CLOSED treatment for the config-read failure.
    let cfg;
    try {
      cfg = await getWalletHookConfig(ctx.walletId);
    } catch {
      return true;
    }
    return cfg?.reputationGate?.enabled === true;
  },

  async run(ctx: HookContext): Promise<HookOutcome> {
    // shouldRun already confirmed the gate is enabled (or that the config
    // read failed); re-read for the threshold + policy. (Two reads, but
    // config is a single cached KV get and this keeps run() self-contained
    // / unit-testable.)
    //
    // A config-read FAILURE here must fail CLOSED: we cannot tell whether
    // the owner set onUnknown:"deny", so allowing would silently bypass an
    // explicit hard-block. failMode:"open" only covers post-config RPC
    // blips, so we surface a distinct 503 deny rather than throwing (a
    // throw would resolve to allow under failMode:"open").
    let cfg;
    try {
      cfg = await getWalletHookConfig(ctx.walletId);
    } catch (e) {
      return deny("REPUTATION_CONFIG_UNAVAILABLE", {
        reason:
          "Could not read the wallet's reputation-gate config; refusing to settle " +
          "rather than risk bypassing an owner-configured hard deny.",
        status: 503,
        meta: { detail: e instanceof Error ? e.message.slice(0, 160) : "kv error" },
      });
    }
    const gate = cfg?.reputationGate;
    if (!gate || !gate.enabled) {
      // Config changed between shouldRun and run, OR shouldRun reached run()
      // because of a transient KV error that has since cleared and now reads
      // as absent/disabled — nothing to enforce.
      return { action: "allow" };
    }

    const onUnknown = gate.onUnknown === "deny" ? deny("REPUTATION_UNVERIFIED") : allow();

    // 1. The payer must declare which agent the recipient claims to be.
    const claimed = parseAgentIdTag(ctx.params?.recipientAgentId);
    if (claimed === null) {
      return onUnknown;
    }

    // 2. Resolve the claimed agent's ON-CHAIN bound wallet and verify it
    //    matches the actual recipient. ERC-8004 reputation lives on BSC
    //    regardless of the payment chain (Q402 graduates BSC agents
    //    only); the bound wallet is a single EOA reused across chains,
    //    so a lowercased compare works cross-chain.
    let bound: string | null;
    try {
      const agent = await readAgent("bsc", claimed);
      bound = agent.wallet && agent.wallet !== ZERO ? agent.wallet.toLowerCase() : null;
    } catch {
      // RPC error resolving the agent. failMode=open means the
      // dispatcher would allow on a throw anyway, but we want the
      // owner's onUnknown policy to apply to "couldn't verify" too —
      // so return the policy outcome explicitly rather than throwing.
      return onUnknown;
    }

    if (bound === null) {
      // Claimed agent has no on-chain wallet binding — can't trust the
      // reputation for this recipient.
      return onUnknown;
    }
    if (bound !== ctx.recipient.toLowerCase()) {
      // Hard deny: the recipient address is NOT the wallet bound to the
      // claimed agentId. This is the spoofing case — someone attached a
      // high-rep agentId to a payment going elsewhere.
      return deny("REPUTATION_RECIPIENT_MISMATCH", {
        reason:
          "The recipient address is not the on-chain wallet bound to the claimed agent. " +
          "Reputation cannot be applied to this recipient.",
        meta: { claimedAgentId: claimed.toString(), boundWallet: bound, recipient: ctx.recipient.toLowerCase() },
      });
    }

    // 3. Read the agent's TOTAL reputation (unscoped across all feedback
    //    sources + tags) and normalise by decimals.
    let score: number;
    try {
      const summary = await readSummary(claimed, [], "bsc", "", "");
      score = Number(summary.value) / 10 ** summary.decimals;
    } catch {
      // RPC error reading the score — apply onUnknown policy.
      return onUnknown;
    }

    // 4. Threshold compare.
    if (score < gate.minScore) {
      return deny("REPUTATION_TOO_LOW", {
        reason: `Recipient agent reputation ${score} is below the wallet's minimum ${gate.minScore}.`,
        meta: { score, minScore: gate.minScore, agentId: claimed.toString() },
      });
    }
    return { action: "allow" };
  },
};

function allow(): HookOutcome {
  return { action: "allow" };
}

function deny(
  code: string,
  extra?: { reason?: string; status?: number; meta?: Record<string, unknown> },
): HookOutcome {
  return {
    action: "deny",
    code,
    reason: extra?.reason ?? code,
    status: extra?.status ?? 403,
    ...(extra?.meta ? { meta: extra.meta } : {}),
  };
}
