/**
 * db.ts — Vercel KV (Redis) backed data layer
 * Drop-in replacement for the previous fs/db.json implementation.
 *
 * Required env vars (set in Vercel dashboard or .env.local):
 *   KV_REST_API_URL   — from Vercel KV store
 *   KV_REST_API_TOKEN — from Vercel KV store
 */
import { kv } from "@vercel/kv";

interface Subscription {
  paidAt: string;
  apiKey: string;
  plan: string;
  txHash: string;
  amountUSD: number;
  quotaBonus?: number;
  sandboxApiKey?: string;
}

interface ApiKeyRecord {
  address: string;
  createdAt: string;
  active: boolean;
  plan: string;
  isSandbox?: boolean;
}

export interface WebhookConfig {
  url: string;
  secret: string;   // HMAC-SHA256 signing secret
  createdAt: string;
  active: boolean;
}

export interface GasDeposit {
  chain: string;       // "bnb" | "eth" | "avax" | "xlayer"
  token: string;       // "BNB" | "ETH" | "AVAX"
  amount: number;      // native token amount
  txHash: string;
  depositedAt: string;
}

export interface RelayedTx {
  apiKey: string;
  address: string;      // client wallet address
  chain: string;
  fromUser: string;     // user who sent the payment
  toUser: string;       // recipient
  tokenAmount: number;  // USDC/USDT amount sent
  tokenSymbol: string;
  gasCostNative: number; // gas used in native token (BNB/ETH/AVAX)
  relayTxHash: string;   // on-chain tx hash
  relayedAt: string;
}

// ── Key helpers ──────────────────────────────────────────────────────────────

const subKey        = (addr: string) => `sub:${addr.toLowerCase()}`;
const apiKeyRecKey  = (key: string)  => `apikey:${key}`;
const gasDepKey     = (addr: string) => `gasdep:${addr.toLowerCase()}`;
const webhookKey    = (addr: string) => `webhook:${addr.toLowerCase()}`;

