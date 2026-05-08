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

  it("backfilled receipt's webhook trace marks configured deliveries as 'failed' (state not recoverable)", async () => {
    const entry = await enqueueAndFetch();
    const result = await processBackfillEntry(entry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = stringStore.get(`receipt:${result.receiptId}`) as {
      webhook: { deliveryStatus: string; lastError?: string };
    };
    expect(receipt.webhook.deliveryStatus).toBe("failed");
    expect(receipt.webhook.lastError).toContain("backfill");
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
