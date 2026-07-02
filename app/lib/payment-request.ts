import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";

/**
 * Payment Requests - the receive side of Q402.
 *
 * A PaymentRequest is a published intent to RECEIVE money. The creator
 * (biller) names a recipient, chain, token, amount and memo; any payer can
 * later fulfill it gaslessly. There are TWO settlement modes (see
 * /api/request/[id]/pay), and the cost model differs between them:
 *
 *   - WITNESS (creator-sponsored): an arbitrary external wallet with no Q402
 *     account signs a TransferAuthorization in the browser; the CREATOR's
 *     quota/gas-tank covers settlement. This is the "share a link, anyone
 *     pays" path.
 *   - SERVER / Mode C (payer-sponsored): an agent pays from its OWN
 *     server-managed Agent Wallet via /api/wallet/agentic/send using its OWN
 *     apiKey; the PAYER sponsors its own gas. This is the agent-to-agent
 *     billing path (q402_request_pay).
 *
 * Storage mirrors the payment-intent primitive (app/lib/payment-intent.ts)
 * for the id-keyed record + the relaytx list convention (app/lib/db.ts) for
 * the per-owner index:
 *
 *   payreq:{id}            -> PaymentRequest   (id-keyed record, TTL = expiry + grace)
 *   payreq:owner:{owner}   -> list of ids      (RPUSH + LTRIM cap, newest last)
 *   payreq:lock:{id}       -> SET NX pay lock  (short TTL, prevents double-pay)
 *
 * The record never stores the creator's apiKey (a secret). The pay route
 * derives the billing key at settle time from the creator's subscription,
 * so the public status projection can be returned safely.
 */

export type PaymentRequestStatus = "open" | "paid" | "expired" | "cancelled";

export interface PaymentRequest {
  id: string;                 // "req_<24-hex>"
  creatorOwner: string;       // lowercased owner EOA that published the request
  recipient: string;          // address that receives the funds
  chain: string;              // AgenticChainKey (bnb|eth|avax|xlayer|stable|mantle|injective|monad|scroll|arbitrum)
  token: "USDC" | "USDT" | "USDG";
  amount: string;             // human-readable decimal STRING (never a JS Number - 18-dec precision)
  memo?: string;
  status: PaymentRequestStatus;
  createdAt: string;          // ISO
  expiresAt: string;          // ISO
  paidTxHash?: string;
  paidBy?: string;            // lowercased payer address
  paidAt?: string;            // ISO
  receiptId?: string;         // Trust Receipt id (rct_...)
  sandbox: boolean;           // created with a sandbox (q402_test_) key
}

/** Fields safe to return on the public GET /api/request/[id] surface. */
export interface PublicPaymentRequest {
  id: string;
  recipient: string;
  chain: string;
  token: "USDC" | "USDT" | "USDG";
  amount: string;
  memo?: string;
  status: PaymentRequestStatus;
  createdAt: string;
  expiresAt: string;
  paidTxHash?: string;
  paidAt?: string;
  paidBy?: string;
  receiptId?: string;
  sandbox: boolean;
}

// Default request lifetime + how long a terminal (paid/expired/cancelled)
// record lingers as a readable key before KV evicts it.
const DEFAULT_TTL_DAYS = 7;
const GRACE_DAYS = 7;
const OWNER_INDEX_CAP = 500;

const ID_RE = /^req_[0-9a-f]{24}$/;

export function payreqKey(id: string) {
  return `payreq:${id}`;
}
export function payreqOwnerKey(owner: string) {
  return `payreq:owner:${owner.toLowerCase()}`;
}
export function payreqLockKey(id: string) {
  return `payreq:lock:${id}`;
}
export function payreqSettledKey(id: string) {
  return `payreq:settled:${id}`;
}

export function isValidRequestId(id: string): boolean {
  return ID_RE.test(id);
}

function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

/** Seconds from now until a record should expire from KV (expiry + grace). */
function ttlSecondsFor(expiresAtIso: string): number {
  const expiry = new Date(expiresAtIso).getTime();
  const grace = GRACE_DAYS * 24 * 60 * 60 * 1000;
  const ms = expiry + grace - Date.now();
  // Floor at one hour so a near-expiry update never writes a sub-second TTL.
  return Math.max(3600, Math.floor(ms / 1000));
}

export interface CreatePaymentRequestInput {
  creatorOwner: string;
  recipient: string;
  chain: string;
  token: "USDC" | "USDT" | "USDG";
  amount: string;
  memo?: string;
  sandbox: boolean;
  ttlDays?: number;
}

