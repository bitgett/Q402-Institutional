/**
 * request-pay-route.test.ts
 *
 * Guards on POST /api/request/[id]/pay (creator-sponsored settlement):
 *  - rejects a non-open request (409)
 *  - rejects when a settlement lock is already held (409)
 *  - TAMPER-SAFETY: forwards the SERVER-derived raw amount + stored recipient
 *    to the relay, injects the creator's apiKey + source:"request", and never
 *    trusts a client-supplied amount/recipient
 *  - on relay success, flips the request to "paid"
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
    lrange: vi.fn(async () => []),
    ltrim: vi.fn(async () => "OK"),
  },
}));

vi.mock("@/app/lib/db", () => ({
  getSubscription: vi.fn(async () => ({
    paidAt: "",
    apiKey: "q402_live_creatorpaid",
    trialApiKey: "q402_live_creatortrial",
    plan: "pro",
    txHash: "",
    amountUSD: 0,
  })),
  hasMultichainScope: vi.fn(() => true),
}));

vi.mock("@/app/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => true),
  getClientIP: vi.fn(() => "1.2.3.4"),
}));

import { POST } from "@/app/api/request/[id]/pay/route";
import {
  payreqKey,
  payreqLockKey,
  type PaymentRequest,
} from "@/app/lib/payment-request";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

function openRequest(id: string, over: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id,
    creatorOwner: "0xcreator000000000000000000000000000000aa",
    recipient: RECIPIENT,
    chain: "eth",
    token: "USDC",
    amount: "2.5",
    status: "open",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    sandbox: false,
    ...over,
  };
}

function payReq(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}
function payCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}
const VALID_BODY = {
  from: PAYER,
  witnessSig: "0x" + "1".repeat(130),
  authorization: { chainId: 1, address: "0xabc", nonce: 0, yParity: 0, r: "0x1", s: "0x2" },
  nonce: "12345",
  deadline: Math.floor(Date.now() / 1000) + 600,
};

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("pay route - state guards", () => {
  it("rejects a non-open request with 409", async () => {
    const id = `req_${"c".repeat(24)}`;
    store.set(payreqKey(id), openRequest(id, { status: "paid" }));
    const res = await POST(payReq(VALID_BODY), payCtx(id));
    expect(res.status).toBe(409);
  });

  it("rejects when a settlement lock is already held", async () => {
    const id = `req_${"d".repeat(24)}`;
    store.set(payreqKey(id), openRequest(id));
    store.set(payreqLockKey(id), "1"); // pre-held lock
    const res = await POST(payReq(VALID_BODY), payCtx(id));
    expect(res.status).toBe(409);
  });

  it("rejects a missing-field body with 400", async () => {
    const id = `req_${"e".repeat(24)}`;
    store.set(payreqKey(id), openRequest(id));
    const res = await POST(payReq({ from: PAYER }), payCtx(id));
    expect(res.status).toBe(400);
  });
});

describe("pay route - tamper-safety + settlement", () => {
  it("forwards the server amount + creator key + source, then marks paid", async () => {
    const id = `req_${"f".repeat(24)}`;
    store.set(payreqKey(id), openRequest(id)); // eth USDC, amount 2.5 (6 decimals)

    let captured: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ success: true, txHash: "0xfeed", receiptId: "rct_x" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    // Client tries to under-pay by sending its own amount/recipient - both must be ignored.
    const res = await POST(
      payReq({ ...VALID_BODY, amount: "0.01", to: "0xattacker000000000000000000000000000000ff" }),
      payCtx(id),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe("paid");
    expect(json.txHash).toBe("0xfeed");

    // Server-derived raw amount: 2.5 USDC at 6 decimals = 2500000 (not the client's 0.01).
    expect(captured!.amount).toBe("2500000");
    expect(captured!.to).toBe(RECIPIENT);
    expect(captured!.source).toBe("request");
    expect(captured!.apiKey).toBe("q402_live_creatorpaid"); // eth -> multichain key
    expect(captured!.nonce).toBe("12345");

    // Request is now paid in the store.
    expect((store.get(payreqKey(id)) as PaymentRequest).status).toBe("paid");
  });
});
