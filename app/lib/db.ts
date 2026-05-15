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
  // Paid-plan live key. Only minted by /api/payment/activate. Empty string
  // on a freshly provisioned (unpaid) account. NEVER reused as a trial key —
  // trial activation mints into trialApiKey instead so the two scopes stay
  // isolated. If a user pays during/after a trial, this slot gets a brand
  // new key while trialApiKey keeps working until trialExpiresAt.
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
  // Trial-only fields. When `plan === "trial"`, `trialExpiresAt` is the
  // canonical expiry (paidAt + TRIAL_DURATION_DAYS, materialized at activation
  // so the dashboard can display it without recomputing). `email` is set when
  // the user pairs their wallet with a verified email via the magic-link flow.
  trialExpiresAt?: string;
  email?: string;
  // Trial keys — separate slot from apiKey/sandboxApiKey so a paid upgrade
  // can mint fresh paid keys without invalidating the trial keys (trial keys
  // expire naturally with trialExpiresAt). Dashboard surfaces these in the
  // "Free Trial" view; relay route gates by the api-key record's own plan,
  // so even if both keys exist simultaneously the live one and the trial one
  // see independent feature gates.
  trialApiKey?: string;
  trialSandboxApiKey?: string;
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
  txHash?: string;  // on-chain tx the dispatch was for — lets receipt-backfill
                    // recover the actual delivery state instead of guessing
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
  gasCostNative: number; // gas used in native token (BNB/ETH/AVAX/OKB/USDT0/MNT/INJ)
  relayTxHash: string;   // on-chain tx hash
  relayedAt: string;
  receiptId?: string;    // Trust Receipt id (rct_…), populated when receipt created successfully
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

// Tx-keyed delivery index. The per-address list is capped at 20 entries so
// a heavy webhook customer can roll old deliveries off the back of the
// list. The receipt backfill then loses the ability to recover those
// older deliveries' state ("delivered" / "failed") and falls back to
// "pending", which is a false negative for receipts produced after the
// audit log has aged. This per-tx key keeps the most recent delivery for
// each settlement reachable for 1 year regardless of subsequent traffic.
const webhookDeliveryByTxKey = (txHash: string) =>
  `webhook_delivery_by_tx:${txHash.toLowerCase()}`;

const WEBHOOK_DELIVERY_BY_TX_TTL_SECONDS = 365 * 24 * 60 * 60;     // 1 year, mirrors receipts

/**
 * Prepend a delivery record (LPUSH) and cap list at 20 entries.
 * Most recent delivery is always at index 0.
 *
 * Also writes a tx-keyed copy so receipt-backfill can recover state for
 * settlements older than 20 webhook events ago.
 */
export async function recordWebhookDelivery(address: string, delivery: WebhookDelivery) {
  const key = webhookDeliveryKey(address);
  await kv.lpush(key, delivery);
  kv.ltrim(key, 0, 19).catch(() => {});

  if (delivery.txHash) {
    // Best-effort — the per-address list is the canonical record; this
    // index is a backfill helper. Failure here doesn't affect dispatch
    // accounting.
    kv.set(
      webhookDeliveryByTxKey(delivery.txHash),
      delivery,
      { ex: WEBHOOK_DELIVERY_BY_TX_TTL_SECONDS },
    ).catch(() => {});
  }
}

/** Returns up to 20 most recent delivery records, newest first. */
export async function getWebhookDeliveries(address: string): Promise<WebhookDelivery[]> {
  return kv.lrange<WebhookDelivery>(webhookDeliveryKey(address), 0, 19);
}

/**
 * Returns the most recent delivery record for a given txHash, or null if
 * none was ever recorded. Reads the tx-keyed index — survives the 20-entry
 * cap on the per-address list, so receipt-backfill can recover the truthful
 * delivery state for settlements that happened arbitrarily long ago.
 */
