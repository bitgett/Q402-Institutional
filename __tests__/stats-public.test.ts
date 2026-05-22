/**
 * stats-public.test.ts
 *
 * Behavioural + source-grep coverage for /api/stats/public.
 *
 * Behavioural: KV is mocked with a small relayed-tx fixture (live + sandbox,
 * multi-chain, mixed string/number amounts, duplicate payers). The route's
 * GET handler must surface the aggregate-only schema with sandbox rows
 * excluded.
 *
 * Source-grep: pins the privacy + CORS invariants so a future refactor
 * cannot quietly start scanning subscription records, rename
 * uniquePayers/uniqueRecipients, drop the cache header, or echo per-row
 * fields back out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const store = new Map<string, unknown>();

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  keys: vi.fn(),
  lrange: vi.fn(),
  llen: vi.fn(),
  del: vi.fn(),
  incrby: vi.fn(),
  decrby: vi.fn(),
  sadd: vi.fn(),
  smembers: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

interface FakeRow {
  apiKey?: string;
  chain?: string;
  fromUser?: string;
  toUser?: string;
  tokenAmount?: number | string;
}

function seedRelayHistory(map: Record<string, FakeRow[]>) {
  for (const [key, rows] of Object.entries(map)) {
    // Store under the JSON-array shape so the route's legacy fallback
    // exercises (lrange returns empty here, then get returns the array).
    store.set(key, rows);
  }
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  mockKv.keys.mockImplementation((pattern: string) => {
    if (!pattern.startsWith("relaytx:")) {
      // The route should NEVER scan anything else. Surface this loud so
      // a future regression that adds a sub:* scan fails the test.
      throw new Error(`unexpected kv.keys pattern: ${pattern}`);
    }
    const match = pattern.replace("relaytx:", "").replace("*", "");
    const out: string[] = [];
    for (const k of store.keys()) {
      if (k.startsWith("relaytx:") && k.includes(match)) out.push(k);
    }
    return Promise.resolve(out);
  });
  mockKv.lrange.mockImplementation(() => Promise.resolve([])); // legacy-shape path
  mockKv.get.mockImplementation((key: string) =>
    Promise.resolve(store.get(key) ?? null),
  );
});

const ROUTE = "@/app/api/stats/public/route";

describe("GET /api/stats/public — aggregate behaviour", () => {
  it("returns the documented schema with zero history", async () => {
    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      totalSettlements: 0,
      uniquePayers:     0,
      uniqueRecipients: 0,
      totalVolumeUsd:   0,
      perChain:         {},
    });
    expect(typeof body.asOf).toBe("string");
    expect(new Date(body.asOf).toString()).not.toBe("Invalid Date");

    // Privacy invariants — none of these forbidden keys appear on the wire.
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("uniqueWallets");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("txHashes");
    expect(JSON.stringify(body)).not.toMatch(/q402_live_/);
    expect(JSON.stringify(body)).not.toMatch(/q402_test_/);
    expect(JSON.stringify(body)).not.toMatch(/0x[a-f0-9]{40}/i);
  });

  it("aggregates live txs across chains and dedupes payers + recipients", async () => {
    seedRelayHistory({
      "relaytx:0xaaa:2026-05": [
        { apiKey: "q402_live_a", chain: "bnb",  fromUser: "0xPAYER1", toUser: "0xR1", tokenAmount: "0.5" },
        { apiKey: "q402_live_a", chain: "bnb",  fromUser: "0xPAYER1", toUser: "0xR2", tokenAmount: "1.0" },
      ],
      "relaytx:0xbbb:2026-05": [
        { apiKey: "q402_live_b", chain: "eth",  fromUser: "0xPAYER2", toUser: "0xR1", tokenAmount: 2.25  },
        { apiKey: "q402_live_b", chain: "avax", fromUser: "0xPAYER1", toUser: "0xR3", tokenAmount: 0.10  },
      ],
    });

    const { GET } = await import(ROUTE);
    const body = await (await GET()).json();

    expect(body.totalSettlements).toBe(4);
    // 0xPAYER1 appears in 3 rows but counts once. 0xPAYER2 once.
    expect(body.uniquePayers).toBe(2);
    // 0xR1 / 0xR2 / 0xR3 — three distinct recipients.
    expect(body.uniqueRecipients).toBe(3);
    // 0.5 + 1.0 + 2.25 + 0.10 = 3.85
    expect(body.totalVolumeUsd).toBeCloseTo(3.85, 2);

    expect(body.perChain.bnb).toEqual({ settlements: 2, volumeUsd: 1.5  });
    expect(body.perChain.eth).toEqual({ settlements: 1, volumeUsd: 2.25 });
    expect(body.perChain.avax).toEqual({ settlements: 1, volumeUsd: 0.1 });
  });

  it("excludes rows with q402_test_ and q402_sandbox_ api keys", async () => {
    seedRelayHistory({
      "relaytx:0xaaa:2026-05": [
        { apiKey: "q402_live_a",    chain: "bnb", fromUser: "0xP1", toUser: "0xR1", tokenAmount: 1 },
        { apiKey: "q402_test_x",    chain: "bnb", fromUser: "0xSB", toUser: "0xR1", tokenAmount: 99 },
        { apiKey: "q402_sandbox_y", chain: "eth", fromUser: "0xSB", toUser: "0xR1", tokenAmount: 50 },
      ],
    });

    const { GET } = await import(ROUTE);
    const body = await (await GET()).json();

    expect(body.totalSettlements).toBe(1);
    expect(body.uniquePayers).toBe(1);
    expect(body.totalVolumeUsd).toBe(1);
    expect(body.perChain.eth).toBeUndefined();      // only sandbox eth rows → no bucket
    expect(body.perChain.bnb.settlements).toBe(1);  // sandbox bnb dropped
  });

  it("ignores malformed rows without throwing", async () => {
    seedRelayHistory({
      "relaytx:0xaaa:2026-05": [
        { apiKey: "q402_live_a", chain: "bnb", fromUser: "0xP1", toUser: "0xR1", tokenAmount: 1 },
        // missing fields / wrong types — should not crash aggregation
        { apiKey: "q402_live_a", chain: "bnb", fromUser: 123 as unknown as string, toUser: null as unknown as string, tokenAmount: "NaN" },
        { apiKey: "q402_live_a", chain: "",    fromUser: "0xP2", toUser: "0xR2", tokenAmount: -5 },
      ],
    });

    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSettlements).toBe(3);
    expect(body.totalVolumeUsd).toBe(1); // negative / NaN dropped
    // Empty chain string falls into the "unknown" bucket so the row count
    // still surfaces somewhere visible to the consumer.
    expect(body.perChain.unknown).toBeTruthy();
  });
});

describe("GET /api/stats/public — headers", () => {
  it("sets the cache header per spec (60s s-maxage)", async () => {
    const { GET } = await import(ROUTE);
    const res = await GET();
    const cache = res.headers.get("Cache-Control") ?? "";
    expect(cache).toContain("public");
    expect(cache).toMatch(/s-maxage=\d{2,3}/);
    // Allow 60–120s range per the consumer ticket.
    const sMax = Number((cache.match(/s-maxage=(\d+)/) ?? [])[1] ?? 0);
    expect(sMax).toBeGreaterThanOrEqual(60);
    expect(sMax).toBeLessThanOrEqual(120);
  });

  it("sets CORS headers for cross-origin consumers", async () => {
    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toMatch(/GET/);
  });
});

describe("OPTIONS /api/stats/public — browser preflight", () => {
  it("returns 204 with the CORS headers", async () => {
    const { OPTIONS } = await import(ROUTE);
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toMatch(/GET/);
    expect(res.headers.get("Access-Control-Allow-Methods")).toMatch(/OPTIONS/);
  });
});

describe("GET /api/stats/public — fail-soft", () => {
  it("returns 500 stats_unavailable with no internal detail on KV failure", async () => {
    mockKv.keys.mockRejectedValueOnce(new Error("internal KV explosion at /sub:* shard 17"));
    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "stats_unavailable" });
    // Must NOT echo the upstream error message — would leak schema /
    // ops detail.
    expect(JSON.stringify(body)).not.toMatch(/sub:/);
    expect(JSON.stringify(body)).not.toMatch(/shard/);
  });
});

// ── source-grep guards ────────────────────────────────────────────────────────
//
// Lock the privacy + transport invariants in source so they can't drift
// silently. The behavioural tests above exercise correctness; these
// pin the *forbidden surface*.

const routeSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "stats", "public", "route.ts"),
  "utf8",
);

describe("/api/stats/public source guards", () => {
  it("does not import or call subscription helpers", () => {
    // Strip comment lines + block-comment bodies first so doc-comment
    // references to subscription helpers (the file explains *why* it
    // avoids them) don't trip the call-site guard below.
    const code = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Call sites: `getSubscription(...)` / `setSubscription(...)`.
    expect(code).not.toMatch(/\bgetSubscription\s*\(/);
    expect(code).not.toMatch(/\bsetSubscription\s*\(/);
    // Import sites: `import { ..., getSubscription, ... } from ...` or
    // `import getSubscription from ...`.
    expect(code).not.toMatch(/import[\s\S]+?getSubscription[\s\S]+?from/);
    expect(code).not.toMatch(/from\s+["'].*\/auth["']/);
    // The only KV key scan in this file must be relaytx:* — anything
    // else (sub:*, apikey:*, email_to_addr:*, …) would broaden the
    // privacy surface beyond aggregate-only.
    const keyScans = code.match(/kv\.keys\(\s*["'`][^"'`]+["'`]\s*\)/g) ?? [];
    expect(keyScans.length).toBeGreaterThan(0);
    for (const scan of keyScans) {
      expect(scan).toContain("relaytx:");
    }
  });

  it("response schema uses uniquePayers + uniqueRecipients, not uniqueWallets", () => {
    expect(routeSource).toMatch(/uniquePayers/);
    expect(routeSource).toMatch(/uniqueRecipients/);
    expect(routeSource).not.toMatch(/uniqueWallets/);
  });

  it("filters sandbox prefixes", () => {
    expect(routeSource).toMatch(/q402_test_/);
    expect(routeSource).toMatch(/q402_sandbox_/);
  });

  it("sets Cache-Control + CORS headers", () => {
    expect(routeSource).toMatch(/Cache-Control/);
    expect(routeSource).toMatch(/s-maxage=\d+/);
    expect(routeSource).toMatch(/Access-Control-Allow-Origin/);
    expect(routeSource).toMatch(/Access-Control-Allow-Methods/);
  });

  it("does not echo per-row fields back out", () => {
    // The response interface should NOT include any of these tokens —
    // they would mean we're surfacing individual relayed-tx data.
    const ifaceBlock = routeSource.match(
      /interface\s+PublicStats\s*\{[\s\S]+?\n\}/,
    );
    expect(ifaceBlock).toBeTruthy();
    const body = ifaceBlock![0];
    expect(body).not.toMatch(/relayTxHash/);
    expect(body).not.toMatch(/apiKey/);
    expect(body).not.toMatch(/email/);
    expect(body).not.toMatch(/fromUser/);
    expect(body).not.toMatch(/toUser/);
    expect(body).not.toMatch(/address/);
  });

  it("exports both GET and OPTIONS handlers", () => {
    expect(routeSource).toMatch(/export\s+async\s+function\s+GET\b/);
    expect(routeSource).toMatch(/export\s+async\s+function\s+OPTIONS\b/);
  });

  it("error path returns the generic 'stats_unavailable' code only", () => {
    expect(routeSource).toMatch(/error:\s*["']stats_unavailable["']/);
  });
});
