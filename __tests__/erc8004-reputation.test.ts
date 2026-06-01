/**
 * erc8004-reputation.test.ts
 *
 * Drift guards + behavioural coverage for the ERC-8004 reputation
 * client. The on-chain ABI must stay aligned with the verified
 * BscScan contract, and the ISO-week helper has to round-trip cleanly
 * for the weekly cron's idempotency key.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REPUTATION_ABI,
  REPUTATION_TAG_WEEKLY,
  REPUTATION_NETWORKS,
  buildWeeklyFeedbackHash,
  currentIsoWeek,
  encodeGiveFeedback,
  parseAgentIdTag,
} from "@/app/lib/erc8004-reputation";

describe("REPUTATION_ABI drift guard", () => {
  it("giveFeedback signature matches the verified BscScan ABI", () => {
    const fn = REPUTATION_ABI.find(
      (f) => f.type === "function" && "name" in f && f.name === "giveFeedback",
    );
    expect(fn).toBeDefined();
    if (!fn || fn.type !== "function") throw new Error("not a function");
    const inputTypes = fn.inputs.map((i) => i.type);
    expect(inputTypes).toEqual([
      "uint256",
      "int128",
      "uint8",
      "string",
      "string",
      "string",
      "string",
      "bytes32",
    ]);
  });

  it("getSummary returns (uint64, int128, uint8)", () => {
    const fn = REPUTATION_ABI.find(
      (f) => f.type === "function" && "name" in f && f.name === "getSummary",
    );
    if (!fn || fn.type !== "function") throw new Error("getSummary not a function");
    expect(fn.outputs.map((o) => o.type)).toEqual(["uint64", "int128", "uint8"]);
  });

  it("NewFeedback event keeps the indexed positions (agentId, clientAddress, indexedTag1)", () => {
    const ev = REPUTATION_ABI.find(
      (f) => f.type === "event" && "name" in f && f.name === "NewFeedback",
    );
    if (!ev || ev.type !== "event") throw new Error("event missing");
    const indexedNames = ev.inputs.filter((i) => i.indexed).map((i) => i.name);
    expect(indexedNames).toEqual(["agentId", "clientAddress", "indexedTag1"]);
  });
});

describe("REPUTATION_NETWORKS", () => {
  it("BSC mainnet registry is the canonical 0x8004BAa1… proxy", () => {
    expect(REPUTATION_NETWORKS.bsc.registry).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(REPUTATION_NETWORKS.bsc.chainId).toBe(56);
  });
});

describe("REPUTATION_TAG_WEEKLY", () => {
  it("is the stable 'q402-weekly' string the cron + 8004scan filter on", () => {
    expect(REPUTATION_TAG_WEEKLY).toBe("q402-weekly");
  });
});

describe("buildWeeklyFeedbackHash", () => {
  it("is deterministic per (agentId, isoWeek) tuple", () => {
    const a = buildWeeklyFeedbackHash(124025n, "2026-W22");
    const b = buildWeeklyFeedbackHash(124025n, "2026-W22");
    expect(a).toBe(b);
  });

  it("differs across weeks for the same agent (dedup key shifts each cycle)", () => {
    const w22 = buildWeeklyFeedbackHash(124025n, "2026-W22");
    const w23 = buildWeeklyFeedbackHash(124025n, "2026-W23");
    expect(w22).not.toBe(w23);
  });

  it("differs across agents in the same week", () => {
    const a = buildWeeklyFeedbackHash(124025n, "2026-W22");
    const b = buildWeeklyFeedbackHash(124026n, "2026-W22");
    expect(a).not.toBe(b);
  });

  it("emits 0x-prefixed 32-byte hex (keccak256 shape)", () => {
    const h = buildWeeklyFeedbackHash(124025n, "2026-W22");
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("currentIsoWeek", () => {
  it("returns YYYY-Www shape", () => {
    expect(currentIsoWeek()).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("rolls correctly across week boundaries (Sunday → Monday)", () => {
    // 2026-01-04 is a Sunday → still ISO week 1.
    // 2026-01-05 is the Monday → ISO week 2.
    expect(currentIsoWeek(new Date(Date.UTC(2026, 0, 4)))).toBe("2026-W01");
    expect(currentIsoWeek(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-W02");
  });

  it("treats January 1 of a Thursday-start year as W01", () => {
    // 2026-01-01 is a Thursday → ISO 8601 W01 anchor.
    expect(currentIsoWeek(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-W01");
  });
});

describe("encodeGiveFeedback", () => {
  it("encodes a valid calldata blob (0x + function selector + args)", () => {
    const calldata = encodeGiveFeedback({
      agentId: 124025n,
      settlements7d: 7,
      isoWeek: "2026-W22",
      endpoint: "https://q402.quackai.ai/api/relay/info",
      feedbackURI: "",
    });
    expect(calldata).toMatch(/^0x[0-9a-f]+$/);
    // 4-byte selector + 8 ABI-encoded args = at least 4 + 8*32 = 260 bytes
    // (strings + bytes32 stretch this further). Sanity bound only.
    expect(calldata.length).toBeGreaterThan(260);
  });

  it("uses the 'q402-weekly' tag1 + 'bsc' tag2 namespace", () => {
    const calldata = encodeGiveFeedback({
      agentId: 1n,
      settlements7d: 0,
      isoWeek: "2026-W22",
      endpoint: "x",
    });
    // Strings are length-prefixed ABI-encoded, so we just check the literal
    // bytes are present somewhere in the calldata.
    const hex = calldata.toLowerCase();
    const weekly = Buffer.from("q402-weekly", "utf8").toString("hex");
    const bsc = Buffer.from("bsc", "utf8").toString("hex");
    expect(hex).toContain(weekly);
    expect(hex).toContain(bsc);
  });

  it("rejects out-of-range settlements7d", () => {
    expect(() =>
      encodeGiveFeedback({
        agentId: 1n,
        settlements7d: -1,
        isoWeek: "2026-W22",
        endpoint: "x",
      }),
    ).toThrow(/out of range/);
  });
});

describe("parseAgentIdTag", () => {
  it("parses the canonical `{network}:{agentId}` tag", () => {
    expect(parseAgentIdTag("bsc:124025")).toBe(124025n);
    expect(parseAgentIdTag("eth:1")).toBe(1n);
  });

  it("parses the legacy bare-numeric form", () => {
    expect(parseAgentIdTag("124025")).toBe(124025n);
  });

  it("returns null for non-numeric or malformed input", () => {
    expect(parseAgentIdTag("bsc:abc")).toBeNull();
    expect(parseAgentIdTag("bsc:")).toBeNull();
    expect(parseAgentIdTag("")).toBeNull();
    expect(parseAgentIdTag(null)).toBeNull();
    expect(parseAgentIdTag(undefined)).toBeNull();
    expect(parseAgentIdTag("not-a-tag")).toBeNull();
  });

  it("never throws on caller-controlled tag (no BigInt explosion)", () => {
    // The bug this helper exists to prevent: `BigInt("bsc:12345")` throws.
    expect(() => parseAgentIdTag("bsc:12345")).not.toThrow();
  });
});

describe("readReputationSummary tag handling — drift guard", () => {
  // We can't run readReputationSummary in unit tests (it hits BSC RPC
  // + Vercel KV), but we can pin the call-site shape that determines
  // whether the dashboard/MCP ever see reputation for graduated
  // wallets. The bug this guards against: callers pass
  // `record.erc8004AgentId` which is `{network}:{agentId}` shaped,
  // but the function used to do `/^\d+$/.test(...)` and return null,
  // so reputation was silently empty in production UIs.
  const src = readFileSync(
    resolve(__dirname, "..", "app", "lib", "erc8004-reputation.ts"),
    "utf8",
  );

  it("accepts the {network}:{agentId} tag via parseAgentIdTag", () => {
    // The function body should call parseAgentIdTag to normalise its
    // input, not raw /^\d+$/ which would reject "bsc:124025".
    const fnIdx = src.indexOf("export async function readReputationSummary");
    const closingIdx = src.indexOf("\nexport ", fnIdx + 1);
    const body = src.slice(fnIdx, closingIdx > -1 ? closingIdx : undefined);
    expect(body).toMatch(/parseAgentIdTag/);
  });

  it("does NOT gate readReputationSummary on /^\\d+$/ regex", () => {
    // Negative — if this assertion ever fires, the tag-rejecting bug
    // has regressed.
    const fnIdx = src.indexOf("export async function readReputationSummary");
    const closingIdx = src.indexOf("\nexport ", fnIdx + 1);
    const body = src.slice(fnIdx, closingIdx > -1 ? closingIdx : undefined);
    expect(body).not.toMatch(/\/\^\\d\+\$\/\.test\(agentIdStr\)/);
  });
});

describe("reputation-weekly route — shape guards", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "app", "api", "cron", "reputation-weekly", "route.ts"),
    "utf8",
  );

  it("registers cron auth (not a public endpoint)", () => {
    expect(src).toMatch(/requireCronAuth/);
  });

  it("uses ISO-week ledger key for idempotent reruns", () => {
    expect(src).toMatch(/aw:rep-week:/);
  });

  it("skips agents with zero active days (don't waste gas on inactive)", () => {
    expect(src).toMatch(/activeDays === 0/);
  });

  it("persists ledger AFTER every successful fire (mid-run crash safety)", () => {
    // Look for kv.set(ledgerKey, ledger) inside the fire loop.
    expect(src).toMatch(/await kv\.set\(ledgerKey, ledger\)/);
  });

  it("parses the stored erc8004AgentId tag before BigInt-ing", () => {
    expect(src).toMatch(/parseAgentIdTag/);
  });

  it("clamps REPUTATION_TOP_N env to a sane band", () => {
    expect(src).toMatch(/resolveTopN/);
    expect(src).toMatch(/TOP_N_MAX/);
  });

  it("publishes outcome to cron-status so admin dashboard surfaces it", () => {
    expect(src).toMatch(/recordCronStatus\(CRON_NAMES\.REPUTATION_WEEKLY/);
  });

  it("records cron-status `error` on aborted runs (not just success)", () => {
    // The whole GET body lives in a try/catch — error path also feeds
    // recordCronStatus so operators see WHY the run died, not just a
    // stale timestamp.
    expect(src).toMatch(/lastStatus:\s*"error"/);
  });

  it("pre-claims each agent via SET NX before firing the on-chain tx", () => {
    // Without per-agent claim, a tx that confirms on-chain but whose
    // post-fire ledger write dies would let the next run re-fire.
    expect(src).toMatch(/weekClaimKey/);
    expect(src).toMatch(/nx:\s*true/);
  });

  it("releases the claim on tx failure so a retry can happen later", () => {
    expect(src).toMatch(/kv\.del\(claimKey\)/);
  });
});

describe("reputation-smoke route — shape guards", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "app", "api", "cron", "reputation-smoke", "route.ts"),
    "utf8",
  );

  it("requires ADMIN_SECRET (NOT the shared CRON_SECRET)", () => {
    // CRON_SECRET is shared with the Render heartbeat driver. Smoke
    // fires real BSC tx against an operator-supplied agentId — must
    // use the narrower ADMIN_SECRET surface instead.
    expect(src).toMatch(/ADMIN_SECRET/);
    expect(src).not.toMatch(/requireCronAuth/);
  });

  it("uses constant-time comparison for the admin key", () => {
    expect(src).toMatch(/timingSafeEqual/);
  });

  it("validates agentId is a positive integer", () => {
    expect(src).toMatch(/\\d\+/);
  });

  it("clamps activeDays to 0..7", () => {
    expect(src).toMatch(/activeDays.*0.*7/);
  });

  it("rejects fires for agentIds not owned by a Q402 wallet", () => {
    // The misuse fence: ADMIN_SECRET leak should not let the holder
    // publish opinions about non-Q402 agents.
    expect(src).toMatch(/AGENT_NOT_OWNED/);
    expect(src).toMatch(/agentIdExistsInKv/);
  });
});