export async function getWebhookDeliveryByTx(txHash: string): Promise<WebhookDelivery | null> {
  return kv.get<WebhookDelivery>(webhookDeliveryByTxKey(txHash));
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
 *
 * IMPORTANT — dedup SET has NO TTL on purpose. An earlier version of this
 * function expired the SET after 90d to bound KV cost, but that opened a
 * money-loss bug: after expiry, the same historical txHash re-verified
 * (manual support credit, re-scan job, anything that re-presents an old
 * deposit) would SADD=1 and RPUSH a duplicate credit. KV cost of the
 * dedup SET is bounded by the number of deposits a wallet has ever made
 * — negligible compared to the cost of erroneously double-crediting.
 * The defence-in-depth `existing.some(...)` check on the duplicate path
 * below also catches any list↔set drift if the SET ever did get evicted.
 */
export async function addGasDeposit(address: string, deposit: GasDeposit): Promise<boolean> {
  if (deposit.txHash) {
    try {
      const added = await kv.sadd(gasDepDedupKey(address), deposit.txHash);
      if (added === 0) {
        // Repair rare dedup/list drift: SADD may have succeeded while RPUSH
        // failed or timed out, leaving the txHash marked credited but absent
        // from the ledger. In that case, append the missing deposit so
        // balances reconcile instead of staying at zero forever.
        const existing = await getGasDeposits(address);
        if (existing.some(d => d.txHash === deposit.txHash)) return false;
        await kv.rpush(gasDepKey(address), deposit);
        return true;
      }
      // SET was previously expired? Belt-and-suspenders: scan the deposits
      // list before RPUSH so a TTL-evicted SET (or migration drift) can't
      // produce a double-credit even if SADD returned "new".
      const existing = await getGasDeposits(address);
      if (existing.some(d => d.txHash === deposit.txHash)) return false;
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
    getBillableGasUsedTotals(address),
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

function recentMonths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    return ym(d);
  });
}

/**
 * Returns billable gas only. Sandbox relays are useful for integration testing
 * but never touch the chain, so they must not consume a user's Gas Tank.
 *
 * The hash total (`gasused:{addr}`) is kept as an atomic write-through cache for
 * live relays, but early preview builds accidentally wrote sandbox gas there.
 * Recomputing from relay history repairs that drift for dashboard balances.
 */
async function getBillableGasUsedTotals(address: string): Promise<Record<string, number>> {
  const txs = await getRelayedTxs(address, recentMonths(12), Number.POSITIVE_INFINITY);
  if (txs.length === 0) return getGasUsedTotals(address);

  const totals: Record<string, number> = {};
  for (const tx of txs) {
    if (tx.apiKey?.startsWith("q402_sandbox_") || tx.apiKey?.startsWith("q402_test_")) continue;
    if (!tx.chain || tx.gasCostNative <= 0) continue;
    totals[tx.chain] = (totals[tx.chain] ?? 0) + tx.gasCostNative;
  }
  return totals;
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

/**
 * Patch the receiptId of an existing RelayedTx history row. Used by the
 * receipt backfill cron after it successfully creates the deferred receipt:
 * the original record was written with receiptId=undefined (because inline
 * createReceipt failed), and the dashboard "View Receipt" link is keyed on
 * that field. Without this patch the dashboard would forever show "—" for
 * that row even after the backfill caught up.
 *
 * Looks up the right monthly key via `relayedAt` (so we don't have to scan
 * every month), with a one-month fallback for clock skew. Tries the LIST
 * format first (kv.lset by index), falls back to legacy JSON-array format.
 * Returns true if the patch landed, false if the row couldn't be located —
 * the caller logs but doesn't fail; the receipt itself is the source of
 * truth and the dashboard column is cosmetic.
 */
export async function patchRelayedTxReceiptId(
  address:     string,
  txHash:      string,
  receiptId:   string,
  relayedAt?:  string,
): Promise<boolean> {
  const targetTxLc = txHash.toLowerCase();
  // Primary: the month containing relayedAt. Fallback: the immediately
  // preceding month — covers the rare case where backfill ran across a
  // month boundary or the entry's relayedAt is missing.
  const months = relayedAt
    ? [ym(new Date(relayedAt)), ym(new Date(new Date(relayedAt).getTime() - 30 * 24 * 60 * 60 * 1000))]
    : recentMonths(2);

  for (const month of months) {
    const key = relayTxMonthKey(address, month);

    // LIST path
    try {
      const list = await kv.lrange<RelayedTx>(key, 0, -1);
      const idx = list.findIndex(tx => (tx.relayTxHash ?? "").toLowerCase() === targetTxLc);
      if (idx >= 0) {
        const updated = { ...list[idx], receiptId };
        // @vercel/kv exposes the underlying Upstash command; lset is
        // O(N) but our lists are bounded by MAX_TX_HISTORY anyway.
        await (kv as unknown as { lset: (k: string, i: number, v: unknown) => Promise<unknown> })
          .lset(key, idx, updated);
        return true;
      }
    } catch { /* WRONGTYPE — fall through to JSON-array path */ }

    // Legacy JSON-array fallback
    try {
      const arr = (await kv.get<RelayedTx[]>(key)) ?? [];
      const idx = arr.findIndex(tx => (tx.relayTxHash ?? "").toLowerCase() === targetTxLc);
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], receiptId };
        await kv.set(key, arr);
        return true;
      }
    } catch { /* nothing to patch in this month */ }
  }
  return false;
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
  if (!sub || !sub.paidAt) return false;
  // Trial: amountUSD is 0 but trialExpiresAt is the authoritative window. The
  // legacy `amountUSD > 0` gate would have rejected every trial otherwise.
  if (sub.plan === "trial") {
    if (!sub.trialExpiresAt) return false;
    return new Date() < new Date(sub.trialExpiresAt);
  }
  if ((sub.amountUSD ?? 0) === 0) return false;
  const expiresAt = new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  return new Date() < expiresAt;
}