// ── TX history: monthly keys to avoid 1 MB KV limit ──────────────────────────
// relaytx:{addr}:{YYYY-MM}  → RelayedTx[]  (one key per calendar month)
// gasused:{addr}            → Record<chain, number>  (running gas total)
function ym(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
const relayTxMonthKey = (addr: string, month: string) =>
  `relaytx:${addr.toLowerCase()}:${month}`;
const gasUsedKey = (addr: string) => `gasused:${addr.toLowerCase()}`;

// ── Subscriptions ────────────────────────────────────────────────────────────

export async function getSubscription(address: string): Promise<Subscription | null> {
  return kv.get<Subscription>(subKey(address));
}

export async function setSubscription(address: string, data: Subscription) {
  await kv.set(subKey(address), data);
}

// ── API Keys ─────────────────────────────────────────────────────────────────

export async function getApiKeyRecord(apiKey: string): Promise<ApiKeyRecord | null> {
  return kv.get<ApiKeyRecord>(apiKeyRecKey(apiKey));
}

export async function deactivateApiKey(apiKey: string) {
  const record = await getApiKeyRecord(apiKey);
  if (record) {
    await kv.set(apiKeyRecKey(apiKey), { ...record, active: false });
  }
}

export async function generateApiKey(address: string, plan: string): Promise<string> {
  const { randomBytes } = await import("crypto");
  const rand = randomBytes(24).toString("hex");
  const key = `q402_live_${rand}`;
  await kv.set(apiKeyRecKey(key), {
    address: address.toLowerCase(),
    createdAt: new Date().toISOString(),
    active: true,
    plan,
  } satisfies ApiKeyRecord);
  return key;
}

export async function generateSandboxKey(address: string, plan: string): Promise<string> {
  const { randomBytes } = await import("crypto");
  const rand = randomBytes(24).toString("hex");
  const key = `q402_test_${rand}`;
  await kv.set(apiKeyRecKey(key), {
    address: address.toLowerCase(),
    createdAt: new Date().toISOString(),
    active: true,
    plan,
    isSandbox: true,
  } satisfies ApiKeyRecord);
  return key;
}

export async function rotateApiKey(address: string): Promise<string> {
  const sub = await getSubscription(address);
  if (!sub) throw new Error("No subscription found");
  if (sub.apiKey) await deactivateApiKey(sub.apiKey);
  const newKey = await generateApiKey(address, sub.plan);
  await setSubscription(address, { ...sub, apiKey: newKey });
  return newKey;
}

// ── Webhook Config ────────────────────────────────────────────────────────────

export async function getWebhookConfig(address: string): Promise<WebhookConfig | null> {
  return kv.get<WebhookConfig>(webhookKey(address));
}

export async function setWebhookConfig(address: string, config: WebhookConfig) {
  await kv.set(webhookKey(address), config);
}

export async function deleteWebhookConfig(address: string) {
  await kv.del(webhookKey(address));
}

// ── Gas Deposits ─────────────────────────────────────────────────────────────

export async function getGasDeposits(address: string): Promise<GasDeposit[]> {
  return (await kv.get<GasDeposit[]>(gasDepKey(address))) ?? [];
}

/** Returns true if the deposit was added, false if it was a duplicate (already recorded). */
export async function addGasDeposit(address: string, deposit: GasDeposit): Promise<boolean> {
  const existing = await getGasDeposits(address);
  if (existing.some(d => d.txHash === deposit.txHash)) return false; // deduplicate
  await kv.set(gasDepKey(address), [...existing, deposit]);
  return true;
}

export async function getGasBalance(address: string): Promise<Record<string, number>> {
  const [deposits, usedTotals] = await Promise.all([
    getGasDeposits(address),
    getGasUsedTotals(address),
  ]);
  const totals: Record<string, number> = { bnb: 0, eth: 0, avax: 0, xlayer: 0, stable: 0 };
  for (const d of deposits) totals[d.chain] = (totals[d.chain] ?? 0) + d.amount;
  for (const chain of Object.keys(usedTotals)) {
    totals[chain] = (totals[chain] ?? 0) - usedTotals[chain];
  }
  // Clamp to 0 — negative balance means deposit was never recorded in KV
  for (const chain of Object.keys(totals)) {
    if (totals[chain] < 0) totals[chain] = 0;
  }
  return totals;
}

// ── Relayed TXs ───────────────────────────────────────────────────────────────

/**
 * Returns relayed TXs for the given address across the specified months.
 * Defaults to current + previous month (covers quota checks and dashboard).
 */
export async function getRelayedTxs(
  address: string,
  months?: string[],   // e.g. ["2026-04", "2026-03"]
): Promise<RelayedTx[]> {
  const targets = months ?? [ym(), ym(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))];
  const unique = [...new Set(targets)];
  const results = await Promise.all(
    unique.map(m => kv.get<RelayedTx[]>(relayTxMonthKey(address, m)).then(v => v ?? []))
  );
  return results.flat();
}

/**
 * Returns only this month's TX count — cheap single KV read for quota checks.
 */
export async function getThisMonthTxCount(address: string): Promise<number> {
  const txs = await kv.get<RelayedTx[]>(relayTxMonthKey(address, ym()));
  return txs?.length ?? 0;
}

/**
 * Returns per-chain gas used as a running total (separate from TX list).
 * Much cheaper than summing all TX records.
 */
export async function getGasUsedTotals(address: string): Promise<Record<string, number>> {
  return (await kv.get<Record<string, number>>(gasUsedKey(address))) ?? {};
}

export async function recordRelayedTx(address: string, tx: RelayedTx) {
  const month = ym(new Date(tx.relayedAt));
  const existing = (await kv.get<RelayedTx[]>(relayTxMonthKey(address, month))) ?? [];
  // Cap per-month array at 10,000 entries (safety valve)
  if (existing.length < 10_000) {
    await kv.set(relayTxMonthKey(address, month), [...existing, tx]);
  }
  // Update running gas total
  if (tx.gasCostNative > 0) {
    const totals = await getGasUsedTotals(address);
    totals[tx.chain] = (totals[tx.chain] ?? 0) + tx.gasCostNative;
    await kv.set(gasUsedKey(address), totals);
  }
}