export async function createPaymentRequest(
  input: CreatePaymentRequestInput,
): Promise<PaymentRequest> {
  const now = new Date();
  const ttlDays = input.ttlDays && input.ttlDays > 0 ? input.ttlDays : DEFAULT_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  const record: PaymentRequest = {
    id: newRequestId(),
    creatorOwner: input.creatorOwner.toLowerCase(),
    recipient: input.recipient,
    chain: input.chain,
    token: input.token,
    amount: input.amount,
    ...(input.memo ? { memo: input.memo } : {}),
    status: "open",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sandbox: input.sandbox,
  };

  await kv.set(payreqKey(record.id), record, { ex: ttlSecondsFor(record.expiresAt) });

  // Owner index: newest last, capped. RPUSH + LTRIM mirrors the relaytx
  // monthly-list convention so a heavy biller can't grow the key unbounded.
  try {
    const len = await kv.rpush(payreqOwnerKey(record.creatorOwner), record.id);
    if (len > OWNER_INDEX_CAP) {
      kv.ltrim(payreqOwnerKey(record.creatorOwner), -OWNER_INDEX_CAP, -1).catch(() => {});
    }
  } catch {
    // Index write failed (e.g. KV blip / legacy WRONGTYPE). The id-keyed
    // record is the source of truth and the payUrl is already returned to
    // the caller, so the request is fully payable; it just may not appear in
    // the dashboard list. Dropping the index write is the safe outcome.
  }

  return record;
}

/**
 * Read a request by id, lazily flipping an `open` record to `expired` once
 * past its expiry. The flip is persisted best-effort so subsequent reads and
 * the pay route agree without a cron.
 */
export async function getPaymentRequest(id: string): Promise<PaymentRequest | null> {
  if (!isValidRequestId(id)) return null;
  const rec = await kv.get<PaymentRequest>(payreqKey(id));
  if (!rec) return null;
  if (rec.status === "open" && Date.now() > new Date(rec.expiresAt).getTime()) {
    const expired: PaymentRequest = { ...rec, status: "expired" };
    // Persist the flip best-effort, but GUARD it: re-read immediately before
    // writing and only persist if the record is STILL open + expired. Without
    // the guard, a concurrent markRequestPaid / cancel that lands between our
    // read above and this write would be clobbered back to `expired`, losing
    // the txHash + paidBy of a payment whose funds already moved. The returned
    // value is authoritative regardless of whether this persist wins the race.
    void (async () => {
      try {
        const fresh = await kv.get<PaymentRequest>(payreqKey(id));
        if (fresh && fresh.status === "open" && Date.now() > new Date(fresh.expiresAt).getTime()) {
          await kv.set(payreqKey(id), { ...fresh, status: "expired" }, { ex: ttlSecondsFor(fresh.expiresAt) });
        }
      } catch {
        /* best-effort — the computed `expired` view is already returned */
      }
    })();
    return expired;
  }
  return rec;
}

/**
 * Paginated owner listing, newest-first. The owner index is oldest->newest
 * (rpush appends), so a page at `offset` is a window near the tail. We fetch
 * ONE extra id on the older side as a `hasMore` probe (avoids a separate llen
 * round-trip), then drop it. Records evicted from KV since indexing are
 * filtered out, so a page can return shorter than `limit`; `hasMore` is derived
 * from the raw id window, not the filtered records, so paging never stalls on
 * an evicted row.
 */
export async function listPaymentRequestsPage(
  owner: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ records: PaymentRequest[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), OWNER_INDEX_CAP);
  const offset = Math.max(0, opts.offset ?? 0);
  let ids: string[] = [];
  try {
    // Window [offset, offset+limit) counted from the newest end, plus one older
    // item as the hasMore probe.
    ids = (await kv.lrange<string>(payreqOwnerKey(owner), -(offset + limit + 1), -(offset + 1))) ?? [];
  } catch {
    return { records: [], hasMore: false };
  }
  const hasMore = ids.length > limit;
  // Keep the newest `limit` of the window (drop the older probe item if present).
  const pageIds = hasMore ? ids.slice(ids.length - limit) : ids;
  if (pageIds.length === 0) return { records: [], hasMore: false };
  const records = await Promise.all(pageIds.map((id) => getPaymentRequest(id)));
  return {
    records: records
      .filter((r): r is PaymentRequest => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    hasMore,
  };
}