export async function getSubscriptionExpiry(address: string): Promise<Date | null> {
  const sub = await getSubscription(address);
  if (!sub || !sub.paidAt) return null;
  if (sub.plan === "trial") {
    return sub.trialExpiresAt ? new Date(sub.trialExpiresAt) : null;
  }
  if ((sub.amountUSD ?? 0) === 0) return null;
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

// ── Trial expiration reminders ────────────────────────────────────────────────
// Parallel to the usage-alert index above. /api/trial/activate adds wallets
// to TRIAL_INDEX_SET on activation; the cron fans out across this set so
// expiry reminders cost O(trial users), not O(all KV keys).
//
// Hysteresis lives in `trial_alert:{addr}.lastDaysAlerted` — a downward
// crossing of 7d / 3d / 1d fires one email per tier. The index entry is
// auto-pruned by the cron once a trial expires (no record → no reminder).

export interface TrialAlertState {
  /** Lowest days-left tier we've already mailed for. 7 → 3 → 1 → null. */
  lastDaysAlerted: number | null;
}

const TRIAL_INDEX_SET = "trial_alert:_index";
const trialAlertKey = (addr: string) => `trial_alert:${addr.toLowerCase()}`;

export async function addTrialSubscriptionToIndex(address: string): Promise<void> {
  await kv.sadd(TRIAL_INDEX_SET, address.toLowerCase());
}

export async function removeTrialSubscriptionFromIndex(address: string): Promise<void> {
  await Promise.all([
    kv.srem(TRIAL_INDEX_SET, address.toLowerCase()),
    kv.del(trialAlertKey(address)),
  ]);
}

export async function listTrialSubscriptionAddresses(): Promise<string[]> {
  const members = await kv.smembers(TRIAL_INDEX_SET);
  return Array.isArray(members) ? members.map(String) : [];
}

export async function getTrialAlertState(address: string): Promise<TrialAlertState | null> {
  return kv.get<TrialAlertState>(trialAlertKey(address));
}

/**
 * Mark `daysTier` as the lowest expiry tier we've alerted for. Idempotent —
 * only advances downward (1 < 3 < 7) so cron re-runs on the same day don't
 * double-mail. Mirrors recordAlertSent for usage alerts.
 */
export async function recordTrialAlertSent(address: string, daysTier: number): Promise<void> {
  const cur = (await getTrialAlertState(address)) ?? { lastDaysAlerted: null };
  const prev = cur.lastDaysAlerted ?? Number.POSITIVE_INFINITY;
  if (daysTier >= prev) return;
  await kv.set(trialAlertKey(address), { lastDaysAlerted: daysTier });
}
