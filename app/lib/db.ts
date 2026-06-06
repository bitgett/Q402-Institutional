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
import { TRIAL_PLAN_NAME } from "@/app/lib/feature-flags";
import { sendOpsAlert } from "@/app/lib/ops-alerts";

export interface Subscription {
  /**
   * Window-start timestamp (NOT a literal "when the user last paid" stamp).
   * The 30-day billing window ends at `paidAt + 30d`. On a top-up while the
   * window is still active, /api/payment/activate writes `paidAt = priorExpiry`
   * (extending from the old expiry, not from now) so the user gets a fresh 30
   * days starting where the previous window ended. The literal payment time
   * is not persisted today — a separate `lastPaymentAt` field is the right
   * fix if any caller ever needs it, but no surface currently depends on it.
   */
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
  /**
   * @deprecated SUM of trialQuotaBonus + paidQuotaBonus. Kept as a back-compat
   * display mirror for any caller that hasn't migrated to the scoped fields.
   * The authoritative counters live at `quota:trial:{addr}` and `quota:paid:{addr}`.
   */
  quotaBonus?: number;
  /** Trial pool display mirror — last-known value of `quota:trial:{addr}`. */
  trialQuotaBonus?: number;
  /** Paid pool display mirror — last-known value of `quota:paid:{addr}`. */
  paidQuotaBonus?: number;
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
  chain: string;       // "bnb" | "eth" | "avax" | "xlayer" | "stable" | "mantle" | "injective" | "monad" | "scroll" | "arbitrum"
  token: string;       // "BNB" | "ETH" | "AVAX" | "OKB" | "USDT0" | "MNT" | "INJ" | "MON"
  amount: number;      // native token amount
  txHash: string;
  depositedAt: string;
}

/**
 * LinkDeposit — LINK token deposits for the CCIP bridge fee Gas Tank.
 * Distinct from GasDeposit (native gas) by KV namespace (`gasdep_link:`),
 * but identical shape so ledger math + dedup logic mirrors the existing
 * native flow.
 *
 * Scoped to the 3 CCIP chains: eth / avax / arbitrum. The bridge route
 * rejects LINK deposits for any other chain at the API boundary; this
 * type is intentionally permissive (chain: string) so the KV layer
 * stays generic.
 */
export interface LinkDeposit {
  chain: string;       // "eth" | "avax" | "arbitrum"  (enforced at API layer)
  amount: number;      // LINK amount (18-decimal, stored as fractional number)
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
  /**
   * Origin of this settlement. Drives the dashboard's "Recurring only"
   * filter on the Transactions tab and lets external accounting tooling
   * separate scheduled payouts from one-off sends.
   *
   *   - "recurring": fired by the recurring-payouts cron from a saved rule
   *   - "send":      one-shot manual send via Agent Wallet
   *   - "batch":     multi-recipient batch send via Agent Wallet
   *   - "api":       direct /api/relay call from a customer integration
   *   - undefined:   historical row pre-source-tagging. Surfaced as "All"
   *                  but never as "Recurring only" — we don't lie about
   *                  provenance for rows we can't classify.
   */
  source?: "recurring" | "send" | "batch" | "api";
  /**
   * Recurring-only metadata: which rule this fire was paying for. Lets
   * the dashboard "Recurring only" filter group by rule and the
   * accounting tooling reconcile a rule's totalSpentUsd against the
   * sum of its tagged tx rows. Empty / undefined for non-recurring
   * sources.
   */
  ruleId?: string;
}

// ── Key helpers ──────────────────────────────────────────────────────────────

const subKey             = (addr: string) => `sub:${addr.toLowerCase()}`;
const apiKeyRecKey       = (key: string)  => `apikey:${key}`;
const gasDepKey          = (addr: string) => `gasdep:${addr.toLowerCase()}`;
const linkDepKey         = (addr: string) => `gasdep_link:${addr.toLowerCase()}`;
const linkDepDedupKey    = (addr: string) => `gasdep_link_hashes:${addr.toLowerCase()}`;
const linkUsedKey        = (addr: string) => `link_used:${addr.toLowerCase()}`;
const nativeBridgeUsedKey = (addr: string) => `bridge_native_used:${addr.toLowerCase()}`;
// One-pending-fund-tx-per-(owner, chain). Written before the funding tx
// is broadcast, cleared once the debit has been recorded. Inline retries
// and the reconciliation cron both key off this; see route + cron docs
// for the state machine.
const ccipPendingFundKey = (addr: string, chain: string) =>
  `ccip_pending_fund:${addr.toLowerCase()}:${chain}`;

// Pending clear-delegation debit. Written when the on-chain clear tx
// mines but recording the gas debit fails (e.g. KV blip). The same
// reconciliation cron picks these up + INCRBYFLOATs the owed amount.
// Key includes txHash so multiple pending clears against the same
// (owner, chain) don't collide.
const ccipPendingClearDebitKey = (addr: string, chain: string, txHash: string) =>
  `ccip_pending_clear_debit:${addr.toLowerCase()}:${chain}:${txHash.toLowerCase()}`;
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

// ── Subscription state predicates ────────────────────────────────────────────
//
// The codebase historically used `(sub.amountUSD ?? 0) > 0` as a single
// signal for both "did the wallet pay?" (cash accounting) and "can the
// wallet use Multichain?" (product access). Those are different axes:
//
//   money   — amountUSD / paidAt              (cash accounting)
//   access  — hasMultichainScope()             (product permission)
//   balance — quota:paid:{addr} scoped read    (current credit balance)
//
// Operational grants (admin-grant.mjs, partnership credits, hackathon
// prizes) deliberately leave amountUSD === 0 so the books stay honest,
// but they DO confer Multichain access. Likewise, a paid customer who has
// drained their credits still owns Multichain access — the dashboard
// should show "0 credits, top up needed", not "Locked".
//
// Mixing the two axes silently locked out admin-granted accounts and
// would have locked out paid customers the moment their balance hit 0.
// Always use hasMultichainScope() for permission gates; reserve
// isCashPaidSubscription() for expiry/billing logic that genuinely needs
// to know whether real money changed hands.

/**
 * Returns true if the wallet currently has access to the Multichain paid
 * scope (paid API key slot, paid pool credit reads, 10-chain settlement).
 *
 * Access is conferred by any one of:
 *   - a real cash payment (amountUSD > 0)
 *   - a recorded paidAt timestamp (paid OR grant activation stamps this)
 *   - the paidQuotaBonus mirror existing (set the moment any paid pool
 *     credit is minted — including when subsequent usage drains it to 0)
 *   - an admin-grant txHash sentinel
 *
 * Trial plan and missing apiKey short-circuit to false: a trial-only
 * account or a half-provisioned stub cannot use the Multichain surface
 * regardless of the other signals.
 */