/** @deprecated Use getRelayedTxs with months param */
export async function getGasUsed(address: string): Promise<RelayedTx[]> {
  return getRelayedTxs(address);
}

// ── Atomic TX credit counter ──────────────────────────────────────────────────
// quota:{addr} is a Redis integer key updated via DECRBY/INCRBY.
// This avoids the read-modify-write race in concurrent relay requests.
// subscription.quotaBonus is kept in sync (fire-and-forget) for display only.

const quotaKey = (addr: string) => `quota:${addr.toLowerCase()}`;

/**
 * Returns current remaining TX credits from the atomic quota key.
 * Falls back to subscription.quotaBonus for accounts not yet migrated.
 */
export async function getQuotaCredits(address: string): Promise<number> {
  const val = await kv.get<number>(quotaKey(address));
  if (val !== null) return Math.max(0, val);
  // Fallback for pre-migration accounts — read from subscription JSON
  const sub = await getSubscription(address);
  return Math.max(0, sub?.quotaBonus ?? 0);
}

/**
 * Initialize the atomic quota key from `initialAmount` only if the key does
 * not already exist (SET NX — safe to call on every relay, no-op after first).
 * Migrates old accounts on their first relay after this change.
 */
export async function initQuotaIfNeeded(address: string, initialAmount: number): Promise<void> {
  await kv.set(quotaKey(address), Math.max(0, initialAmount), { nx: true });
}

/**
 * Atomically decrement TX credit by 1 (DECRBY).
 * Returns { ok: true, remaining } if a credit was available,
 *         { ok: false, remaining: 0 } if the counter was already at 0.
 * On underflow (result < 0), the credit is immediately restored so the
 * counter stays at 0 and the caller must not proceed with the relay.
 */
export async function decrementCredit(
  address: string,
): Promise<{ ok: boolean; remaining: number }> {
  const key = quotaKey(address);
  const newVal = await kv.decrby(key, 1);
  if (newVal < 0) {
    // Compensate: restore counter to 0 (another concurrent request may also be here)
    await kv.incrby(key, 1);
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: newVal };
}

/**
 * Refund 1 TX credit — call when a relay attempt fails after credit was reserved.
 */
export async function refundCredit(address: string): Promise<void> {
  await kv.incrby(quotaKey(address), 1);
}

/**
 * Atomically add TX credits (INCRBY).  Used by payment activation and admin topup.
 * Returns the new total remaining credits.
 */
export async function addCredits(address: string, amount: number): Promise<number> {
  if (amount <= 0) return getQuotaCredits(address);
  return kv.incrby(quotaKey(address), amount);
}

export async function addQuotaBonus(address: string, additionalTxs: number) {
  const sub = await getSubscription(address);
  if (!sub) throw new Error("No subscription found");
  // Update atomic counter + subscription JSON in parallel
  await Promise.all([
    addCredits(address, additionalTxs),
    setSubscription(address, {
      ...sub,
      quotaBonus: (sub.quotaBonus ?? 0) + additionalTxs,
    }),
  ]);
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

const PLAN_QUOTA: Record<string, number> = {
  starter:          500,
  basic:          1_000,
  growth:        10_000,
  pro:           10_000,
  scale:        100_000,
  business:     100_000,
  enterprise:   100_000,
  enterprise_flex: 500_000,
};

export function getPlanQuota(plan: string): number {
  return PLAN_QUOTA[plan?.toLowerCase()] ?? 1_000;
}

export async function isSubscriptionActive(address: string): Promise<boolean> {
  const sub = await getSubscription(address);
  if (!sub || !sub.paidAt || (sub.amountUSD ?? 0) === 0) return false;
  const expiresAt = new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  return new Date() < expiresAt;
}

export async function getSubscriptionExpiry(address: string): Promise<Date | null> {
  const sub = await getSubscription(address);
  if (!sub || !sub.paidAt || (sub.amountUSD ?? 0) === 0) return null;
  return new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
}
