import fs from "fs";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "db.json");

interface Subscription {
  paidAt: string;
  apiKey: string;
  plan: string;
  txHash: string;
  amountUSD: number;
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

interface DB {
  subscriptions: Record<string, Subscription>;
  apiKeys: Record<string, ApiKeyRecord>;
  // address → list of confirmed gas deposits
  gasDeposits: Record<string, GasDeposit[]>;
  // address → list of relayed transactions (for gas consumption tracking)
  relayedTxs: Record<string, RelayedTx[]>;
}

function readDB(): DB {
  if (!fs.existsSync(DB_PATH)) {
    const empty: DB = { subscriptions: {}, apiKeys: {}, gasDeposits: {}, relayedTxs: {} };
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  if (!db.gasDeposits) db.gasDeposits = {};
  if (!db.relayedTxs) db.relayedTxs = {};
  return db;
}

function writeDB(db: DB) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function getSubscription(address: string): Subscription | null {
  const db = readDB();
  return db.subscriptions[address.toLowerCase()] ?? null;
}

export function setSubscription(address: string, data: Subscription) {
  const db = readDB();
  db.subscriptions[address.toLowerCase()] = data;
  writeDB(db);
}

export function getApiKeyRecord(apiKey: string): ApiKeyRecord | null {
  const db = readDB();
  return db.apiKeys[apiKey] ?? null;
}

export function generateApiKey(address: string, plan: string): string {
  const db = readDB();
  const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const key = `q402_live_${rand}`;
  db.apiKeys[key] = {
    address: address.toLowerCase(),
    createdAt: new Date().toISOString(),
    active: true,
    plan,
  };
  writeDB(db);
  return key;
}

// ── Gas Deposit tracking ──────────────────────────────────────────────────────

export function getGasDeposits(address: string): GasDeposit[] {
  const db = readDB();
  return db.gasDeposits[address.toLowerCase()] ?? [];
}

export function addGasDeposit(address: string, deposit: GasDeposit) {
  const db = readDB();
  const key = address.toLowerCase();
  if (!db.gasDeposits[key]) db.gasDeposits[key] = [];
  // Avoid duplicate txHash
  const exists = db.gasDeposits[key].some(d => d.txHash === deposit.txHash);
  if (!exists) {
    db.gasDeposits[key].push(deposit);
    writeDB(db);
  }
}

// Sum deposited amount per chain for a given address
export function getGasBalance(address: string): Record<string, number> {
  const deposits = getGasDeposits(address);
  const used = getGasUsed(address);
  const totals: Record<string, number> = { bnb: 0, eth: 0, avax: 0, xlayer: 0 };
  for (const d of deposits) totals[d.chain] = (totals[d.chain] ?? 0) + d.amount;
  for (const u of used)    totals[u.chain] = (totals[u.chain] ?? 0) - u.gasCostNative;
  return totals;
}

// ── Relayed TX tracking ───────────────────────────────────────────────────────

export function getRelayedTxs(address: string): RelayedTx[] {
  const db = readDB();
  return db.relayedTxs[address.toLowerCase()] ?? [];
}

export function getGasUsed(address: string): RelayedTx[] {
  return getRelayedTxs(address);
}

export function recordRelayedTx(address: string, tx: RelayedTx) {
  const db = readDB();
  const key = address.toLowerCase();
  if (!db.relayedTxs[key]) db.relayedTxs[key] = [];
  db.relayedTxs[key].push(tx);
  writeDB(db);
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

const PLAN_QUOTA: Record<string, number> = {
  starter:     1_000,
  growth:     10_000,
  enterprise: 100_000,
};

export function getPlanQuota(plan: string): number {
  return PLAN_QUOTA[plan?.toLowerCase()] ?? 1_000;
}

/** Returns true if the subscription is still within its 30-day window */
export function isSubscriptionActive(address: string): boolean {
  const sub = getSubscription(address);
  if (!sub) return false;
  const expiresAt = new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  return new Date() < expiresAt;
}

export function getSubscriptionExpiry(address: string): Date | null {
  const sub = getSubscription(address);
  if (!sub) return null;
  return new Date(new Date(sub.paidAt).getTime() + 30 * 24 * 60 * 60 * 1000);
}
