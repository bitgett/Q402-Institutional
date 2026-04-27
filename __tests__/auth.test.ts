import { describe, it, expect, vi } from "vitest";

// Mock @vercel/kv so auth.ts can be imported without a real Redis connection.
vi.mock("@vercel/kv", () => ({
  kv: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    ttl: vi.fn(),
  },
}));

// Import AFTER mock is registered.
import { buildAuthMessage, buildChallengeMessage } from "@/app/lib/auth";

// ── buildAuthMessage ───────────────────────────────────────────────────────────

describe("buildAuthMessage", () => {
  it("produces the expected format", () => {
    const msg = buildAuthMessage("0xABCDEF", "abc123");
    expect(msg).toBe(
      "Q402 Institutional\nSign in to prove wallet ownership.\n\nAddress: 0xabcdef\nNonce: abc123",
    );
  });

  it("lowercases the address", () => {
    const msg = buildAuthMessage("0xFC77FF29178B7286A8BA703D7A70895CA74FF466", "nonce");
    expect(msg).toContain("Address: 0xfc77ff29178b7286a8ba703d7a70895ca74ff466");
  });

  it("preserves the nonce exactly", () => {
    const nonce = "a1b2c3d4e5f60011";
    const msg = buildAuthMessage("0x1234", nonce);
    expect(msg).toContain(`Nonce: ${nonce}`);
  });

  it("starts with the Q402 Institutional brand", () => {
    expect(buildAuthMessage("0x1", "n")).toMatch(/^Q402 Institutional\n/);
  });
});

// ── buildChallengeMessage ──────────────────────────────────────────────────────

describe("buildChallengeMessage", () => {
  it("produces the expected format", () => {
    const msg = buildChallengeMessage("0xABCDEF", "deadbeef");
    expect(msg).toBe(
      "Q402 Institutional\nAuthorize sensitive action (key rotation / payment activation).\n\nAddress: 0xabcdef\nChallenge: deadbeef",
    );
  });

  it("lowercases the address", () => {
    const msg = buildChallengeMessage("0xFC77FF29", "challenge");
    expect(msg).toContain("Address: 0xfc77ff29");
  });

  it("starts with the Q402 Institutional brand", () => {
    expect(buildChallengeMessage("0x1", "c")).toMatch(/^Q402 Institutional\n/);
  });

  it("auth and challenge messages are distinct for identical inputs", () => {
    const addr = "0x1234";
    const token = "token123";
    const auth = buildAuthMessage(addr, token);
    const challenge = buildChallengeMessage(addr, token);
    expect(auth).not.toBe(challenge);
    expect(auth).toContain("prove wallet ownership");
    expect(challenge).toContain("Authorize sensitive action");
  });
});
