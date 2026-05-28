/**
 * stats-public.test.ts
 *
 * Behavioural + source-grep coverage for /api/stats/public.
 *
 * v3 architecture: the route reads precomputed materialized counters
 * via getStatsCounters() — five O(1) KV ops (two GETs, two SCARDs, one
 * HGETALL) against the `stats:counter:*` / `stats:set:*` /
 * `stats:hash:*` namespace. The old per-render SCAN over `relaytx:*`
 * was retired after the 2026-05-27 LRU-eviction incident gutted that
 * source. Sandbox filtering moved upstream to the relay route's
 * incrStatsCounters hook, so this endpoint no longer touches sandbox
 * prefixes itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const counters = {
  settlements: 0,
  volumeUsd: 0 as number | string,
  payers: new Set<string>(),
  recipients: new Set<string>(),
  perChain: {} as Record<string, string | number>,
};

const mockKv = vi.hoisted(() => ({
  get: vi.fn(),
  scard: vi.fn(),
  hgetall: vi.fn(),
}));

vi.mock("@vercel/kv", () => ({ kv: mockKv }));

beforeEach(() => {
  counters.settlements = 0;
  counters.volumeUsd = 0;
  counters.payers = new Set();
  counters.recipients = new Set();
  counters.perChain = {};
  vi.clearAllMocks();

  // Only `stats:counter:*` GETs are allowed — any other key being
  // fetched here would mean a regression that broadened the privacy
  // surface beyond aggregate counters.
  mockKv.get.mockImplementation((key: string) => {
    if (key === "stats:counter:settlements") return Promise.resolve(counters.settlements);
    if (key === "stats:counter:volumeUsd")   return Promise.resolve(counters.volumeUsd);
    throw new Error(`unexpected kv.get key: ${key}`);
  });
  mockKv.scard.mockImplementation((key: string) => {
    if (key === "stats:set:payers")     return Promise.resolve(counters.payers.size);
    if (key === "stats:set:recipients") return Promise.resolve(counters.recipients.size);
    throw new Error(`unexpected kv.scard key: ${key}`);
  });
  mockKv.hgetall.mockImplementation((key: string) => {
    if (key === "stats:hash:perChain") return Promise.resolve(counters.perChain);
    throw new Error(`unexpected kv.hgetall key: ${key}`);
  });
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

  it("surfaces counter values verbatim and rounds volume to cents", async () => {
    counters.settlements = 21183;
    counters.volumeUsd   = 54293.961234;
    counters.payers.add("0xpayer1");
    counters.payers.add("0xpayer2");
    counters.recipients.add("0xr1");
    counters.recipients.add("0xr2");
    counters.recipients.add("0xr3");
    counters.perChain = {
      "bnb:settlements":  21000,
      "bnb:volumeUsd":    "54290.50",
      "eth:settlements":  183,
      "eth:volumeUsd":    "3.46",
    };

    const { GET } = await import(ROUTE);
    const body = await (await GET()).json();

    expect(body.totalSettlements).toBe(21183);
    expect(body.uniquePayers).toBe(2);
    expect(body.uniqueRecipients).toBe(3);
    expect(body.totalVolumeUsd).toBeCloseTo(54293.96, 2);
    expect(body.perChain.bnb).toEqual({ settlements: 21000, volumeUsd: 54290.50 });
    expect(body.perChain.eth).toEqual({ settlements: 183, volumeUsd: 3.46 });
  });

  it("degrades to zero when counters are missing rather than 500ing", async () => {
    mockKv.get.mockResolvedValue(null);
    mockKv.scard.mockResolvedValue(0);
    mockKv.hgetall.mockResolvedValue(null);

    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSettlements).toBe(0);
    expect(body.uniquePayers).toBe(0);
    expect(body.uniqueRecipients).toBe(0);
    expect(body.totalVolumeUsd).toBe(0);
    expect(body.perChain).toEqual({});
  });

  it("ignores malformed hash entries without throwing", async () => {
    counters.settlements = 5;
    counters.perChain = {
      "bnb:settlements":      5,
      "bnb:volumeUsd":        "12.34",
      // Garbage entries that a future migration might leak in
      "no-colon-key":         "ignored",
      "bnb:unknownField":     "ignored",
      "bnb:settlements:extra": "ignored",
    };

    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSettlements).toBe(5);
    expect(body.perChain.bnb).toEqual({ settlements: 5, volumeUsd: 12.34 });
    expect(Object.keys(body.perChain)).toEqual(["bnb"]);
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
    mockKv.get.mockRejectedValueOnce(new Error("internal KV explosion at /sub:* shard 17"));
    const { GET } = await import(ROUTE);
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "stats_unavailable" });
    // Must NOT echo the upstream error message — would leak schema / ops detail.
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

const dbSource = readFileSync(
  resolve(__dirname, "..", "app", "lib", "db.ts"),
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
    expect(code).not.toMatch(/\bgetSubscription\s*\(/);
    expect(code).not.toMatch(/\bsetSubscription\s*\(/);
    expect(code).not.toMatch(/import[\s\S]+?getSubscription[\s\S]+?from/);
    expect(code).not.toMatch(/from\s+["'].*\/auth["']/);
  });

  it("reads the precomputed counters only — no SCAN over arbitrary KV", () => {
    const code = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Aggregate path is materialized — no kv.keys / kv.scan in the route.
    expect(code).not.toMatch(/kv\.keys\(/);
    expect(code).not.toMatch(/kv\.scan\(/);
    // The route delegates to getStatsCounters in db.ts.
    expect(code).toMatch(/getStatsCounters/);
  });

  it("response schema uses uniquePayers + uniqueRecipients, not uniqueWallets", () => {
    expect(routeSource).toMatch(/uniquePayers/);
    expect(routeSource).toMatch(/uniqueRecipients/);
    expect(routeSource).not.toMatch(/uniqueWallets/);
  });

  it("sandbox filter lives upstream in the relay-route hook (not in stats route)", () => {
    // The counters are incremented only on non-sandbox relays — see
    // incrStatsCounters call site in app/api/relay/route.ts. Pinning the
    // filter location here so a future refactor doesn't quietly let
    // sandbox txs leak into the public panel.
    const relaySource = readFileSync(
      resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
      "utf8",
    );
    expect(relaySource).toMatch(/incrStatsCounters/);
    expect(relaySource).toMatch(/!isSandbox/);
  });

  it("sets Cache-Control + CORS headers", () => {
    expect(routeSource).toMatch(/Cache-Control/);
    expect(routeSource).toMatch(/s-maxage=\d+/);
    expect(routeSource).toMatch(/Access-Control-Allow-Origin/);
    expect(routeSource).toMatch(/Access-Control-Allow-Methods/);
  });

  it("counter key prefixes are stable", () => {
    // If these prefixes ever change, the backfill script + the runtime
    // hook + this read path all need to move in lockstep. Lock them
    // here so a partial refactor surfaces as a test failure.
    expect(dbSource).toMatch(/stats:counter:settlements/);
    expect(dbSource).toMatch(/stats:counter:volumeUsd/);
    expect(dbSource).toMatch(/stats:set:payers/);
    expect(dbSource).toMatch(/stats:set:recipients/);
    expect(dbSource).toMatch(/stats:hash:perChain/);
  });
});
