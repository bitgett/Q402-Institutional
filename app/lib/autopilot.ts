/**
 * Q402 Autopilot — policy-based autonomous treasury rules.
 *
 * "Tell your agent the rule once. Q402 enforces it every time." A rule is a
 * (condition → action) pair evaluated on a cadence by the autopilot-watcher
 * cron. When a condition is met on a rising edge, the cron FIRES by calling the
 * already-hardened Mode-C endpoints (POST /api/wallet/agentic/send for auto-pay,
 * /yield/deposit for move-to-yield) with the owner's paid apiKey — it never
 * re-implements signing, so every fire inherits the send/yield route's
 * fail-closed settlement, idempotency, per-tx/daily caps, and hooks.
 *
 * Ships DARK: gated behind AUTOPILOT_ENABLED (off by default). Reads (preview /
 * list / fires) work regardless so a rule can be inspected before enabling.
 */
import { kv } from "@vercel/kv";
import { ethers } from "ethers";
import { fetchAgenticBalances } from "./agentic-wallet-balance";
import { getRelayedTxs, recentMonths } from "./db";
import { listPaymentRequestsPage } from "./payment-request";

/** Feature gate. Off by default; a fire path must opt in via AUTOPILOT_ENABLED=1. */
export function autopilotEnabled(): boolean {
  return (process.env.AUTOPILOT_ENABLED ?? "").trim() === "1";
}

export type AutopilotCondition =
  | { kind: "idle-balance"; chain: string; token: "USDC" | "USDT"; over: number }
  | { kind: "weekly-spend-pct"; capUsd: number; pct: number }
  | { kind: "vendor-invoice"; maxUsd: number };

export type AutopilotAction =
  | { kind: "move-to-yield"; amount: number; token: "USDC" | "USDT"; chain: string; protocol?: string }
  | { kind: "auto-pay" }
  | { kind: "pause" };

export type AutopilotStatus = "active" | "paused" | "cancelled";

export interface AutopilotRule {
  id: string;
  ownerAddr: string;
  walletId: string;
  label: string | null;
  status: AutopilotStatus;
  condition: AutopilotCondition;
  action: AutopilotAction;
  keepLiquidUsd?: number;
  createdAt: number;
  nextRunAt: number;
  lastFiredAt: number | null;
  totalFiredCount: number;
  totalMovedUsd: number;
  lastError: string | null;
}

export interface AutopilotFire {
  ts: number;
  outcome: "fired" | "skipped" | "error" | "uncertain";
  reason: string;
  movedUsd?: number;
  txHash?: string;
}

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // matches the watcher cron cadence
const FIRE_LOG_CAP = 50;
export const MAX_RULES_PER_WALLET = 25;
// NOTE: the fire-lock TTL / durable-marker constants + fireLockKey/firedMarkerKey
// helpers live with the (deferred) autopilot-watcher cron, not here, so this dark
// module stays lint-clean until that money-moving path is actually built.

const low = (s: string) => s.toLowerCase();
const ruleKey = (o: string, w: string, id: string) => `aw:autopilot:${low(o)}:${low(w)}:${id}`;
const listKey = (o: string, w: string) => `aw:autopilot:list:${low(o)}:${low(w)}`;
const fireLogKey = (o: string, w: string, id: string) => `aw:autopilot:firelog:${low(o)}:${low(w)}:${id}`;
const approvedVendorsKey = (o: string, w: string) => `aw:autopilot:approved-vendors:${low(o)}:${low(w)}`;
export const AUTOPILOT_NEXT_ZSET = "aw:autopilot:next-action";
const zMember = (o: string, w: string, id: string) => `${low(o)}/${low(w)}/${id}`;

function newId(): string {
  return ethers.hexlify(ethers.randomBytes(12)).slice(2);
}

