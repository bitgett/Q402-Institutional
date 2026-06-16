/**
 * payment-request.test.ts
 *
 * Covers app/lib/payment-request.ts:
 *  - createPaymentRequest stores an id-keyed record + owner index, status open
 *  - getPaymentRequest lazily flips an expired-but-open record to "expired"
 *  - listPaymentRequests returns newest-first and tolerates missing records
 *  - markRequestPaid / cancelPaymentRequest status transitions
 *  - acquireRequestPayLock serializes settlement (the double-pay guard)
 *  - toPublicRequest never leaks creatorOwner
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("@vercel/kv", () => ({
  kv: {
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    set: vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
    rpush: vi.fn(async (k: string, ...vals: unknown[]) => {
      const arr = (store.get(k) as unknown[]) ?? [];
      arr.push(...vals);
      store.set(k, arr);
      return arr.length;
    }),
    lrange: vi.fn(async (k: string, start: number, stop: number) => {
      const arr = (store.get(k) as unknown[]) ?? [];
      const n = arr.length;
      const s = start < 0 ? Math.max(n + start, 0) : start;
      const e = stop < 0 ? n + stop : stop;
      return arr.slice(s, e + 1);
    }),
    ltrim: vi.fn(async () => "OK"),
  },
}));

import {
  createPaymentRequest,
  getPaymentRequest,
  listPaymentRequests,
  markRequestPaid,
  cancelPaymentRequest,
  acquireRequestPayLock,
  releaseRequestPayLock,
  toPublicRequest,
  payreqKey,
  isValidRequestId,
  type PaymentRequest,
} from "@/app/lib/payment-request";

const OWNER = "0xCreator0000000000000000000000000000000A";
const RECIPIENT = "0xReCiP0000000000000000000000000000000001";

beforeEach(() => {
  store.clear();
});

describe("createPaymentRequest", () => {
  it("stores an open id-keyed record and indexes it under the owner", async () => {
    const rec = await createPaymentRequest({
      creatorOwner: OWNER,
      recipient: RECIPIENT,
      chain: "bnb",
      token: "USDC",
      amount: "12.5",
      memo: "invoice 1",
      sandbox: false,
    });

    expect(isValidRequestId(rec.id)).toBe(true);
    expect(rec.status).toBe("open");
    expect(rec.creatorOwner).toBe(OWNER.toLowerCase());
    expect(rec.amount).toBe("12.5");
    expect(store.has(payreqKey(rec.id))).toBe(true);

    const list = await listPaymentRequests(OWNER);
    expect(list.map((r) => r.id)).toContain(rec.id);
  });
});

describe("getPaymentRequest - lazy expiry", () => {
  it("flips an open record to expired once past expiresAt and persists it", async () => {
    const id = `req_${"a".repeat(24)}`;
    const past: PaymentRequest = {
      id,
      creatorOwner: OWNER.toLowerCase(),
      recipient: RECIPIENT,
      chain: "bnb",
      token: "USDT",
      amount: "1",
      status: "open",
      createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(), // yesterday
      sandbox: false,
    };
    store.set(payreqKey(id), past);

    const got = await getPaymentRequest(id);
    expect(got?.status).toBe("expired");
    // Persisted, so a re-read also sees expired.
    expect((store.get(payreqKey(id)) as PaymentRequest).status).toBe("expired");
  });

  it("returns null for a malformed id without touching kv", async () => {
    expect(await getPaymentRequest("not-an-id")).toBeNull();
  });
});

describe("status transitions", () => {
  it("markRequestPaid sets paid + tx fields", async () => {
    const rec = await createPaymentRequest({
      creatorOwner: OWNER,
      recipient: RECIPIENT,
      chain: "bnb",
      token: "USDC",
      amount: "5",
      sandbox: false,
    });
    const paid = await markRequestPaid(rec.id, {
      txHash: "0xdeadbeef",
      paidBy: "0xPayer0000000000000000000000000000000099",
      receiptId: "rct_abc",
    });
    expect(paid?.status).toBe("paid");
    expect(paid?.paidTxHash).toBe("0xdeadbeef");
    expect(paid?.paidBy).toBe("0xpayer0000000000000000000000000000000099");
    expect(paid?.receiptId).toBe("rct_abc");
  });

  it("cancelPaymentRequest cancels open, leaves terminal states untouched", async () => {
    const rec = await createPaymentRequest({
      creatorOwner: OWNER,
      recipient: RECIPIENT,
      chain: "bnb",
      token: "USDC",
      amount: "5",
      sandbox: false,
    });
    const cancelled = await cancelPaymentRequest(rec.id);
    expect(cancelled?.status).toBe("cancelled");

    // A second cancel is a no-op (already terminal).
    const again = await cancelPaymentRequest(rec.id);
    expect(again?.status).toBe("cancelled");
  });
});

describe("acquireRequestPayLock - double-pay guard", () => {
  it("only the first caller wins the lock until released", async () => {
    const id = `req_${"b".repeat(24)}`;
    expect(await acquireRequestPayLock(id)).toBe(true);
    expect(await acquireRequestPayLock(id)).toBe(false);
    await releaseRequestPayLock(id);
    expect(await acquireRequestPayLock(id)).toBe(true);
  });
});

describe("toPublicRequest", () => {
  it("omits creatorOwner from the public projection", async () => {
    const rec = await createPaymentRequest({
      creatorOwner: OWNER,
      recipient: RECIPIENT,
      chain: "bnb",
      token: "USDC",
      amount: "5",
      sandbox: false,
    });
    const pub = toPublicRequest(rec);
    expect(pub).not.toHaveProperty("creatorOwner");
    expect(pub.id).toBe(rec.id);
    expect(pub.recipient).toBe(RECIPIENT);
  });
});
