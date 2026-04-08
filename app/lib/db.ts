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
}

interface ApiKeyRecord {
  address: string;
  createdAt: string;
  active: boolean;
  plan: string;
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
const relayTxKey    = (addr: string) => `relaytx:${addr.toLowerCase()}`;

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
  // Use cryptographically secure random bytes — Math.random() is predictable
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

// ── Gas Deposits ─────────────────────────────────────────────────────────────

export async function getGasDeposits(address: string): Promise<GasDeposit[]> {
  return (await kv.get<GasDeposit[]>(gasDepKey(address))) ?? [];
}

export async function addGasDeposit(address: string, deposit: GasDeposit) {
  const existing = await getGasDeposits(address);
  if (existing.some(d => d.txHash === deposit.txHash)) return; // deduplicate
  await kv.set(gasDepKey(address), [...existing, deposit]);
}

export async function getGasBalance(address: string): Promise<Record<string, number>> {
  const deposits = await getGasDeposits(address);
  const used     = await getGasUsed(address);
  const totals: Record<string, number> = { bnb: 0, eth: 0, avax: 0, xlayer: 0, stable: 0 };
  for (const d of deposits) totals[d.chain] = (totals[d.chain] ?? 0) + d.amount;
  for (const u of used)     totals[u.chain] = (totals[u.chain] ?? 0) - u.gasCostNative;
  return totals;
}

// ── Relayed TXs ───────────────────────────────────────────────────────────────

export async function getRelayedTxs(address: string): Promise<RelayedTx[]> {
  return (await kv.get<RelayedTx[]>(relayTxKey(address))) ?? [];
}

export async function getGasUsed(address: string): Promise<RelayedTx[]> {
  return getRelayedTxs(address);
}

export async function recordRelayedTx(address: string, tx: RelayedTx) {
  const existing = await getRelayedTxs(address);
  await kv.set(relayTxKey(address), [...existing, tx]);
}

export async function addQuotaBonus(address: string, additionalTxs: number) {
  const sub = await getSubscription(address);
  if (!sub) throw new Error("No subscription found");
  await setSubscription(address, {
    ...sub,
    quotaBonus: (sub.quotaBonus ?? 0) + additionalTxs,
  });
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
  if (!sub) return false;
  const expiresAt = new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  return new Date() < expiresAt;
}

export async function getSubscriptionExpiry(address: string): Promise<Date | null> {
  const sub = await getSubscription(address);
  if (!sub) return null;
  return new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
}