// ── store ────────────────────────────────────────────────────────────────────
export async function createAutopilotRule(input: {
  ownerAddr: string;
  walletId: string;
  label?: string | null;
  condition: AutopilotCondition;
  action: AutopilotAction;
  keepLiquidUsd?: number;
}): Promise<AutopilotRule> {
  const ids = (await kv.lrange<string>(listKey(input.ownerAddr, input.walletId), 0, -1)) ?? [];
  if (ids.length >= MAX_RULES_PER_WALLET) throw new Error("MAX_RULES_REACHED");
  const now = Date.now();
  const rule: AutopilotRule = {
    id: newId(),
    ownerAddr: low(input.ownerAddr),
    walletId: low(input.walletId),
    label: input.label ?? null,
    status: "active",
    condition: input.condition,
    action: input.action,
    ...(typeof input.keepLiquidUsd === "number" ? { keepLiquidUsd: input.keepLiquidUsd } : {}),
    createdAt: now,
    nextRunAt: now + CHECK_INTERVAL_MS,
    lastFiredAt: null,
    totalFiredCount: 0,
    totalMovedUsd: 0,
    lastError: null,
  };
  await kv.set(ruleKey(rule.ownerAddr, rule.walletId, rule.id), rule);
  await kv.rpush(listKey(rule.ownerAddr, rule.walletId), rule.id);
  await kv.zadd(AUTOPILOT_NEXT_ZSET, { score: rule.nextRunAt, member: zMember(rule.ownerAddr, rule.walletId, rule.id) });
  return rule;
}

export async function getAutopilotRule(owner: string, walletId: string, id: string): Promise<AutopilotRule | null> {
  return (await kv.get<AutopilotRule>(ruleKey(owner, walletId, id))) ?? null;
}

export async function listAutopilotRules(owner: string, walletId: string): Promise<AutopilotRule[]> {
  const ids = (await kv.lrange<string>(listKey(owner, walletId), 0, -1)) ?? [];
  const rules = await Promise.all(ids.map((id) => getAutopilotRule(owner, walletId, id)));
  return rules.filter((r): r is AutopilotRule => !!r && r.status !== "cancelled");
}

export async function setAutopilotStatus(owner: string, walletId: string, id: string, status: AutopilotStatus): Promise<AutopilotRule | null> {
  const rule = await getAutopilotRule(owner, walletId, id);
  if (!rule) return null;
  const next: AutopilotRule = { ...rule, status };
  await kv.set(ruleKey(owner, walletId, id), next);
  if (status !== "active") await kv.zrem(AUTOPILOT_NEXT_ZSET, zMember(owner, walletId, id));
  else await kv.zadd(AUTOPILOT_NEXT_ZSET, { score: Date.now(), member: zMember(owner, walletId, id) });
  return next;
}

export async function listAutopilotFires(owner: string, walletId: string, id: string): Promise<AutopilotFire[]> {
  return (await kv.lrange<AutopilotFire>(fireLogKey(owner, walletId, id), 0, FIRE_LOG_CAP - 1)) ?? [];
}

export async function appendAutopilotFire(owner: string, walletId: string, id: string, fire: AutopilotFire): Promise<void> {
  await kv.lpush(fireLogKey(owner, walletId, id), fire);
  await kv.ltrim(fireLogKey(owner, walletId, id), 0, FIRE_LOG_CAP - 1);
}

export async function getApprovedVendors(owner: string, walletId: string): Promise<string[]> {
  return (await kv.smembers<string[]>(approvedVendorsKey(owner, walletId))) ?? [];
}
export async function setApprovedVendors(owner: string, walletId: string, vendors: string[]): Promise<void> {
  const key = approvedVendorsKey(owner, walletId);
  await kv.del(key);
  const clean = [...new Set(vendors.map(low).filter((v) => /^0x[0-9a-f]{40}$/.test(v)))];
  if (clean.length) await kv.sadd(key, clean[0], ...clean.slice(1));
}

