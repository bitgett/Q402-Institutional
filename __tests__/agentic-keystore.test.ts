import { describe, it, expect, beforeEach } from "vitest";

import {
  encrypt,
  decrypt,
  loadMasterKey,
  constantTimeEqualHex,
  _resetMasterKeyCacheForTesting,
} from "@/app/lib/keystore";

// Deterministic 32-byte hex used as the master key in this suite. Never
// reused outside tests.
const TEST_KEY_HEX = "0".repeat(64);

beforeEach(() => {
  process.env.KEY_ENCRYPTION_KEY = TEST_KEY_HEX;
  _resetMasterKeyCacheForTesting();
});

describe("loadMasterKey", () => {
  it("returns ok with a 32-byte buffer for a well-formed hex env", () => {
    const k = loadMasterKey();
    expect(k.ok).toBe(true);
    if (k.ok) {
      expect(k.key.length).toBe(32);
    }
  });

  it("accepts 0x-prefixed hex", () => {
    process.env.KEY_ENCRYPTION_KEY = "0x" + "1".repeat(64);
    _resetMasterKeyCacheForTesting();
    const k = loadMasterKey();
    expect(k.ok).toBe(true);
  });

  it("rejects the placeholder value", () => {
    process.env.KEY_ENCRYPTION_KEY = "replace_with_random_hex_32";
    _resetMasterKeyCacheForTesting();
    const k = loadMasterKey();
    expect(k.ok).toBe(false);
    if (!k.ok) expect(k.reason).toBe("missing");
  });

  it("rejects non-hex input", () => {
    process.env.KEY_ENCRYPTION_KEY = "not-hex-at-all-just-letters";
    _resetMasterKeyCacheForTesting();
    const k = loadMasterKey();
    expect(k.ok).toBe(false);
    if (!k.ok) expect(k.reason).toBe("invalid");
  });

  it("rejects wrong byte length", () => {
    process.env.KEY_ENCRYPTION_KEY = "ab".repeat(16); // 16 bytes, not 32
    _resetMasterKeyCacheForTesting();
    const k = loadMasterKey();
    expect(k.ok).toBe(false);
    if (!k.ok) expect(k.reason).toBe("invalid");
  });

  it("rejects missing env", () => {
    delete process.env.KEY_ENCRYPTION_KEY;
    _resetMasterKeyCacheForTesting();
    const k = loadMasterKey();
    expect(k.ok).toBe(false);
  });
});

describe("encrypt + decrypt round-trip", () => {
  it("recovers the original plaintext", () => {
    const original = "0xabc123def456789abc123def456789abc123def456789abc123def456789abcd";
    const blob = encrypt(original);
    const recovered = decrypt(blob);
    expect(recovered).toBe(original);
  });

  it("recovers a multi-line / unicode plaintext", () => {
    const original = "line1\nline2\n한국어 ✓";
    const blob = encrypt(original);
    expect(decrypt(blob)).toBe(original);
  });

  it("produces a fresh nonce on every call", () => {
    const original = "the same input, twice";
    const a = encrypt(original);
    const b = encrypt(original);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Decryptions still both recover the same plaintext.
    expect(decrypt(a)).toBe(original);
    expect(decrypt(b)).toBe(original);
  });

  it("produces a 12-byte nonce and 16-byte auth tag", () => {
    const blob = encrypt("hello");
    expect(Buffer.from(blob.nonce, "hex").length).toBe(12);
    expect(Buffer.from(blob.tag, "hex").length).toBe(16);
  });
});

describe("decrypt — tamper detection", () => {
  it("throws when the auth tag is wrong", () => {
    const blob = encrypt("payload");
    const bogusTag = "0".repeat(blob.tag.length);
    expect(() => decrypt({ ...blob, tag: bogusTag })).toThrow();
  });

  it("throws when the ciphertext bytes are altered", () => {
    const blob = encrypt("payload");
    const flipped =
      (Number.parseInt(blob.ciphertext[0]!, 16) ^ 0xf).toString(16) +
      blob.ciphertext.slice(1);
    expect(() => decrypt({ ...blob, ciphertext: flipped })).toThrow();
  });

  it("throws on a malformed nonce length", () => {
    const blob = encrypt("payload");
    expect(() => decrypt({ ...blob, nonce: "ab" })).toThrow(/nonce/);
  });

  it("throws on a malformed tag length", () => {
    const blob = encrypt("payload");
    expect(() => decrypt({ ...blob, tag: "ab" })).toThrow(/auth-tag/);
  });

  it("throws when the encryption key changes between encrypt and decrypt", () => {
    const blob = encrypt("payload");
    process.env.KEY_ENCRYPTION_KEY = "f".repeat(64);
    _resetMasterKeyCacheForTesting();
    expect(() => decrypt(blob)).toThrow();
  });
});

describe("encrypt — failure modes", () => {
  it("throws when the master key is missing", () => {
    delete process.env.KEY_ENCRYPTION_KEY;
    _resetMasterKeyCacheForTesting();
    expect(() => encrypt("anything")).toThrow(/master key unavailable/);
  });
});

describe("constantTimeEqualHex", () => {
  it("returns true for identical hex strings of equal length", () => {
    expect(constantTimeEqualHex("deadbeef", "deadbeef")).toBe(true);
  });

  it("returns false for different content of equal length", () => {
    expect(constantTimeEqualHex("deadbeef", "deadbeed")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqualHex("ab", "abcd")).toBe(false);
  });

  it("returns false for invalid hex input", () => {
    expect(constantTimeEqualHex("zzzz", "zzzz")).toBe(false);
  });
});