export async function listPaymentRequests(
  owner: string,
  limit = 100,
  offset = 0,
): Promise<PaymentRequest[]> {
  return (await listPaymentRequestsPage(owner, { limit, offset })).records;
}

export async function markRequestPaid(
  id: string,
  fields: { txHash: string; paidBy: string; receiptId?: string },
): Promise<PaymentRequest | null> {
  const rec = await kv.get<PaymentRequest>(payreqKey(id));
  if (!rec) return null;
  const paid: PaymentRequest = {
    ...rec,
    status: "paid",
    paidTxHash: fields.txHash,
    paidBy: fields.paidBy.toLowerCase(),
    paidAt: new Date().toISOString(),
    ...(fields.receiptId ? { receiptId: fields.receiptId } : {}),
  };
  await kv.set(payreqKey(id), paid, { ex: ttlSecondsFor(paid.expiresAt) });
  return paid;
}

export async function cancelPaymentRequest(id: string): Promise<PaymentRequest | null> {
  const rec = await kv.get<PaymentRequest>(payreqKey(id));
  if (!rec) return null;
  if (rec.status !== "open") return rec; // only an open request can be cancelled
  const cancelled: PaymentRequest = { ...rec, status: "cancelled" };
  await kv.set(payreqKey(id), cancelled, { ex: ttlSecondsFor(cancelled.expiresAt) });
  return cancelled;
}

/**
 * Acquire the single-payment lock for a request. Returns true if this caller
 * won the lock, false if a settlement is already in flight. Mirrors the
 * SET NX claim used by the agentic send idempotency guard.
 */
export async function acquireRequestPayLock(id: string): Promise<boolean> {
  const res = await kv.set(payreqLockKey(id), "1", { nx: true, ex: 120 });
  return !!res;
}

export async function releaseRequestPayLock(id: string): Promise<void> {
  await kv.del(payreqLockKey(id)).catch(() => {});
}

/**
 * Durable, request-scoped "this request settled" marker. Written the instant a
 * settlement lands on-chain (BEFORE the status flip to `paid`), so a re-pay is
 * blocked even if every markRequestPaid retry fails and the 120s pay lock later
 * expires. The pay route checks it on entry, so a SECOND distinct payer can
 * never re-settle a request whose funds already moved (the per-payer send
 * idempotency marker is scoped by owner+wallet and would NOT stop a different
 * payer; this request-scoped marker does). TTL tracks the record's own lifetime
 * (expiry + grace) — past that the request is unpayable anyway.
 */
export interface RequestSettledMarker {
  txHash: string;
  paidBy: string;            // lowercased payer / wallet address ("" if unknown)
  receiptId?: string;
  mode: "witness" | "server";
  settledAt: string;         // ISO
}

export async function getRequestSettledMarker(id: string): Promise<RequestSettledMarker | null> {
  if (!isValidRequestId(id)) return null;
  try {
    return (await kv.get<RequestSettledMarker>(payreqSettledKey(id))) ?? null;
  } catch {
    // Treat a transient read blip as "no marker". The pay route's SET NX lock
    // + status check are the primary guards, and getPaymentRequest would itself
    // have thrown earlier if KV were durably down, so this never stands alone
    // as the only thing between two settlements.
    return null;
  }
}

/**
 * Write the durable settled marker with bounded retry. Returns false only if
 * every attempt fails (KV durably down at settlement time) — the caller then
 * pages ops, since a post-lock retry could re-fire. `expiresAtIso` ties the
 * marker TTL to the request lifetime.
 */
export async function writeRequestSettledMarker(
  id: string,
  marker: RequestSettledMarker,
  expiresAtIso: string,
): Promise<boolean> {
  const ttl = ttlSecondsFor(expiresAtIso);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await kv.set(payreqSettledKey(id), marker, { ex: ttl });
      return true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return false;
}

export function toPublicRequest(r: PaymentRequest): PublicPaymentRequest {
  return {
    id: r.id,
    recipient: r.recipient,
    chain: r.chain,
    token: r.token,
    amount: r.amount,
    ...(r.memo ? { memo: r.memo } : {}),
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.paidTxHash ? { paidTxHash: r.paidTxHash } : {}),
    ...(r.paidAt ? { paidAt: r.paidAt } : {}),
    ...(r.paidBy ? { paidBy: r.paidBy } : {}),
    ...(r.receiptId ? { receiptId: r.receiptId } : {}),
    sandbox: r.sandbox,
  };
}
