/**
 * receipt-backfill.test.ts — strong-guarantee path for Trust Receipts.
 *
 * Pins the queue/process/lock invariants so a future relay-route refactor
 * can't silently break the "every relay eventually gets a receipt"
 * promise. The test mocks @vercel/kv with an in-memory Map so the
 * processor runs end-to-end without hitting a real Redis.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";

// In-memory KV substitute. Has to be hoisted because vi.mock is hoisted
// above import statements at compile time.
const stringStore = new Map<string, unknown>();
const setStore    = new Map<string, Set<string>>();
const ttlStore    = new Map<string, number>();

// LIST + HASH stores so the recordRelayedTx + patchRelayedTxReceiptId
// path can round-trip through the same in-memory KV mock.
const listStore = new Map<string, unknown[]>();
const hashStore = new Map<string, Record<string, number>>();

const mockKv = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
    if (opts?.nx && stringStore.has(key)) return null;
    stringStore.set(key, value);
    if (opts?.ex) ttlStore.set(key, opts.ex);
    return "OK";
  }),
  get: vi.fn(async (key: string) => stringStore.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    stringStore.delete(key);
    ttlStore.delete(key);
    return 1;
  }),
  sadd: vi.fn(async (key: string, value: string) => {
    const s = setStore.get(key) ?? new Set<string>();
    const existed = s.has(value);
    s.add(value);
    setStore.set(key, s);
    return existed ? 0 : 1;
  }),
  srem: vi.fn(async (key: string, value: string) => {
    const s = setStore.get(key);
    if (!s) return 0;
    const removed = s.delete(value) ? 1 : 0;
    return removed;
  }),
  smembers: vi.fn(async (key: string) => Array.from(setStore.get(key) ?? [])),
  expire: vi.fn(async () => 1),
  rpush: vi.fn(async (key: string, value: unknown) => {
    const list = listStore.get(key) ?? [];
    list.push(value);
    listStore.set(key, list);
    return list.length;
  }),
  lrange: vi.fn(async (key: string) => listStore.get(key) ?? []),
  ltrim: vi.fn(async () => "OK"),
  lset:  vi.fn(async (key: string, index: number, value: unknown) => {
    const list = listStore.get(key);
    if (!list || index < 0 || index >= list.length) throw new Error("ERR index out of range");
    list[index] = value;
    return "OK";
  }),
  hincrbyfloat: vi.fn(async (key: string, field: string, by: number) => {
    const h = hashStore.get(key) ?? {};
    h[field] = (h[field] ?? 0) + by;
    hashStore.set(key, h);
    return h[field];
  }),
  hgetall: vi.fn(async (key: string) => hashStore.get(key) ?? null),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

import {
  queueReceiptBackfill,
  listBackfillQueue,
  processBackfillEntry,
  QUEUE_KEY,
  ENTRY_PREFIX,
  MAX_ATTEMPTS,
  type BackfillInput,
  type BackfillEntry,
} from "@/app/lib/receipt-backfill";
import { recordRelayedTx, patchRelayedTxReceiptId } from "@/app/lib/db";

const TEST_RELAYER_KEY     = "0x" + "33".repeat(32);
const TEST_RELAYER_ADDRESS = new Wallet(TEST_RELAYER_KEY).address.toLowerCase();

const SAMPLE_INPUT: BackfillInput = {
  txHash:            "0x" + "ee".repeat(32),
  address:           "0x000000000000000000000000000000000000beef",
  chain:             "bnb",
  payer:             "0x000000000000000000000000000000000000beef",
  recipient:         "0x000000000000000000000000000000000000feed",
  token:             "USDT",
  tokenAmount:       "5.00",
  tokenAmountRaw:    "5000000000000000000",
  method:            "eip7702",
  apiKeyTier:        "growth",
  apiKeyId:          "deadbeefcafebabe",
  sandbox:           false,
  webhookConfigured: true,
  blockNumber:       96_432_178,
  relayedAt:         "2026-05-08T00:00:00.000Z",
};

beforeEach(() => {
  stringStore.clear();
  setStore.clear();
  ttlStore.clear();
  listStore.clear();
  hashStore.clear();
  vi.clearAllMocks();
  process.env.RELAYER_PRIVATE_KEY = TEST_RELAYER_KEY;
});

afterEach(() => {
  delete process.env.RELAYER_PRIVATE_KEY;
});

// ── queue ────────────────────────────────────────────────────────────────────

describe("queueReceiptBackfill", () => {
  it("adds the txHash to the queue Set + writes the entry payload", async () => {
    await queueReceiptBackfill(SAMPLE_INPUT);
    const queue = await listBackfillQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].txHash).toBe(SAMPLE_INPUT.txHash);
    expect(queue[0].attempts).toBe(0);
    expect(queue[0].queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is idempotent — same txHash queued twice is still one queue entry", async () => {
    await queueReceiptBackfill(SAMPLE_INPUT);
    await queueReceiptBackfill(SAMPLE_INPUT);
    const queue = await listBackfillQueue();
    expect(queue).toHaveLength(1);
  });

  it("ignores empty txHash (relay never reached chain)", async () => {
    await queueReceiptBackfill({ ...SAMPLE_INPUT, txHash: "" });
    const queue = await listBackfillQueue();
    expect(queue).toHaveLength(0);
  });

  it("survives orphaned set members — listBackfillQueue cleans them up", async () => {
    // Manually plant a Set member with no entry payload (simulates KV TTL
    // dropping the entry but the Set member surviving).
    setStore.set(QUEUE_KEY, new Set(["0xorphan"]));
    const queue = await listBackfillQueue();
    expect(queue).toHaveLength(0);
    // The orphan should have been swept from the Set on read.
    expect(setStore.get(QUEUE_KEY)?.has("0xorphan")).toBe(false);
  });
});

// ── process ──────────────────────────────────────────────────────────────────

describe("processBackfillEntry", () => {
  async function enqueueAndFetch(): Promise<BackfillEntry> {
    await queueReceiptBackfill(SAMPLE_INPUT);
    const queue = await listBackfillQueue();
    return queue[0];
  }

  it("creates a receipt and removes the entry from the queue", async () => {
    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receiptId).toMatch(/^rct_[0-9a-f]{24}$/);
    }
    const queueAfter = await listBackfillQueue();
    expect(queueAfter).toHaveLength(0);
  });

  it("the produced receipt is signed by the relayer key", async () => {
    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Receipt is now in stringStore under receipt:{id}
    const receipt = stringStore.get(`receipt:${result.receiptId}`) as { signedBy: string };
    expect(receipt.signedBy).toBe(TEST_RELAYER_ADDRESS);
  });

  it("idempotent on txHash — re-processing the same entry reuses the existing receiptId", async () => {
    // Simulates: inline createReceipt body-write succeeded but somehow the
    // queue dequeue failed and the cron retries. We must not produce two
    // receipts for the same settlement.
    await queueReceiptBackfill(SAMPLE_INPUT);
    const entry = (await listBackfillQueue())[0];
    const first = await processBackfillEntry(entry);
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.receiptId : "";

    // Re-queue + re-process — without idempotency this would create a
    // second receipt with a different receiptId.
    await queueReceiptBackfill(SAMPLE_INPUT);
    const entry2 = (await listBackfillQueue())[0];
    const second = await processBackfillEntry(entry2);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.receiptId).toBe(firstId);

    // receipt-by-tx mapping points to the original receiptId.
    const lookupKey = `receipt-by-tx:${SAMPLE_INPUT.txHash.toLowerCase()}`;
    expect(stringStore.get(lookupKey)).toBe(firstId);
  });

  it("recovers actual webhook delivery state from the audit log (not always 'failed')", async () => {
    // Plant a successful webhook delivery audit row stamped with our txHash.
    const deliveryKey = `webhook_delivery:${SAMPLE_INPUT.address.toLowerCase()}`;
    listStore.set(deliveryKey, [{
      timestamp:  "2026-05-08T00:00:01.000Z",
      event:      "relay.success",
      ok:         true,
      statusCode: 200,
      attempt:    1,
      txHash:     SAMPLE_INPUT.txHash,
    }]);

    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const receipt = stringStore.get(`receipt:${result.receiptId}`) as {
      webhook: { deliveryStatus: string; lastStatusCode?: number };
    };
    expect(receipt.webhook.deliveryStatus).toBe("delivered");
    expect(receipt.webhook.lastStatusCode).toBe(200);
  });

  it("falls back to 'pending' (not 'failed') when no audit record exists yet", async () => {
    // Configured webhook but no delivery row in the audit log — could mean
    // dispatch is still in flight. "pending" is the truthful answer; the
    // previous behavior of forcing "failed" was a false negative.
    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const receipt = stringStore.get(`receipt:${result.receiptId}`) as {
      webhook: { deliveryStatus: string };
    };
    expect(receipt.webhook.deliveryStatus).toBe("pending");
  });

  it("not_configured stays not_configured when there was no webhook", async () => {
    await queueReceiptBackfill({ ...SAMPLE_INPUT, webhookConfigured: false });
    const entry = (await listBackfillQueue())[0];
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = stringStore.get(`receipt:${result.receiptId}`) as {
      webhook: { deliveryStatus: string };
    };
    expect(receipt.webhook.deliveryStatus).toBe("not_configured");
  });

  it("respects the per-tx lock — concurrent processors get 'Locked'", async () => {
    const entry = await enqueueAndFetch();
    // Plant a lock manually so the first attempt is blocked.
    stringStore.set(`receipt-backfill-lock:${entry.txHash.toLowerCase()}`, "1");
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Locked/);
      expect(result.givenUp).toBe(false);
    }
    // Entry should still be in the queue for the next attempt.
    expect((await listBackfillQueue())).toHaveLength(1);
  });

  it("patches the matching RelayedTx history row with the new receiptId", async () => {
    // Pre-populate the dashboard's tx history list with a row that has
    // no receiptId — exactly the state the relay path leaves it in
    // when inline createReceipt fails.
    await recordRelayedTx(SAMPLE_INPUT.address, {
      apiKey:        "q402_live_xxx",
      address:       SAMPLE_INPUT.address,
      chain:         SAMPLE_INPUT.chain,
      fromUser:      SAMPLE_INPUT.payer,
      toUser:        SAMPLE_INPUT.recipient,
      tokenAmount:   SAMPLE_INPUT.tokenAmount,
      tokenSymbol:   SAMPLE_INPUT.token,
      gasCostNative: 0.0001,
      relayTxHash:   SAMPLE_INPUT.txHash,
      relayedAt:     SAMPLE_INPUT.relayedAt,
      // Note: NO receiptId — this is the state we want backfill to repair
    });

    // Now run a backfill: queue + process
    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The history list row should now carry the new receiptId
    const ymOf = (d: string) => `${new Date(d).getUTCFullYear()}-${String(new Date(d).getUTCMonth() + 1).padStart(2, "0")}`;
    const monthKey = `relaytx:${SAMPLE_INPUT.address.toLowerCase()}:${ymOf(SAMPLE_INPUT.relayedAt)}`;
    const list = listStore.get(monthKey) as Array<{ relayTxHash: string; receiptId?: string }>;
    expect(list).toBeDefined();
    expect(list).toHaveLength(1);
    expect(list[0].receiptId).toBe(result.receiptId);
  });

  it("backfill still succeeds (returns ok) even if no matching tx history row exists to patch", async () => {
    // No recordRelayedTx call — patch will return false, but the receipt
    // itself is the source of truth. Backfill must not fail just because
    // the cosmetic dashboard link can't be wired.
    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
  });

  it("gives up after MAX_ATTEMPTS and removes the entry", async () => {
    const entry = await enqueueAndFetch();
    // Sabotage signing so every attempt throws.
    delete process.env.RELAYER_PRIVATE_KEY;

    let lastResult;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Re-fetch the entry each iteration so the bumped attempts count flows through.
      const fresh = (await listBackfillQueue())[0];
      lastResult = await processBackfillEntry(fresh);
      if (lastResult.ok || lastResult.givenUp) break;
    }

    expect(lastResult?.ok).toBe(false);
    if (lastResult && !lastResult.ok) {
      expect(lastResult.givenUp).toBe(true);
    }
    expect((await listBackfillQueue())).toHaveLength(0);
    void entry;
    void ENTRY_PREFIX;
  });
});

// ── patchRelayedTxReceiptId ──────────────────────────────────────────────────

describe("patchRelayedTxReceiptId", () => {
  const ADDR    = "0x000000000000000000000000000000000000beef";
  const TX      = "0x" + "ab".repeat(32);
  const NEW_ID  = "rct_" + "1".repeat(24);

  async function planRow(receiptId?: string): Promise<void> {
    await recordRelayedTx(ADDR, {
      apiKey:        "q402_live_xxx",
      address:       ADDR,
      chain:         "bnb",
      fromUser:      ADDR,
      toUser:        "0x000000000000000000000000000000000000feed",
      tokenAmount:   "5.00",
      tokenSymbol:   "USDT",
      gasCostNative: 0.0001,
      relayTxHash:   TX,
      relayedAt:     new Date().toISOString(),
      receiptId,
    });
  }

  it("rewrites the matching row's receiptId", async () => {
    await planRow();
    const ok = await patchRelayedTxReceiptId(ADDR, TX, NEW_ID, new Date().toISOString());
    expect(ok).toBe(true);
    const monthKey = Array.from(listStore.keys()).find(k => k.startsWith(`relaytx:${ADDR.toLowerCase()}`))!;
    const list = listStore.get(monthKey) as Array<{ receiptId?: string }>;
    expect(list[0].receiptId).toBe(NEW_ID);
  });

  it("returns false when the txHash is not in any recent month", async () => {
    await planRow();
    const ok = await patchRelayedTxReceiptId(ADDR, "0xunknown", NEW_ID, new Date().toISOString());
    expect(ok).toBe(false);
  });

  it("is idempotent — re-patching the same row with the same id is a no-op", async () => {
    await planRow();
    expect(await patchRelayedTxReceiptId(ADDR, TX, NEW_ID, new Date().toISOString())).toBe(true);
    expect(await patchRelayedTxReceiptId(ADDR, TX, NEW_ID, new Date().toISOString())).toBe(true);
    const monthKey = Array.from(listStore.keys()).find(k => k.startsWith(`relaytx:${ADDR.toLowerCase()}`))!;
    const list = listStore.get(monthKey) as Array<{ receiptId?: string }>;
    expect(list).toHaveLength(1);  // didn't append a duplicate
    expect(list[0].receiptId).toBe(NEW_ID);
  });

  it("matches case-insensitively on txHash", async () => {
    await planRow();
    const ok = await patchRelayedTxReceiptId(ADDR, TX.toUpperCase(), NEW_ID, new Date().toISOString());
    expect(ok).toBe(true);
  });
});
