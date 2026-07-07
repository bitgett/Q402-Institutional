/**
 * Q402 Memory — read-only "agent treasury intelligence" aggregation.
 *
 * Reads the owner's already-recorded stores (settled relay txs, recurring rules,
 * payment requests, escrow) server-side and summarizes them. Moves no money and
 * needs no owner signature: everything is keyed by the owner EOA that
 * getApiKeyRecord(apiKey).address resolves to.
 *
 * Powers the MCP tools q402_memory_summary / q402_vendor_history /
 * q402_agent_spend_report via /api/wallet/agentic/memory-by-key.
 */
import { getRelayedTxs, recentMonths, type RelayedTx } from "./db";
import { listRecurringRules, type RecurringRule } from "./agentic-wallet-recurring";
import { listPaymentRequestsPage } from "./payment-request";
import { listEscrowsPage } from "./escrow";
import { listAgenticWallets } from "./agentic-wallet";

export type MemoryWindow = "24h" | "7d" | "30d" | "all";

const DAY = 86_400_000;
function windowBounds(window: MemoryWindow): { months: string[]; sinceMs: number } {
  const now = Date.now();
  switch (window) {
    case "24h": return { months: recentMonths(2), sinceMs: now - DAY };
    case "7d": return { months: recentMonths(2), sinceMs: now - 7 * DAY };
    case "30d": return { months: recentMonths(3), sinceMs: now - 30 * DAY };
    case "all": default: return { months: recentMonths(12), sinceMs: 0 };
  }
}

const low = (s?: string) => (s ?? "").toLowerCase();
const usdOf = (t: RelayedTx) => {
  // Only USD stablecoins are dollars. $Q and any non-$1 token never inflate a USD total.
  if (!USD_STABLES.has((t.tokenSymbol ?? "").toUpperCase())) return 0;
  const n = typeof t.tokenAmount === "number" ? t.tokenAmount : parseFloat(String(t.tokenAmount));
  return Number.isFinite(n) ? n : 0;
};
const inWindow = (t: RelayedTx, sinceMs: number) => {
  const ms = Date.parse(t.relayedAt);
  // fail CLOSED for bounded windows: an unparseable timestamp is only kept for "all" (sinceMs===0)
  return Number.isFinite(ms) ? ms >= sinceMs : sinceMs === 0;
};

// "Spend" = a USD-denominated stablecoin PAYMENT. A $Q transfer, or a stake /
// unstake / yield_deposit / yield_withdraw move, is a treasury/asset operation,
// not vendor spend, and must never be summed into a USD total (a 10,000 Q stake
// is not "$10,000 spent", and a yield_withdraw is money coming back in).
const USD_STABLES = new Set(["USDC", "USDT", "USDG", "PYUSD", "DAI", "USDE", "RLUSD", "FDUSD", "USDB", "GUSD", "TUSD"]);
const NON_SPEND_SOURCES = new Set(["stake", "unstake", "yield_deposit", "yield_withdraw"]);
const isUsdSpend = (t: RelayedTx) =>
  USD_STABLES.has((t.tokenSymbol ?? "").toUpperCase()) && !NON_SPEND_SOURCES.has(t.source ?? "");
// Sandbox / test rows are mock (never on-chain) and must not pollute real spend totals (mirrors db.ts billing skip).
const isSandboxRow = (t: RelayedTx) =>
  !!t.apiKey && (t.apiKey.startsWith("q402_sandbox_") || t.apiKey.startsWith("q402_test_"));

/** All recurring rules across the owner's wallets (bounded: <=10 wallets). */
async function allRules(owner: string, walletId?: string): Promise<RecurringRule[]> {
  if (walletId) return listRecurringRules(owner, walletId);
  const wallets = await listAgenticWallets(owner);
  const lists = await Promise.all(wallets.map((w) => listRecurringRules(owner, low(w.address)).catch(() => [])));
  return lists.flat();
}

function groupSum(txs: RelayedTx[], keyOf: (t: RelayedTx) => string): { key: string; usd: number; count: number }[] {
  const m = new Map<string, { key: string; usd: number; count: number }>();
  for (const t of txs) {
    const k = keyOf(t) || "unknown";
    const e = m.get(k) ?? { key: k, usd: 0, count: 0 };
    e.usd += usdOf(t);
    e.count += 1;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd);
}

