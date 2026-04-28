/**
 * db.ts — Vercel KV (Redis) backed data layer
 * Drop-in replacement for the previous fs/db.json implementation.
 *
 * Required env vars (set in Vercel dashboard or .env.local):
 *   KV_REST_API_URL   — from Vercel KV store
 *   KV_REST_API_TOKEN — from Vercel KV store
 */
import { kv } from "@vercel/kv";
import { TIER_CREDITS, TIER_PLANS } from "@/app/lib/blockchain";

interface Subscription {
  paidAt: string;
  apiKey: string;
  plan: string;
  txHash: string;
  amountUSD: number;
  quotaBonus?: number;
  sandboxApiKey?: string;
  // Cumulative BNB-equivalent USD paid in the current 30-day window.
  // Reset when the prior expiry (paidAt + 30d) has lapsed before the next
  // payment arrives. Optional to keep the type backwards compatible — any
  // undefined value is lazily bootstrapped from amountUSD on read.
  windowPaidBnbUSD?: number;
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

export interface WebhookDelivery {
  timestamp: string;
  event: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
  attempt: number;  // 1-based attempt number that succeeded or final attempt on failure
}

export interface GasDeposit {
  chain: string;       // "bnb" | "eth" | "avax" | "xlayer" | "stable" | "mantle" | "injective"
  token: string;       // "BNB" | "ETH" | "AVAX" | "OKB" | "USDT0" | "MNT" | "INJ"
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
  tokenAmount: number | string;  // USDC/USDT amount (string for 18-dec precision)
  tokenSymbol: string;
  gasCostNative: number; // gas used in native token (BNB/ETH/AVAX)
  relayTxHash: string;   // on-chain tx hash
  relayedAt: string;
}

// ── Key helpers ──────────────────────────────────────────────────────────────

const subKey             = (addr: string) => `sub:${addr.toLowerCase()}`;
const apiKeyRecKey       = (key: string)  => `apikey:${key}`;
const gasDepKey          = (addr: string) => `gasdep:${addr.toLowerCase()}`;
const webhookKey         = (addr: string) => `webhook:${addr.toLowerCase()}`;
const webhookDeliveryKey = (addr: string) => `webhook_delivery:${addr.toLowerCase()}`;

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

/**
 * Update the `plan` field on an existing API key record in place.
 * Used when a cumulative payment upgrades a subscriber's tier — the api-key
 * plan is what the relay route reads for feature gates.
 */
export async function updateApiKeyPlan(apiKey: string, plan: string): Promise<void> {
  const rec = await getApiKeyRecord(apiKey);
  if (!rec) return;
  await kv.set(apiKeyRecKey(apiKey), { ...rec, plan });
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

  // Distributed lock — prevent concurrent rotations for the same address.
  const rotLockKey = `rotation_pending:${address.toLowerCase()}`;
  const locked = await kv.set(rotLockKey, "1", { nx: true, ex: 30 });
  if (!locked) throw new Error("Key rotation already in progress. Please wait a moment.");

  try {
    const oldKey = sub.apiKey;

    // Step 1: Create new key (immediately active).
    const newKey = await generateApiKey(address, sub.plan);

    // Step 2: Point subscription at new key.
    // If this throws, old key is still valid — user can retry safely.
    await setSubscription(address, { ...sub, apiKey: newKey });

    // Step 3: Deactivate old key (best-effort — new key is already live).
    // Non-fatal: a dangling active old key is preferable to a user locked out.
    if (oldKey) {
      deactivateApiKey(oldKey).catch(e =>
        console.error(`[rotate] old key deactivation failed (non-fatal): ${e}`)
      );
    }

    return newKey;
  } finally {
    kv.del(rotLockKey).catch(() => {});
  }
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

/**
 * Prepend a delivery record (LPUSH) and cap list at 20 entries.
 * Most recent delivery is always at index 0.
 */
export async function recordWebhookDelivery(address: string, delivery: WebhookDelivery) {
  const key = webhookDeliveryKey(address);
  await kv.lpush(key, delivery);
  kv.ltrim(key, 0, 19).catch(() => {});
}

/** Returns up to 20 most recent delivery records, newest first. */
export async function getWebhookDeliveries(address: string): Promise<WebhookDelivery[]> {
  return kv.lrange<WebhookDelivery>(webhookDeliveryKey(address), 0, 19);
}

// ── Gas Deposits ─────────────────────────────────────────────────────────────

// Separate SET key for O(1) dedup — avoids reading the full deposit list
const gasDepDedupKey = (addr: string) => `gasdep_hashes:${addr.toLowerCase()}`;

/**
 * Returns gas deposits for `address`.
 * New format: Redis List (LRANGE). Fallback: legacy JSON array stored as string.
 */
export async function getGasDeposits(address: string): Promise<GasDeposit[]> {
  try {
    const list = await kv.lrange<GasDeposit>(gasDepKey(address), 0, -1);
    if (list.length > 0) return list;
  } catch { /* WRONGTYPE — legacy JSON array key */ }
  return (await kv.get<GasDeposit[]>(gasDepKey(address))) ?? [];
}

/**
 * Appends a deposit atomically using RPUSH.
 * Dedup is enforced via a separate Redis SET (SADD) — O(1) and race-safe.
 * Returns true if added, false if duplicate.
 */
export async function addGasDeposit(address: string, deposit: GasDeposit): Promise<boolean> {
  if (deposit.txHash) {
    try {
      const added = await kv.sadd(gasDepDedupKey(address), deposit.txHash);
      if (added === 0) return false; // duplicate
      kv.expire(gasDepDedupKey(address), 90 * 24 * 60 * 60).catch(() => {});
      await kv.rpush(gasDepKey(address), deposit);
      return true;
    } catch { /* fall through to legacy */ }
  }
  // Legacy fallback (old JSON array keys or txHash missing)
  const existing = await getGasDeposits(address);
  if (existing.some(d => d.txHash === deposit.txHash)) return false;
  await kv.set(gasDepKey(address), [...existing, deposit]);
  return true;
}

export async function getGasBalance(address: string): Promise<Record<string, number>> {
  const [deposits, usedTotals] = await Promise.all([
    getGasDeposits(address),
    getGasUsedTotals(address),
  ]);
  const totals: Record<string, number> = { bnb: 0, eth: 0, mantle: 0, injective: 0, avax: 0, xlayer: 0, stable: 0 };
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
 *
 * `limitPerMonth` bounds how many of the most recent entries are fetched per
 * month so a heavy Enterprise account (up to 500K credits / window — see
 * recordRelayedTx's MAX_TX_HISTORY) does not blow the response payload. Pass
 * a large value or `Infinity` if you need full history.
 *
 * New format: Redis List (LRANGE). Fallback: legacy JSON array stored as string.
 */
export async function getRelayedTxs(
  address: string,
  months?: string[],   // e.g. ["2026-04", "2026-03"]
  limitPerMonth: number = 10_000,
): Promise<RelayedTx[]> {
  const targets = months ?? [ym(), ym(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))];
  const unique = [...new Set(targets)];
  const start = Number.isFinite(limitPerMonth) ? -Math.max(1, Math.floor(limitPerMonth)) : 0;
  const results = await Promise.all(
    unique.map(async (m) => {
      const key = relayTxMonthKey(address, m);
      try {
        const list = await kv.lrange<RelayedTx>(key, start, -1);
        if (list.length > 0) return list;
      } catch { /* WRONGTYPE — legacy JSON array key */ }
      const arr = (await kv.get<RelayedTx[]>(key)) ?? [];
      return Number.isFinite(limitPerMonth) ? arr.slice(-Math.max(1, Math.floor(limitPerMonth))) : arr;
    })
  );
  return results.flat();
}

/**
 * Returns only this month's TX count — cheap single KV read for quota checks.
 */
export async function getThisMonthTxCount(address: string): Promise<number> {
  const key = relayTxMonthKey(address, ym());
  try {
    const len = await kv.llen(key);
    if (len > 0) return len;
  } catch { /* WRONGTYPE — legacy format */ }
  const txs = await kv.get<RelayedTx[]>(key);
  return txs?.length ?? 0;
}

/**
 * Returns per-chain gas used as a running total.
 * New format: Redis Hash (HGETALL). Fallback: legacy JSON object stored as string.
 */
export async function getGasUsedTotals(address: string): Promise<Record<string, number>> {
  try {
    const raw = await kv.hgetall<Record<string, string>>(gasUsedKey(address));
    if (raw && Object.keys(raw).length > 0) {
      return Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, parseFloat(String(v)) || 0])
      );
    }
  } catch { /* WRONGTYPE — legacy JSON object key */ }
  return (await kv.get<Record<string, number>>(gasUsedKey(address))) ?? {};
}

