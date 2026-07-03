import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  redstoneEnabled,
  redstonePrice,
  redstoneConfig,
  RedStoneError,
  __clearRedstoneCache,
  __test,
} from "@/app/lib/redstone";

// These tests exercise the reader's NETWORK-FREE fail-closed branches (disabled,
// not-allowlisted) and its pure config parsing. The signature-verification /
// gateway path is covered live in the read-only reader check, not here (no
// network in unit tests).

const ENV_KEYS = [
  "REDSTONE_ENABLED",
  "REDSTONE_ALLOWED_FEEDS",
  "REDSTONE_DATA_SERVICE_ID",
  "REDSTONE_UNIQUE_SIGNERS",
  "REDSTONE_STALE_AFTER_SEC",
  "REDSTONE_BAND_ETH",
  "REDSTONE_GATEWAYS",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  __clearRedstoneCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __clearRedstoneCache();
});

describe("redstoneEnabled", () => {
  it("is false when unset", () => {
    expect(redstoneEnabled()).toBe(false);
  });
  it("is true only for exactly '1'", () => {
    process.env.REDSTONE_ENABLED = "1";
    expect(redstoneEnabled()).toBe(true);
    process.env.REDSTONE_ENABLED = "true";
    expect(redstoneEnabled()).toBe(false);
    process.env.REDSTONE_ENABLED = "0";
    expect(redstoneEnabled()).toBe(false);
  });
});

describe("redstonePrice fail-closed (network-free branches)", () => {
  it("throws when the feature is disabled", async () => {
    await expect(redstonePrice("ETH")).rejects.toBeInstanceOf(RedStoneError);
  });

  it("throws when the feed is not allowlisted (enabled, empty allowlist)", async () => {
    process.env.REDSTONE_ENABLED = "1";
    // No REDSTONE_ALLOWED_FEEDS ⇒ empty set ⇒ nothing readable.
    await expect(redstonePrice("ETH")).rejects.toThrow(/not allowlisted/i);
  });

  it("throws when the feed is not in a non-empty allowlist", async () => {
    process.env.REDSTONE_ENABLED = "1";
    process.env.REDSTONE_ALLOWED_FEEDS = "BTC,SOL";
    await expect(redstonePrice("ETH")).rejects.toThrow(/not allowlisted/i);
  });

  it("throws on an empty feed id", async () => {
    process.env.REDSTONE_ENABLED = "1";
    process.env.REDSTONE_ALLOWED_FEEDS = "ETH";
    await expect(redstonePrice("   ")).rejects.toBeInstanceOf(RedStoneError);
  });
});

describe("allowedFeeds parsing", () => {
  it("returns empty set when unset (fail closed)", () => {
    expect(__test.allowedFeeds().size).toBe(0);
  });
  it("uppercases + trims + drops blanks", () => {
    process.env.REDSTONE_ALLOWED_FEEDS = " eth , btc ,,sol ";
    const s = __test.allowedFeeds();
    expect([...s].sort()).toEqual(["BTC", "ETH", "SOL"]);
  });
});

describe("bandFor parsing", () => {
  it("returns null when no band env is set", () => {
    expect(__test.bandFor("ETH")).toBeNull();
  });
  it("parses min:max", () => {
    process.env.REDSTONE_BAND_ETH = "100:100000";
    expect(__test.bandFor("ETH")).toEqual({ min: 100, max: 100000 });
  });
  it("throws on inverted / malformed band", () => {
    process.env.REDSTONE_BAND_ETH = "100:50";
    expect(() => __test.bandFor("ETH")).toThrow(RedStoneError);
    process.env.REDSTONE_BAND_ETH = "abc:def";
    expect(() => __test.bandFor("ETH")).toThrow(RedStoneError);
  });
});

describe("uniqueSignersRequired / staleAfterSec defaults", () => {
  it("defaults to 2 signers, 180s staleness", () => {
    expect(__test.uniqueSignersRequired()).toBe(2);
    expect(__test.staleAfterSec()).toBe(180);
  });
  it("honours valid overrides, ignores garbage", () => {
    process.env.REDSTONE_UNIQUE_SIGNERS = "3";
    process.env.REDSTONE_STALE_AFTER_SEC = "60";
    expect(__test.uniqueSignersRequired()).toBe(3);
    expect(__test.staleAfterSec()).toBe(60);
    process.env.REDSTONE_UNIQUE_SIGNERS = "0"; // < 1 ⇒ default
    expect(__test.uniqueSignersRequired()).toBe(2);
    process.env.REDSTONE_STALE_AFTER_SEC = "-5"; // ≤ 0 ⇒ default
    expect(__test.staleAfterSec()).toBe(180);
  });
});

describe("redstoneConfig (discovery, never throws)", () => {
  it("reflects env", () => {
    process.env.REDSTONE_ENABLED = "1";
    process.env.REDSTONE_ALLOWED_FEEDS = "ETH,BTC";
    const c = redstoneConfig();
    expect(c.enabled).toBe(true);
    expect(c.allowedFeeds.sort()).toEqual(["BTC", "ETH"]);
    expect(c.dataServiceId).toBe("redstone-primary-prod");
    expect(c.uniqueSigners).toBe(2);
    expect(c.staleAfterSec).toBe(180);
  });
});