// ── evaluate (the dry-run brain; used by preview AND the cron) ────────────────
export interface EvalResult {
  wouldFire: boolean;
  reason: string;
  plan?: { action: "move-to-yield"; amountUsd: number; token: string; chain: string; protocol?: string }
        | { action: "auto-pay"; requestId: string; amountUsd: number; to: string }
        | { action: "pause" };
}

function chainTokenUsd(bal: Awaited<ReturnType<typeof fetchAgenticBalances>>, chain: string, token: "USDC" | "USDT"): number {
  const c = bal.perChain.find((x) => x.chain === chain);
  if (!c) return 0;
  const slot = token === "USDC" ? c.usdc : c.usdt;
  return slot?.usd ?? 0;
}

export async function evaluateRule(rule: AutopilotRule, walletAddr: string): Promise<EvalResult> {
  const cond = rule.condition;

  if (cond.kind === "idle-balance") {
    const bal = await fetchAgenticBalances(walletAddr);
    const idle = chainTokenUsd(bal, cond.chain, cond.token);
    if (idle <= cond.over) return { wouldFire: false, reason: `idle ${cond.token} on ${cond.chain} is $${idle.toFixed(2)} (<= threshold $${cond.over})` };
    if (rule.action.kind !== "move-to-yield") return { wouldFire: false, reason: "idle-balance rule requires a move-to-yield action" };
    // Move the excess over threshold, but keep `keepLiquidUsd` liquid.
    const keep = rule.keepLiquidUsd ?? cond.over;
    const movable = Math.max(0, idle - keep);
    const amount = Math.min(rule.action.amount, movable);
    if (amount <= 0) return { wouldFire: false, reason: `nothing movable after keeping $${keep} liquid` };
    return { wouldFire: true, reason: `idle ${cond.token} $${idle.toFixed(2)} > $${cond.over}; move $${amount.toFixed(2)} to yield`, plan: { action: "move-to-yield", amountUsd: amount, token: rule.action.token, chain: rule.action.chain, protocol: rule.action.protocol } };
  }

  if (cond.kind === "weekly-spend-pct") {
    const txs = (await getRelayedTxs(low(rule.ownerAddr), recentMonths(2), 5000)).filter((t) => {
      const ms = Date.parse(t.relayedAt);
      return (low(t.fromUser) === low(walletAddr) || low(t.address) === low(walletAddr)) && Number.isFinite(ms) && ms >= Date.now() - 7 * 86400_000;
    });
    const spent = txs.reduce((s, t) => s + (Number(t.tokenAmount) || 0), 0);
    const ratio = cond.capUsd > 0 ? spent / cond.capUsd : 0;
    if (ratio * 100 < cond.pct) return { wouldFire: false, reason: `weekly spend $${spent.toFixed(2)} is ${(ratio * 100).toFixed(0)}% of $${cond.capUsd} (< ${cond.pct}%)` };
    return { wouldFire: true, reason: `weekly spend hit ${(ratio * 100).toFixed(0)}% of the $${cond.capUsd} cap; pausing non-critical payments`, plan: { action: "pause" } };
  }

  if (cond.kind === "vendor-invoice") {
    const approved = new Set((await getApprovedVendors(low(rule.ownerAddr), low(rule.walletId))).map(low));
    const page = await listPaymentRequestsPage(low(rule.ownerAddr), { limit: 100 });
    const match = page.records.find((r) => r.status === "open" && Number(r.amount) <= cond.maxUsd && approved.has(low(r.recipient)));
    if (!match) return { wouldFire: false, reason: `no open request under $${cond.maxUsd} from an approved vendor` };
    return { wouldFire: true, reason: `open request ${match.id} for $${match.amount} from approved vendor ${match.recipient}`, plan: { action: "auto-pay", requestId: match.id, amountUsd: Number(match.amount) || 0, to: match.recipient } };
  }

  return { wouldFire: false, reason: "unknown condition" };
}