export function hasMultichainScope(sub?: Subscription | null): boolean {
  if (!sub) return false;
  if (sub.plan === TRIAL_PLAN_NAME) return false;
  if (!sub.apiKey) return false;

  // Legacy sponsored shape: scripts/grant-sponsored-credits.mjs (now
  // blocked — see seedFromLegacy for the matching escape hatch) wrote
  // plan: "sponsored" with amountUSD: 0 and paidAt: "" into sub. The
  // sponsored plan + apiKey combination is the unforgable signal that
  // a paid-scope key was minted for that wallet. Keep this branch in
  // lockstep with seedFromLegacy's hasSponsoredLegacyPaidSignal —
  // diverging them would let the dashboard show Locked while reads
  // return credits, the exact conflation hasMultichainScope was
  // introduced to eliminate.
  if (sub.plan === "sponsored") return true;

  return (
    (sub.amountUSD ?? 0) > 0 ||
    !!sub.paidAt ||
    typeof sub.paidQuotaBonus === "number" ||
    (sub.txHash ?? "").startsWith("admin_grant:")
  );
}

/**
 * Returns true only when an actual on-chain cash payment backs the
 * subscription. Used by paid-expiry math (paidAt + 30d window),
 * billing surfaces, and renewal banners — anything that should NOT
 * apply to admin-granted accounts (intentional non-expiring operational
 * grants).
 *
 * For "can this wallet use Multichain?" checks use hasMultichainScope().
 */