/**
 * Appends a TX record atomically using RPUSH (no read-modify-write race).
 * Gas totals updated atomically via HINCRBYFLOAT.
 * Legacy JSON array/object keys are handled via try/catch fallback.
 */
export async function recordRelayedTx(address: string, tx: RelayedTx) {
  const month = ym(new Date(tx.relayedAt));
  const key   = relayTxMonthKey(address, month);

  // Per-month list cap — sized to the largest tier's credit grant so a paying
  // Enterprise customer (500K credits / 30-day window) never silently loses
  // history. Billing/quota uses an independent atomic counter (decrementCredit),
  // so this cap is purely the on-disk display history bound.
  const MAX_TX_HISTORY = TIER_CREDITS[TIER_CREDITS.length - 1];
  try {
    const len = await kv.rpush(key, tx);
    if (len > MAX_TX_HISTORY) kv.ltrim(key, -MAX_TX_HISTORY, -1).catch(() => {});
  } catch {
    // Legacy fallback for existing JSON array keys
    const existing = (await kv.get<RelayedTx[]>(key)) ?? [];
    if (existing.length < MAX_TX_HISTORY) await kv.set(key, [...existing, tx]);
  }

  if (tx.gasCostNative > 0) {
    try {
      // HINCRBYFLOAT is atomic — no read-modify-write race on gas totals
      await kv.hincrbyfloat(gasUsedKey(address), tx.chain, tx.gasCostNative);
    } catch {
      // Legacy fallback for existing JSON object keys
      const totals = (await kv.get<Record<string, number>>(gasUsedKey(address))) ?? {};
      totals[tx.chain] = (totals[tx.chain] ?? 0) + tx.gasCostNative;
      await kv.set(gasUsedKey(address), totals);
    }
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

// Derived from blockchain.ts SOT (TIER_PLANS ↔ TIER_CREDITS) so a tier-table
// edit on the pricing side automatically propagates here. Previously this
// was a hand-maintained map and had drifted: growth was 10_000 (should be
// 5_000), scale was 100_000 (should be 50_000), and a stale "enterprise"
// alias mapped to 100_000. The bad values surfaced via /api/keys/topup's
// admin response (`newTotalQuota`) and quietly misreported quotas.
const PLAN_QUOTA: Record<string, number> = Object.fromEntries(
  TIER_PLANS.map((p, i) => [p, TIER_CREDITS[i]]),
);

export function getPlanQuota(plan: string): number {
  return PLAN_QUOTA[plan?.toLowerCase()] ?? TIER_CREDITS[1];
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

// ── Usage alerts (email) ──────────────────────────────────────────────────────
// One config per wallet address. lastThresholdAlerted tracks the lowest
// percent-remaining tier we've already mailed for in the *current* credit
// window, so the cron never spams. It resets to null after a top-up — the
// activate route calls resetUsageAlertState() so the next downward crossing
// fires fresh alerts.
//
// Membership index: alertaddrs is a Redis Set of every address that has an
// active alert config, so the cron iterates without scanning all KV keys.

export interface UsageAlertConfig {
  email:                  string;
  createdAt:              string;
  lastThresholdAlerted:   number | null;   // 20 | 10 | null
}

const alertKey       = (addr: string) => `usage_alert:${addr.toLowerCase()}`;
const ALERT_INDEX_SET = "usage_alert:_index";

export async function getUsageAlert(address: string): Promise<UsageAlertConfig | null> {
  return kv.get<UsageAlertConfig>(alertKey(address));
}

export async function setUsageAlert(address: string, email: string): Promise<UsageAlertConfig> {
  const cfg: UsageAlertConfig = {
    email,
    createdAt:            new Date().toISOString(),
    lastThresholdAlerted: null,
  };
  await Promise.all([
    kv.set(alertKey(address), cfg),
    kv.sadd(ALERT_INDEX_SET, address.toLowerCase()),
  ]);
  return cfg;
}

export async function clearUsageAlert(address: string): Promise<void> {
  await Promise.all([
    kv.del(alertKey(address)),
    kv.srem(ALERT_INDEX_SET, address.toLowerCase()),
  ]);
}

/**
 * Mark `threshold` as the lowest tier we've alerted for. Idempotent — only
 * advances downward (10 < 20). The cron uses this to avoid re-alerting the
 * same crossing on every daily run.
 */
export async function recordAlertSent(address: string, threshold: number): Promise<void> {
  const cur = await getUsageAlert(address);
  if (!cur) return;
  const prev = cur.lastThresholdAlerted ?? Number.POSITIVE_INFINITY;
  if (threshold >= prev) return;   // we've already alerted at this or a deeper level
  await kv.set(alertKey(address), { ...cur, lastThresholdAlerted: threshold });
}

/**
 * Reset the alert hysteresis after a top-up so the next downward crossing
 * fires alerts again. Called from the activate route on successful credit
 * grant. Best-effort.
 */
export async function resetUsageAlertState(address: string): Promise<void> {
  const cur = await getUsageAlert(address);
  if (!cur || cur.lastThresholdAlerted == null) return;
  await kv.set(alertKey(address), { ...cur, lastThresholdAlerted: null });
}

export async function listUsageAlertAddresses(): Promise<string[]> {
  const members = await kv.smembers(ALERT_INDEX_SET);
  return Array.isArray(members) ? members.map(String) : [];
}