/** summary — the treasury overview for q402_memory_summary. */
export async function treasurySummary(owner: string, walletId: string | undefined, window: MemoryWindow) {
  const { months, sinceMs } = windowBounds(window);
  const all = (await getRelayedTxs(owner, months, 5000)).filter((t) => !isSandboxRow(t));
  let windowed = all.filter((t) => inWindow(t, sinceMs));
  if (walletId) {
    const w = low(walletId);
    windowed = windowed.filter((t) => low(t.fromUser) === w || low(t.address) === w);
  }
  const txs = windowed.filter(isUsdSpend);                // USD stablecoin payments only
  const excludedNonSpend = windowed.length - txs.length;  // Q transfers, stake/unstake/yield asset ops

  const rules = await allRules(owner, walletId);
  const activeRules = rules.filter((r) => r.status === "active");
  const nextFireAt = activeRules
    .map((r) => r.nextRunAt)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b)[0] ?? null;

  const reqs = (await listPaymentRequestsPage(owner, { limit: 200 }).catch(() => ({ records: [] as never[] }))).records;
  let escrows = (await listEscrowsPage(owner, { limit: 200 }).catch(() => ({ records: [] as never[] }))).records;
  if (walletId) {
    const w = low(walletId);
    escrows = escrows.filter((e) => low(e.fundingWalletId) === w);   // escrows funded by THIS agent wallet
  }

  // Failures / holds are not a first-class store: surface the observable ones.
  const failuresAndHolds: { kind: string; ref: string; status: string; error: string }[] = [
    ...rules
      .filter((r) => r.status !== "cancelled" && (r.status === "fired-cap-exceeded" || !!r.lastError))
      .map((r) => ({ kind: "recurring", ref: r.ruleId, status: String(r.status), error: r.lastError ?? "cap exceeded" })),
    ...escrows.filter((e) => e.status === "disputed").map((e) => ({ kind: "escrow", ref: e.id, status: "disputed", error: "in dispute" })),
  ];

  return {
    window,
    asOf: new Date().toISOString(),
    totalOutUsd: Number(txs.reduce((s, t) => s + usdOf(t), 0).toFixed(2)),
    txCount: txs.length,
    excludedNonSpend,   // rows kept out of USD totals: $Q transfers + stake/unstake/yield asset ops
    byChain: groupSum(txs, (t) => t.chain).map((e) => ({ chain: e.key, usd: Number(e.usd.toFixed(2)), count: e.count })),
    bySource: groupSum(txs, (t) => t.source ?? "send").map((e) => ({ source: e.key, usd: Number(e.usd.toFixed(2)), count: e.count })),
    topVendors: groupSum(txs, (t) => low(t.toUser)).slice(0, 8).map((e) => ({ to: e.key, usd: Number(e.usd.toFixed(2)), count: e.count })),
    scheduled: { activeRules: activeRules.length, nextFireAt },
    requests: { open: reqs.filter((r) => r.status === "open").length, paid: reqs.filter((r) => r.status === "paid").length, scope: walletId ? "account-wide" : "all" },
    escrow: { open: escrows.filter((e) => e.status === "open").length, disputed: escrows.filter((e) => e.status === "disputed").length, scope: walletId ? "wallet" : "all" },
    failuresAndHolds,
  };
}

/** vendor — per-vendor spend for q402_vendor_history. */
export async function vendorHistory(owner: string, walletId: string | undefined, vendor: string | undefined, window: MemoryWindow) {
  const { months, sinceMs } = windowBounds(window);
  let txs = (await getRelayedTxs(owner, months, 5000)).filter((t) => !isSandboxRow(t) && inWindow(t, sinceMs));
  if (walletId) {
    const w = low(walletId);
    txs = txs.filter((t) => low(t.fromUser) === w || low(t.address) === w);   // scope to this Agent Wallet
  }
  txs = txs.filter(isUsdSpend);
  const rules = await allRules(owner, walletId);

  if (vendor) {
    const v = low(vendor);
    const rows = txs.filter((t) => low(t.toUser) === v);
    const times = rows.map((t) => Date.parse(t.relayedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const rule = rules.find((r) => (r.recipients ?? []).some((rp) => low(rp.to) === v));
    return {
      window,
      vendor: v,
      totalPaidUsd: Number(rows.reduce((s, t) => s + usdOf(t), 0).toFixed(2)),
      txCount: rows.length,
      firstPaidAt: times.length ? new Date(times[0]).toISOString() : null,
      lastPaidAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
      cadence: rule?.frequency ?? null,
    };
  }

  const monthlyVendors = new Set(
    rules.filter((r) => (r.frequency ?? "").startsWith("monthly")).flatMap((r) => (r.recipients ?? []).map((rp) => low(rp.to))),
  );
  const vendors = groupSum(txs, (t) => low(t.toUser))
    .slice(0, 20)
    .map((e) => ({ vendor: e.key, usd: Number(e.usd.toFixed(2)), count: e.count, recurringMonthly: monthlyVendors.has(e.key) }));
  return { window, vendors };
}

/** agent — per-Agent-Wallet spend for q402_agent_spend_report. */
export async function agentSpendReport(owner: string, window: MemoryWindow) {
  const { months, sinceMs } = windowBounds(window);
  const txs = (await getRelayedTxs(owner, months, 5000)).filter((t) => !isSandboxRow(t) && inWindow(t, sinceMs) && isUsdSpend(t));
  const wallets = await listAgenticWallets(owner);
  const agents = wallets.map((w) => {
    const addr = low(w.address);
    const rows = txs.filter((t) => low(t.fromUser) === addr || low(t.address) === addr);
    return {
      walletId: addr,
      label: w.label ?? null,
      address: w.address,
      spentUsd: Number(rows.reduce((s, t) => s + usdOf(t), 0).toFixed(2)),
      txCount: rows.length,
      dailyLimitUsd: w.dailyLimitUsd ?? null,
      perTxMaxUsd: w.perTxMaxUsd ?? null,
    };
  });
  return { window, agents: agents.sort((a, b) => b.spentUsd - a.spentUsd) };
}