export function isCashPaidSubscription(sub?: Subscription | null): boolean {
  return !!sub && (sub.amountUSD ?? 0) > 0 && !!sub.paidAt;
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

export type RotateScope = "paid" | "trial";

/**
 * Rotates the API key in the requested scope and returns the new key.
 *
 *   scope: "paid"  → rotates sub.apiKey using the sub's current plan.
 *   scope: "trial" → rotates sub.trialApiKey using TRIAL_PLAN_NAME so the
 *                    new apikey record gets the trial-scope plan tag,
 *                    regardless of sub.plan (a paid customer's legacy
 *                    trial key still rotates with trial semantics).
 *
 * The trial branch also handles the pre-Phase-1 shape where the trial
 * key lived in the apiKey slot (sub.plan === "trial" + sub.apiKey set +
 * !trialApiKey). In that case the new key is minted into trialApiKey
 * and the apiKey slot is cleared, migrating the record forward.
 *
 * The distributed lock is scoped to (address, scope) so trial + paid
 * rotations can run independently without one blocking the other.
 */
export async function rotateApiKey(
  address: string,
  scope: RotateScope = "paid",
): Promise<string> {
  const sub = await getSubscription(address);
  if (!sub) throw new Error("No subscription found");

  const rotLockKey = `rotation_pending:${scope}:${address.toLowerCase()}`;
  const locked = await kv.set(rotLockKey, "1", { nx: true, ex: 30 });
  if (!locked) throw new Error("Key rotation already in progress. Please wait a moment.");

  try {
    let oldKey: string;
    let newKey: string;

    if (scope === "trial") {
      const hasModernTrialKey = !!sub.trialApiKey;
      // Pre-Phase-1 trial subs wrote the trial key into the apiKey slot
      // and set plan="trial" directly. Treat that as a trial slot for
      // rotation purposes so the dashboard's Trial view button rotates
      // the right key on legacy accounts too.
      const hasLegacyTrialKey =
        sub.plan === TRIAL_PLAN_NAME && !!sub.apiKey && !sub.trialApiKey;
      if (!hasModernTrialKey && !hasLegacyTrialKey) {
        throw new Error("No trial key to rotate");
      }
      oldKey = hasModernTrialKey ? sub.trialApiKey! : sub.apiKey;
      newKey = await generateApiKey(address, TRIAL_PLAN_NAME);
      // Always write the new key into trialApiKey. For legacy shape this
      // also clears the apiKey slot AND migrates the sandbox key.
      // Pre-Phase-1 trial subs put both keys in the paid slots
      // (apiKey + sandboxApiKey were the trial pair); the sandbox half
      // is not rotated — it's just moved to its canonical
      // trialSandboxApiKey slot. Without this move the trial sandbox
      // key keeps occupying the paid-sandbox slot and the next
      // /api/payment/activate would treat it as the paid sandbox key
      // (since that activation reuses `existing.sandboxApiKey` when
      // present), mixing trial and paid scopes.
      const nextSub: Subscription = { ...sub, trialApiKey: newKey };
      if (hasLegacyTrialKey) {
        nextSub.apiKey = "";
        if (sub.sandboxApiKey) {
          nextSub.trialSandboxApiKey = sub.sandboxApiKey;
          nextSub.sandboxApiKey = undefined;
        }
      }
      await setSubscription(address, nextSub);
    } else {
      oldKey = sub.apiKey;
      if (!oldKey) throw new Error("No paid key to rotate");
      newKey = await generateApiKey(address, sub.plan);
      await setSubscription(address, { ...sub, apiKey: newKey });
    }

    // Best-effort deactivation of the old key. Non-fatal: a dangling
    // active old key is preferable to a user locked out.
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
  try {
    return (await kv.get<GasDeposit[]>(gasDepKey(address))) ?? [];
  } catch {
    // Third-type clobber — see getRelayedTxs for the matching defensive fallback.
    return [];
  }
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
  const [deposits, usedTotals, nativeBridgeUsedTotals] = await Promise.all([
    getGasDeposits(address),
    getBillableGasUsedTotals(address),
    // CCIP native-fee bridges debit a distinct counter
    // (bridge_native_used:{addr}.{chain}) so the Gas Tank UI can
    // attribute relay vs bridge spend separately. Both must be
    // subtracted here — without this, native-fee bridges would land
    // on-chain, write the bridge counter, but the dashboard /
    // /api/relay gas-tank check would never see the debit. The fix
    // for FIX 3 (native fee debit) only completed half the loop;
    // this closes the read side.
    getNativeBridgeUsedTotals(address),
  ]);
  const totals: Record<string, number> = { bnb: 0, eth: 0, mantle: 0, injective: 0, avax: 0, xlayer: 0, stable: 0, monad: 0, scroll: 0, arbitrum: 0 };
  for (const d of deposits) totals[d.chain] = (totals[d.chain] ?? 0) + d.amount;
  for (const chain of Object.keys(usedTotals)) {
    totals[chain] = (totals[chain] ?? 0) - usedTotals[chain];
  }
  for (const chain of Object.keys(nativeBridgeUsedTotals)) {
    totals[chain] = (totals[chain] ?? 0) - nativeBridgeUsedTotals[chain];
  }
  // Detect pre-clamp negative drift before we hide it from the user UI.
  // A negative pre-clamp value means a settlement debited gas against a
  // deposit we never recorded in KV — that's a real ledger divergence and
  // ops needs to see it, even though the user UI shows 0 (since they have
  // no claim on the deficit). Throttled to one fan-out per drifting chain
  // per 1h so a continuous read-storm doesn't spam the operator channel.
  const drifting: Array<{ chain: string; balance: number; deposited: number; used: number }> = [];
  for (const chain of Object.keys(totals)) {
    if (totals[chain] < 0) {
      const depositedOnChain = deposits.filter(d => d.chain === chain).reduce((a, d) => a + d.amount, 0);
      // `used` must aggregate BOTH the relay-gas counter (usedTotals) and
      // the CCIP native-fee bridge counter (nativeBridgeUsedTotals);
      // otherwise the ops alert understates the actual on-chain spend on
      // CCIP chains and the deficit number looks smaller than it really is.
      const usedOnChain =
        (usedTotals[chain] ?? 0) + (nativeBridgeUsedTotals[chain] ?? 0);
      drifting.push({ chain, balance: totals[chain], deposited: depositedOnChain, used: usedOnChain });
      totals[chain] = 0;
    }
  }
  if (drifting.length > 0) {
    // Fire-and-forget — alerts must never block balance reads.
    void emitGasDriftAlert(address, drifting);
  }
  return totals;
}

async function emitGasDriftAlert(
  address: string,
  drifting: Array<{ chain: string; balance: number; deposited: number; used: number }>,
): Promise<void> {
  try {
    const lines = [
      `<b>Gas-balance negative drift</b>`,
      `Address: <code>${address}</code>`,
      "",
      ...drifting.map(
        d => `• <b>${d.chain}</b>: balance=${d.balance.toFixed(8)}  deposited=${d.deposited.toFixed(8)}  used=${d.used.toFixed(8)}`,
      ),
      "",
      `User UI clamps to 0; this alert is the only signal of ledger divergence.`,
    ].join("\n");
    // Dedup key per (address, chain set) so we don't spam on every dashboard
    // poll. 1h TTL — drift is a slow problem; one alert per hour is enough.
    const dedupKey = `gas_drift_alert:${address}:${drifting.map(d => d.chain).sort().join(",")}`;
    const fresh = await kv.set(dedupKey, "1", { nx: true, ex: 3600 });
    if (!fresh) return;
    await sendOpsAlert(lines, "warn");
  } catch {
    /* never throw out of a balance read */
  }
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
  limitPerMonth: number = 1_000,
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
      try {
        const arr = (await kv.get<RelayedTx[]>(key)) ?? [];
        return Number.isFinite(limitPerMonth) ? arr.slice(-Math.max(1, Math.floor(limitPerMonth))) : arr;
      } catch {
        // WRONGTYPE on get too — the key has been clobbered to a third type
        // (hash / set / zset) that fits neither the modern LIST format nor
        // the legacy JSON-array-as-string format. Treat as empty so the
        // monthly fetch degrades gracefully instead of taking down every
        // relay call that needs gas-balance accounting.
        return [] as RelayedTx[];
      }
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
  try {
    const txs = await kv.get<RelayedTx[]>(key);
    return txs?.length ?? 0;
  } catch {
    // Third-type clobber — see getRelayedTxs for the matching defensive fallback.
    return 0;
  }
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
 * The history-sum was originally a permanent re-sum to repair that drift —
 * but for power users (viz-backend's heavy hub had 33k+ TX/month on
 * 2026-06-02) the unbounded `lrange(0, -1)` exploded into multi-MB reads on
 * every `getGasBalance` call (which is called per relay). Upstash 10MB
 * request alerts caught it. The cap below keeps reconciliation usable for
 * normal users while bounding the request size for heavy ones — beyond the
 * cap we trust the atomic hash cache (which has been correct since the
 * sandbox-gas-leak bug was fixed long ago).
 */
const GAS_RECONCILE_LIMIT_PER_MONTH = 1_000;
async function getBillableGasUsedTotals(address: string): Promise<Record<string, number>> {
  const txs = await getRelayedTxs(address, recentMonths(12), GAS_RECONCILE_LIMIT_PER_MONTH);
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
  try {
    return (await kv.get<Record<string, number>>(gasUsedKey(address))) ?? {};
  } catch {
    // Third-type clobber — see getRelayedTxs for the matching defensive fallback.
    return {};
  }
}

/**
 * Appends a TX record atomically using RPUSH (no read-modify-write race).
 * Gas totals updated atomically via HINCRBYFLOAT.
 * Legacy JSON array/object keys are handled via try/catch fallback.
 */
export async function recordRelayedTx(address: string, tx: RelayedTx) {
  const month = ym(new Date(tx.relayedAt));
  const key   = relayTxMonthKey(address, month);

  // Per-month list cap — bounded so any lrange(0, -1) on this key stays
  // well under Upstash's 10 MB request limit even for the heaviest user.
  // Previous cap (TIER_CREDITS[-1] = 500_000) allowed a single key to
  // reach ~250 MB which broke `getBillableGasUsedTotals` for power users
  // on 2026-06-02. The dashboard /api/transactions surface only ever
  // renders the most recent few hundred per month anyway, and billing
  // uses the independent atomic credit counter, so the new cap is a
  // pure display-history bound.
  const MAX_TX_HISTORY = 5_000;
  try {
    const len = await kv.rpush(key, tx);
    if (len > MAX_TX_HISTORY) kv.ltrim(key, -MAX_TX_HISTORY, -1).catch(() => {});
  } catch {
    // Legacy fallback for existing JSON array keys
    try {
      const existing = (await kv.get<RelayedTx[]>(key)) ?? [];
      if (existing.length < MAX_TX_HISTORY) await kv.set(key, [...existing, tx]);
    } catch {
      // Third-type clobber on the key — neither LIST nor JSON-array-string.
      // Dropping the record is the safest outcome; the on-chain TX is the
      // source of truth and the receipt was already created upstream.
    }
  }

  if (tx.gasCostNative > 0) {
    try {
      // HINCRBYFLOAT is atomic — no read-modify-write race on gas totals
      await kv.hincrbyfloat(gasUsedKey(address), tx.chain, tx.gasCostNative);
    } catch {
      // Legacy fallback for existing JSON object keys
      try {
        const totals = (await kv.get<Record<string, number>>(gasUsedKey(address))) ?? {};
        totals[tx.chain] = (totals[tx.chain] ?? 0) + tx.gasCostNative;
        await kv.set(gasUsedKey(address), totals);
      } catch {
        // Third-type clobber on gasUsedKey — neither HASH nor JSON-object-string.
        // Drop the increment; getBillableGasUsedTotals recomputes from relay
        // history anyway, so the dashboard total still reconciles.
      }
    }
  }
}

// ── Public stats counters (materialized, real-time) ──────────────────────────
// Per /api/stats/public — instead of SCAN-ing a source namespace on every
// render (the old design that helped trigger the 2026-05-27 relaytx eviction),
// every successful live relay does six small atomic writes here. Reads are
// then five O(1) Redis ops. KV stays cheap regardless of namespace size, and
// these keys are accessed often enough to sit in the LRU hot tier so a future
// memory squeeze targets cold history (receipt:*, with its 1-year TTL safety
// net) before it can touch counters.
const STATS_COUNTER_SETTLEMENTS = "stats:counter:settlements";
const STATS_COUNTER_VOLUME_USD  = "stats:counter:volumeUsd";
const STATS_SET_PAYERS          = "stats:set:payers";
const STATS_SET_RECIPIENTS      = "stats:set:recipients";
const STATS_HASH_PER_CHAIN      = "stats:hash:perChain";

/**
 * Increment all public-stats counters for a single successful relay.
 * Called from /api/relay's after() so the response is never delayed by
 * stats accounting; each Redis op is atomic, so concurrent relays
 * cannot corrupt the counts.
 *
 * Sandbox calls MUST be filtered upstream — these counters are the public
 * panel's "real settlements" view.
 */
export async function incrStatsCounters(opts: {
  payer:      string;
  recipient:  string;
  chain:      string;
  amountUsd:  number;
}): Promise<void> {
  const usd = Number.isFinite(opts.amountUsd) && opts.amountUsd > 0 ? opts.amountUsd : 0;
  const payer     = opts.payer.toLowerCase();
  const recipient = opts.recipient.toLowerCase();
  const chain     = opts.chain && opts.chain.length > 0 ? opts.chain : "unknown";
  await Promise.all([
    kv.incr(STATS_COUNTER_SETTLEMENTS),
    kv.incrbyfloat(STATS_COUNTER_VOLUME_USD, usd),
    kv.sadd(STATS_SET_PAYERS, payer),
    kv.sadd(STATS_SET_RECIPIENTS, recipient),
    kv.hincrby(STATS_HASH_PER_CHAIN, `${chain}:settlements`, 1),
    kv.hincrbyfloat(STATS_HASH_PER_CHAIN, `${chain}:volumeUsd`, usd),
  ]);
}

export interface StatsCounters {
  totalSettlements: number;
  totalVolumeUsd:   number;
  uniquePayers:     number;
  uniqueRecipients: number;
  perChain:         Record<string, { settlements: number; volumeUsd: number }>;
}

/**
 * Read every public-stats counter in one fan-out. Five O(1) KV ops, no SCAN.
 * Missing/empty keys degrade to zero so a fresh deployment doesn't 500 the
 * public panel before the first backfill or relay has had a chance to write.
 */
export async function getStatsCounters(): Promise<StatsCounters> {
  const [settlements, volume, payersCount, recipientsCount, hash] = await Promise.all([
    kv.get<number>(STATS_COUNTER_SETTLEMENTS),
    kv.get<string | number>(STATS_COUNTER_VOLUME_USD),
    kv.scard(STATS_SET_PAYERS),
    kv.scard(STATS_SET_RECIPIENTS),
    kv.hgetall<Record<string, string | number>>(STATS_HASH_PER_CHAIN),
  ]);

  const perChain: Record<string, { settlements: number; volumeUsd: number }> = {};
  if (hash) {
    for (const [k, v] of Object.entries(hash)) {
      const sep = k.indexOf(":");
      if (sep < 0) continue;
      const chain = k.slice(0, sep);
      const field = k.slice(sep + 1);
      if (!chain || (field !== "settlements" && field !== "volumeUsd")) continue;
      const bucket = perChain[chain] ?? { settlements: 0, volumeUsd: 0 };
      const num = typeof v === "string" ? Number(v) : v;
      if (!Number.isFinite(num)) continue;
      if (field === "settlements") bucket.settlements = num;
      else                          bucket.volumeUsd   = Math.round(num * 100) / 100;
      perChain[chain] = bucket;
    }
  }

  const vNum = typeof volume === "string" ? Number(volume) : volume;
  const settlementsNum = typeof settlements === "number" ? settlements : Number(settlements);
  return {
    totalSettlements: Number.isFinite(settlementsNum) && settlementsNum > 0 ? settlementsNum : 0,
    totalVolumeUsd:   Number.isFinite(vNum) ? Math.round((vNum as number) * 100) / 100 : 0,
    uniquePayers:     payersCount ?? 0,
    uniqueRecipients: recipientsCount ?? 0,
    perChain,
  };
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

// ── Atomic TX credit counters — two-pool model ───────────────────────────────
// Trial and paid credits live in separate KV keys so the dashboard can render
// each pool independently and a paid activation never silently drains the
// remaining trial allotment.
//
//   quota:trial:{addr}  — trial credits remaining (BNB-only, relayer-sponsored)
//   quota:paid:{addr}   — paid credits remaining  (10 chains, user-funded gas tank)
//
// The relay route picks the pool based on `keyRecord.plan === "trial"` — an
// immutable per-key signal set at generation time. Trial relay decrements
// trial pool only; paid relay decrements paid pool only.
//
// LEGACY: the pre-migration single-pool `quota:{addr}` key is read by the
// safety-net `seedFromLegacy()` for accounts the eager reconciliation script
// missed. On a clean reconciliation that path should never trigger — if it
// does, an ops alert fires so the operator can re-run the script. After +2
// weeks of clean traffic, `scripts/cleanup-legacy-quota.mjs` deletes the
// legacy keys for accounts whose scoped pools are populated.

export type CreditScope = "trial" | "paid";
const scopedQuotaKey = (addr: string, scope: CreditScope) =>
  `quota:${scope}:${addr.toLowerCase()}`;
const legacyQuotaKey = (addr: string) => `quota:${addr.toLowerCase()}`;

/**
 * Decide which pool unmigrated legacy quota belongs to for `addr` / `scope`.
 * Used by `getScopedCredits` (read fallback) and the seed-first guard in
 * `decrementScopedCredit` / `addScopedCredits`.
 *
 * Two paths:
 *   1. Scoped key already exists for `scope` → short-circuit, return 0
 *      silently. Post-reconciliation this is the normal case; the legacy
 *      `quota:{addr}` is intentionally preserved until the +2w cleanup phase
 *      and shouldn't trigger an alert on every mutation.
 *   2. Scoped key missing AND legacy non-zero → real fallback. THIS path
 *      fires `sendOpsAlert` because on a clean reconciliation it should be
 *      unreachable, so any hit is a signal that reconcile-credit-pools.mjs
 *      missed an account.
 *
 * Returns the legacy value when scope matches the account's signal, 0 otherwise.
 * Hybrid (both trial and paid signals) biases the legacy value to the paid
 * scope so the account stays functional; the alert prompts the operator to
 * do an honest TX-history split via the reconciliation script.
 */
export async function seedFromLegacy(
  address: string,
  scope: CreditScope,
): Promise<number> {
  // Short-circuit when the scoped pool already exists. Mutation paths
  // (`decrementScopedCredit` / `addScopedCredits`) call this defensively on
  // every mutation, but if the scoped key is already populated the seed value
  // gets discarded by the SET NX in `initScopedQuotaIfNeeded` — so there's
  // nothing to seed and nothing worth alerting about. Without this guard, the
  // safety-net alert fires on every post-reconciliation relay (the legacy
  // `quota:{addr}` is intentionally preserved until the +2w cleanup phase).
  const scopedVal = await kv.get<number>(scopedQuotaKey(address, scope));
  if (scopedVal !== null) return 0;

  const legacyVal = await kv.get<number>(legacyQuotaKey(address));
  if (legacyVal === null || legacyVal <= 0) {
    // ── Subscription mirror fallback (last resort) ─────────────────────────
    // Mirrors the read-side fallback in `getScopedCredits` so mutation seed
    // matches what reads return. Without this, an orphan-shape account
    // (no scoped key, no legacy key, mirror still populated — possible
    // post-cleanup or KV eviction) would render correctly on the dashboard
    // but the first relay/topup would see scoped=0 and 429 "no credits".
    // Mirror values are last-known-good display state; trusting them as a
    // seed costs at most one over-grant bounded by the mirror value, which
    // is preferable to silently dropping the user's credits.
    const sub = await getSubscription(address);
    if (scope === "trial") return Math.max(0, sub?.trialQuotaBonus ?? 0);
    return Math.max(0, sub?.paidQuotaBonus ?? sub?.quotaBonus ?? 0);
  }

  // Real fallback path. On a clean reconciliation this should be unreachable;
  // getting here means an account slipped through. Best-effort alert — don't
  // block the request if alerting fails.
  sendOpsAlert(
    `<b>Unmigrated legacy credit pool detected</b>\n` +
    `Address: <code>${address}</code>\n` +
    `Scope: ${scope}\n` +
    `Legacy <code>quota:{addr}</code> value: ${legacyVal}\n\n` +
    `Run <code>scripts/reconcile-credit-pools.mjs --address=${address} --execute</code> to fix.`,
    "error",
  ).catch(() => {});

  const sub = await getSubscription(address);
  const now = new Date();
  // Modern trial signal: explicit trialApiKey slot + a future expiry.
  // Post-Phase-1 accounts created by trial/activate / auth/google /
  // auth/email/callback all carry this shape.
  const hasModernTrialSignal = !!sub?.trialApiKey
    && !!sub?.trialExpiresAt
    && new Date(sub.trialExpiresAt) > now;
  // Legacy trial signal: pre-Phase-1 trial activations wrote the trial key
  // into the `apiKey` slot and set plan="trial" directly (the trialApiKey
  // field didn't exist yet). Mirrors the same fallback used in
  // provision/route.ts (`hasLegacyTrialKey`) and payment/activate/route.ts.
  // Without it, a pre-migration account that somehow misses reconciliation
  // and falls through to this safety net gets classified as orphan even
  // though plan="trial" + amountUSD=0 is an unambiguous trial signal.
  const hasLegacyTrialSignal = sub?.plan === "trial"
    && (sub?.amountUSD ?? 0) === 0
    && !!sub?.apiKey
    && !sub?.trialApiKey;
  const hasTrialSignal = hasModernTrialSignal || hasLegacyTrialSignal;

  // Cash-paid signal: real on-chain payment recorded. The exclusion of
  // plan === "trial" prevents a paid customer who then activated a trial
  // (legacy sequence pre-Phase-1) from being misclassified.
  const hasCashPaidSignal = (sub?.amountUSD ?? 0) > 0
    && !!sub?.paidAt
    && sub?.plan !== "trial";

  // Legacy sponsored signal: scripts/grant-sponsored-credits.mjs (now
  // blocked at the top — see admin-grant.mjs for the canonical path)
  // wrote `plan: "sponsored"` with amountUSD: 0 and paidAt: "" into
  // sub records, leaving the 50k credits in the legacy `quota:{addr}`
  // pool. Without this branch, those accounts get classified as orphan
  // by seedFromLegacy and their first relay decrement fails: dashboard
  // shows the mirror balance but the scoped pool seeds to 0 and the
  // relay route returns 429. plan === "sponsored" is a strict
  // narrow-purpose marker — do NOT generalize this branch unless you
  // are intentionally re-enabling sponsored grants.
  const hasSponsoredLegacyPaidSignal = sub?.plan === "sponsored" && !!sub?.apiKey;

  const hasPaidSignal = hasCashPaidSignal || hasSponsoredLegacyPaidSignal;

  // Single-scope accounts: legacy belongs unambiguously to the active scope.
  if (hasTrialSignal && !hasPaidSignal) return scope === "trial" ? legacyVal : 0;
  if (!hasTrialSignal && hasPaidSignal) return scope === "paid"  ? legacyVal : 0;
  // Hybrid: bias to paid to keep the account functional. The reconciliation
  // script does an honest TX-history-based split as a follow-up. Trial pool
  // starts at 0 until that runs.
  if (hasTrialSignal && hasPaidSignal)  return scope === "paid"  ? legacyVal : 0;
  // Orphan — neither signal. Don't auto-seed.
  return 0;
}

/**
 * Returns current remaining credits in `scope` for `address`.
 *   1. Scoped key (post-migration source of truth).
 *   2. Legacy fallback via seedFromLegacy (fires ops alert).
 *   3. Subscription mirror (very-old accounts whose legacy key was evicted).
 *
 * The fallback chain never re-writes anything — reads must be idempotent.
 * First mutation (via addScopedCredits / decrementScopedCredit) is what
 * actually seeds the scoped key.
 */
export async function getScopedCredits(
  address: string,
  scope: CreditScope,
): Promise<number> {
  const scopedVal = await kv.get<number>(scopedQuotaKey(address, scope));
  if (scopedVal !== null) return Math.max(0, scopedVal);
  const legacySeed = await seedFromLegacy(address, scope);
  if (legacySeed > 0) return legacySeed;
  // Last-resort: subscription mirror (legacy key evicted, scoped not yet seeded)
  const sub = await getSubscription(address);
  if (scope === "trial") return Math.max(0, sub?.trialQuotaBonus ?? 0);
  return Math.max(0, sub?.paidQuotaBonus ?? sub?.quotaBonus ?? 0);
}

/**
 * SET NX on quota:{scope}:{addr}. Safe to call on every mutation — no-op after
 * the first. The seed value typically comes from `seedFromLegacy`; on clean
 * reconciliations the scoped key already exists so this is a no-op.
 */
export async function initScopedQuotaIfNeeded(
  address: string,
  scope: CreditScope,
  initialAmount: number,
): Promise<void> {
  await kv.set(scopedQuotaKey(address, scope), Math.max(0, initialAmount), { nx: true });
}

/**
 * Atomic DECRBY in `scope`. Returns { ok, remaining }. Embeds a seed-first
 * call so any unmigrated legacy quota is captured before the decrement.
 */
export async function decrementScopedCredit(
  address: string,
  scope: CreditScope,
): Promise<{ ok: boolean; remaining: number }> {
  // Seed-first: ensure scoped key reflects any unmigrated legacy state BEFORE
  // we decrement. Without this, a paid-only legacy user's first decrement
  // would start at 0 and incorrectly 429 them.
  await initScopedQuotaIfNeeded(address, scope, await seedFromLegacy(address, scope));
  const key = scopedQuotaKey(address, scope);
  const newVal = await kv.decrby(key, 1);
  if (newVal < 0) {
    await kv.incrby(key, 1);
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: newVal };
}

/**
 * Atomic INCRBY in `scope` — restore a credit on relay failure.
 * Use the SAME `scope` that was passed to `decrementScopedCredit` so the
 * refund lands in the pool the credit was originally taken from.
 */
export async function refundScopedCredit(
  address: string,
  scope: CreditScope,
): Promise<void> {
  await kv.incrby(scopedQuotaKey(address, scope), 1);
}

/**
 * Atomic INCRBY in `scope`. Used by activation routes and admin topup.
 * Embeds seed-first so a paid-only legacy account's top-up doesn't discard
 * the legacy balance.
 */
export async function addScopedCredits(
  address: string,
  scope: CreditScope,
  amount: number,
): Promise<number> {
  if (amount <= 0) return getScopedCredits(address, scope);
  await initScopedQuotaIfNeeded(address, scope, await seedFromLegacy(address, scope));
  return kv.incrby(scopedQuotaKey(address, scope), amount);
}

// ── Legacy wrappers (kept during the rollout window) ─────────────────────────
// Callers that haven't migrated yet land here. The wrappers route to the
// paid pool — the historical default for `addCredits` was paid grants, and
// the only trial caller (trial/activate) is migrated to `addScopedCredits`
// explicitly. Trial-side legacy callers (email-callback, auth/google) are
// likewise migrated. If any pre-migration caller remains and lands here, the
// paid-pool default is the safer choice than dropping credits.

/**
 * @deprecated Returns the SUM of trial + paid pools for backwards compat.
 * Prefer `getScopedCredits(addr, scope)`.
 */
export async function getQuotaCredits(address: string): Promise<number> {
  const [trial, paid] = await Promise.all([
    getScopedCredits(address, "trial"),
    getScopedCredits(address, "paid"),
  ]);
  return trial + paid;
}

/** @deprecated Use `initScopedQuotaIfNeeded(addr, scope, …)` */
export async function initQuotaIfNeeded(address: string, initialAmount: number): Promise<void> {
  return initScopedQuotaIfNeeded(address, "paid", initialAmount);
}

/** @deprecated Use `decrementScopedCredit(addr, scope)` */
export async function decrementCredit(
  address: string,
): Promise<{ ok: boolean; remaining: number }> {
  return decrementScopedCredit(address, "paid");
}

/** @deprecated Use `refundScopedCredit(addr, scope)` */
export async function refundCredit(address: string): Promise<void> {
  return refundScopedCredit(address, "paid");
}

/** @deprecated Use `addScopedCredits(addr, scope, amount)` */
export async function addCredits(address: string, amount: number): Promise<number> {
  return addScopedCredits(address, "paid", amount);
}

/**
 * Admin topup. Always targets the PAID pool — trial credit topups would
 * silently bypass `trialExpiresAt` and the BNB-only relay gate, so we make
 * the scope explicit.
 */
export async function addQuotaBonus(address: string, additionalTxs: number) {
  const sub = await getSubscription(address);
  if (!sub) throw new Error("No subscription found");
  const newPaid = await addScopedCredits(address, "paid", additionalTxs);
  await setSubscription(address, {
    ...sub,
    paidQuotaBonus: newPaid,
    // Keep the legacy sum mirror so any reader stuck on `quotaBonus` still
    // sees the right total.
    quotaBonus: (sub.trialQuotaBonus ?? 0) + newPaid,
  });
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

// ── LINK Gas Tank (CCIP bridge fees) ────────────────────────────────────────
// Parallel to the native GasDeposit flow above. Scoped to the 3 CCIP chains
// (eth/avax/arbitrum); other chains are rejected at the API layer. Same
// deposit-list + dedup-set + used-counter pattern; same drift-detection on
// pre-clamp negative balance.
//
// KV keys (per address):
//   gasdep_link:{addr}        → LinkDeposit[]    (RPUSH list, oldest→newest)
//   gasdep_link_hashes:{addr} → SET of txHash    (dedup)
//   link_used:{addr}          → Record<chain, number>  (sum of consumed LINK)

const CCIP_LINK_CHAINS = ["eth", "avax", "arbitrum"] as const;
type CCIPLinkChain = typeof CCIP_LINK_CHAINS[number];

function isCCIPLinkChain(s: string): s is CCIPLinkChain {
  return s === "eth" || s === "avax" || s === "arbitrum";
}

export async function getLinkDeposits(address: string): Promise<LinkDeposit[]> {
  try {
    const list = await kv.lrange<LinkDeposit>(linkDepKey(address), 0, -1);
    if (Array.isArray(list)) return list;
  } catch { /* legacy fallback */ }
  return (await kv.get<LinkDeposit[]>(linkDepKey(address))) ?? [];
}

/**
 * Add a LINK deposit. Mirrors addGasDeposit: dedup via SET, fallback to
 * list scan if SADD reports already-present, defence-in-depth duplicate
 * check before RPUSH. Rejects chains not in {eth, avax, arbitrum}.
 */
export async function addLinkDeposit(address: string, deposit: LinkDeposit): Promise<boolean> {
  if (!isCCIPLinkChain(deposit.chain)) {
    // Strict — LINK is meaningless on chains without a CCIP USDC pool. A
    // misrouted deposit here would be unrecoverable spend (user thinks
    // they have bridge credit, server has no path to consume it).
    return false;
  }
  if (deposit.txHash) {
    try {
      const added = await kv.sadd(linkDepDedupKey(address), deposit.txHash);
      if (added === 0) {
        const existing = await getLinkDeposits(address);
        if (existing.some(d => d.txHash === deposit.txHash)) return false;
        await kv.rpush(linkDepKey(address), deposit);
        return true;
      }
      const existing = await getLinkDeposits(address);
      if (existing.some(d => d.txHash === deposit.txHash)) return false;
      await kv.rpush(linkDepKey(address), deposit);
      return true;
    } catch { /* fall through */ }
  }
  const existing = await getLinkDeposits(address);
  if (existing.some(d => d.txHash === deposit.txHash)) return false;
  await kv.set(linkDepKey(address), [...existing, deposit]);
  return true;
}

/**
 * Per-chain consumed-LINK totals (sum of fees paid via bridge route).
 *
 * Schema migration v2 (2026-06-05): switched from a single hash blob
 * (`link_used:{addr}` → `Record<chain, number>`) to per-chain scalar
 * counters (`link_used:{addr}.{chain}` → number) so writes can use
 * Redis INCRBYFLOAT atomically instead of a lossy read-modify-write.
 * Legacy blob is read once and folded into the new scalars on first
 * access; subsequent reads ignore it.
 */
export async function getLinkUsedTotals(address: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const perChain = await Promise.all(
    CCIP_LINK_CHAINS.map(async (c) => {
      const raw = await kv.get<number | string>(`${linkUsedKey(address)}.${c}`);
      const n = typeof raw === "string" ? parseFloat(raw) : (raw ?? 0);
      return { c, n: Number.isFinite(n) ? n : 0 };
    }),
  );
  for (const { c, n } of perChain) out[c] = n;
  // Legacy blob — fold into the per-chain view so historic usage doesn't
  // suddenly disappear after the migration.
  const legacy = (await kv.get<Record<string, number>>(linkUsedKey(address))) ?? {};
  for (const c of CCIP_LINK_CHAINS) {
    if (typeof legacy[c] === "number" && legacy[c] > 0) {
      out[c] = (out[c] ?? 0) + legacy[c];
    }
  }
  return out;
}

/**
 * Atomically increment the consumed-LINK counter for one chain.
 *
 * Uses Redis INCRBYFLOAT against a per-chain scalar key so concurrent
 * bridges from the same owner cannot lose increments to a read-modify-
 * write race. (Previously two parallel bridges could both read 0,
 * each add their fee, and the second write would clobber the first.)
 */
export async function recordLinkUsage(address: string, chain: string, amount: number): Promise<void> {
  if (!isCCIPLinkChain(chain) || amount <= 0) return;
  try {
    // Upstash client exposes incrbyfloat — atomic on the Redis side.
    await (kv as unknown as { incrbyfloat: (k: string, v: number) => Promise<number> }).incrbyfloat(
      `${linkUsedKey(address)}.${chain}`,
      amount,
    );
  } catch {
    // Fallback for SDK shapes that don't expose incrbyfloat (e.g.
    // local-mock KV in tests) — non-atomic but functional. The fallback
    // is a deliberate degradation, not a silent skip.
    const key = `${linkUsedKey(address)}.${chain}`;
    const cur = (await kv.get<number>(key)) ?? 0;
    await kv.set(key, cur + amount);
  }
}

/**
 * Per-chain native-fee consumption from CCIP bridges. Mirrors
 * `recordLinkUsage` but for the native-fee path. Kept under a distinct
 * KV bucket (`bridge_native_used:{addr}.{chain}`) so the Gas Tank UI
 * can attribute bridge spend vs relay spend separately.
 *
 * Atomic via INCRBYFLOAT for the same reason as LINK. Falls back to
 * RMW on KV clients that don't expose the primitive.
 */
export async function recordNativeBridgeUsage(address: string, chain: string, amount: number): Promise<void> {
  if (!isCCIPLinkChain(chain) || amount <= 0) return;
  try {
    await (kv as unknown as { incrbyfloat: (k: string, v: number) => Promise<number> }).incrbyfloat(
      `${nativeBridgeUsedKey(address)}.${chain}`,
      amount,
    );
  } catch {
    const key = `${nativeBridgeUsedKey(address)}.${chain}`;
    const cur = (await kv.get<number>(key)) ?? 0;
    await kv.set(key, cur + amount);
  }
}

/**
 * Pending CCIP auto-fund record. Written before the funding tx is
 * broadcast, cleared once the debit lands in `bridge_native_used`. The
 * route's auto-fund block checks this on every entry so a fund tx whose
 * wait() timed out on a previous attempt can be reconciled cleanly on
 * the user's next bridge — without leaking relayer ETH or double-billing.
 *
 * State machine:
 *   nil           — no pending fund
 *   {pending}     — fund tx broadcast, no receipt yet OR receipt absent
 *                   (just-mined-not-propagated)
 *   {debited}     — receipt success, debit recorded, ready for delete
 *                   (we delete in the same call rather than keeping
 *                    "debited" rows around — present here only to make
 *                    the transition explicit for callers)
 *
 * TTL: 1h. Beyond that the reconciliation cron fires an ops alert and
 * deletes the row so an orphaned record can't stall the chain forever.
 */
export interface PendingFundRecord {
  txHash:        string;
  fundDeltaWei:  string;
  submittedAt:   number;
  intentFp:      string;
  ownerLc:       string;
  chain:         string;
}

export async function getPendingFund(address: string, chain: string): Promise<PendingFundRecord | null> {
  if (!isCCIPLinkChain(chain)) return null;
  try {
    return (await kv.get<PendingFundRecord>(ccipPendingFundKey(address, chain))) ?? null;
  } catch {
    return null;
  }
}

export async function setPendingFund(rec: PendingFundRecord): Promise<void> {
  if (!isCCIPLinkChain(rec.chain)) return;
  // 1h TTL so a record never survives indefinitely if every retry path
  // bypasses reconciliation for some reason.
  await kv.set(ccipPendingFundKey(rec.ownerLc, rec.chain), rec, { ex: 3600 });
}

export async function clearPendingFund(address: string, chain: string): Promise<void> {
  if (!isCCIPLinkChain(chain)) return;
  try {
    await kv.del(ccipPendingFundKey(address, chain));
  } catch { /* del is best-effort — TTL will sweep */ }
}

/**
 * Per-(owner, chain) CAS lock for the pending-fund reconcile path.
 *
 * Two writers can reach the same pending-fund record concurrently:
 *   (a) the inline reconcile block at the top of /api/ccip/send's
 *       auto-fund path — fires on every retry attempt by the same user
 *   (b) the /api/cron/ccip-pending-fund-reconcile cron — fires every ~5
 *       minutes on the Render heartbeat
 *
 * Without coordination both can fetch the same receipt, both compute
 * `gasUsed × effectiveGasPrice`, both call `recordNativeBridgeUsage`,
 * and both call `clearPendingFund`. The KV INCRBYFLOAT is atomic per
 * call but DOES double-debit the user's bridge_native_used bucket.
 *
 * SETNX with 30s TTL is enough: the read+receipt-fetch+INCRBYFLOAT+del
 * sequence completes in well under 30s on a healthy RPC, and a stuck
 * lock self-clears on the next tick. Returns true if this caller won
 * the race and should proceed; false means another writer is already
 * reconciling and this caller should skip.
 */
export async function acquirePendingFundReconcileLock(
  address: string,
  chain: string,
): Promise<boolean> {
  if (!isCCIPLinkChain(chain)) return true; // no-op chains don't race
  try {
    const claimed = await kv.set(
      `ccip_pending_fund_reconcile_lock:${address.toLowerCase()}:${chain}`,
      "1",
      { nx: true, ex: 30 },
    );
    return claimed === "OK";
  } catch {
    // KV unavailable — fall through to no-lock behaviour rather than
    // wedge the route. Reconcile cron will catch any stragglers.
    return true;
  }
}

export async function releasePendingFundReconcileLock(
  address: string,
  chain: string,
): Promise<void> {
  if (!isCCIPLinkChain(chain)) return;
  try {
    await kv.del(`ccip_pending_fund_reconcile_lock:${address.toLowerCase()}:${chain}`);
  } catch { /* TTL will sweep */ }
}

/**
 * Pending clear-delegation debit record. Written by /api/wallet/agentic/
 * clear-delegation when the on-chain clear succeeded but the gas-debit
 * write to `bridge_native_used` threw. Reconciled by the same cron as
 * pending funds, on a separate scan pass.
 */
export interface PendingClearDebitRecord {
  txHash:        string;
  estimatedEth:  number;  // pre-tx estimate, ceiling
  ownerLc:       string;
  chain:         string;
  submittedAt:   number;
}

export async function setPendingClearDebit(rec: PendingClearDebitRecord): Promise<void> {
  if (!isCCIPLinkChain(rec.chain)) return;
  await kv.set(
    ccipPendingClearDebitKey(rec.ownerLc, rec.chain, rec.txHash),
    rec,
    { ex: 3600 },
  );
}

export async function clearPendingClearDebit(
  addr: string,
  chain: string,
  txHash: string,
): Promise<void> {
  if (!isCCIPLinkChain(chain)) return;
  try {
    await kv.del(ccipPendingClearDebitKey(addr, chain, txHash));
  } catch { /* TTL will sweep */ }
}

export async function listPendingClearDebitKeys(maxItems = 500): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | number = 0;
  let iters = 0;
  do {
    const [next, batch]: [string | number, string[]] = await kv.scan(cursor, {
      match: "ccip_pending_clear_debit:*",
      count: 200,
    });
    cursor = next;
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= maxItems) return keys;
    }
    iters++;
    if (iters > 200) break;
  } while (String(cursor) !== "0");
  return keys;
}

/**
 * Scan the entire KV namespace for pending fund records — used by the
 * reconciliation cron. Caller iterates each, fetches the receipt, and
 * debits/deletes as appropriate.
 */
export async function listPendingFundKeys(maxItems = 500): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | number = 0;
  let iters = 0;
  do {
    const [next, batch]: [string | number, string[]] = await kv.scan(cursor, {
      match: "ccip_pending_fund:*",
      count: 200,
    });
    cursor = next;
    for (const k of batch) {
      keys.push(k);
      if (keys.length >= maxItems) return keys;
    }
    iters++;
    if (iters > 200) break;
  } while (String(cursor) !== "0");
  return keys;
}

/** Per-chain native-bridge consumption (for /api/gas-tank attribution). */
export async function getNativeBridgeUsedTotals(address: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const perChain = await Promise.all(
    CCIP_LINK_CHAINS.map(async (c) => {
      const raw = await kv.get<number | string>(`${nativeBridgeUsedKey(address)}.${c}`);
      const n = typeof raw === "string" ? parseFloat(raw) : (raw ?? 0);
      return { c, n: Number.isFinite(n) ? n : 0 };
    }),
  );
  for (const { c, n } of perChain) out[c] = n;
  return out;
}

/**
 * Net LINK balance per chain (eth/avax/arbitrum). Pre-clamp negative
 * values are clamped to 0 in the response but flagged to the same ops
 * drift channel the native Gas Tank uses (via the existing
 * emitGasDriftAlert path — invoked indirectly when an API route sees
 * imbalance and chooses to escalate). For LINK we keep it simple: clamp
 * silently in MVP, add ops alerting in v2 if drift is observed.
 */
export async function getLinkBalance(address: string): Promise<Record<CCIPLinkChain, number>> {
  const [deposits, usedTotals] = await Promise.all([
    getLinkDeposits(address),
    getLinkUsedTotals(address),
  ]);
  const totals: Record<CCIPLinkChain, number> = { eth: 0, avax: 0, arbitrum: 0 };
  for (const d of deposits) {
    if (isCCIPLinkChain(d.chain)) totals[d.chain] += d.amount;
  }
  for (const c of CCIP_LINK_CHAINS) {
    totals[c] -= usedTotals[c] ?? 0;
    if (totals[c] < 0) totals[c] = 0;
  }
  return totals;
}
