/**
 * Unit tests for app/lib/eip7702 — the security-critical helpers that
 * back POST /api/wallet/clear-delegation. The route's invariants
 * (signer-must-match, impl-must-be-Q402, cleared:false→422) collapse
 * the moment any of these helpers regress, so they get focused tests
 * here instead of buried inside a heavily-mocked HTTP test.
 *
 * Coverage:
 *   - recoverAuthorizationAddress round-trips ethers v6's
 *     `wallet.authorize()` — confirms our custom MAGIC || rlp(...) +
 *     ECDSA recovery matches the canonical signing path.
 *   - isOfficialQ402Impl matches the manifest's per-chain address and
 *     rejects anything else.
 *   - parseCodeAsDelegation handles the three eth_getCode shapes
 *     (empty, 7702 prefix, contract bytecode).
 */

import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import {
  recoverAuthorizationAddress,
  isOfficialQ402Impl,
  parseCodeAsDelegation,
  Q402_IMPL_PER_CHAIN,
  CHAIN_IDS,
  type SignedAuthorization,
} from "@/app/lib/eip7702";

// Deterministic test key — never used on mainnet. Address derived once.
const TEST_PK   = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const TEST_ADDR = new Wallet(TEST_PK).address; // 0x...

describe("recoverAuthorizationAddress", () => {
  it("round-trips a real ethers.Wallet authorize() — clear-style (address=0x0)", async () => {
    const wallet = new Wallet(TEST_PK);
    const auth   = await wallet.authorize({
      chainId: 56,
      address: "0x0000000000000000000000000000000000000000",
      nonce:   42,
    });

    const signed: SignedAuthorization = {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce:   Number(auth.nonce),
      yParity: auth.signature.yParity as 0 | 1,
      r:       auth.signature.r,
      s:       auth.signature.s,
    };

    const recovered = recoverAuthorizationAddress(signed);
    expect(recovered.toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });

  it("round-trips an authorize() for a non-zero delegate address", async () => {
    const wallet = new Wallet(TEST_PK);
    const auth   = await wallet.authorize({
      chainId: 1,
      address: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa", // Q402 BNB impl (any addr is fine)
      nonce:   0,
    });

    const signed: SignedAuthorization = {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce:   Number(auth.nonce),
      yParity: auth.signature.yParity as 0 | 1,
      r:       auth.signature.r,
      s:       auth.signature.s,
    };

    expect(recoverAuthorizationAddress(signed).toLowerCase()).toBe(TEST_ADDR.toLowerCase());
  });

  it("rejects a tampered signature — either throws or recovers a different address", async () => {
    const wallet = new Wallet(TEST_PK);
    const auth   = await wallet.authorize({
      chainId: 56,
      address: "0x0000000000000000000000000000000000000000",
      nonce:   1,
    });

    // Flip one nibble of the signature triple. Depending on which value we
    // flip, the resulting point may or may not be on the curve — either
    // outcome (throw OR recover to a different address) is security-correct,
    // because the route handler catches the throw as INVALID_AUTHORIZATION_
    // SIGNATURE and the mismatch as AUTHORIZATION_SIGNER_MISMATCH.
    const tamperedS =
      auth.signature.s.slice(0, -1) +
      (parseInt(auth.signature.s.slice(-1), 16) ^ 1).toString(16);

    const signed: SignedAuthorization = {
      chainId: Number(auth.chainId),
      address: auth.address,
      nonce:   Number(auth.nonce),
      yParity: auth.signature.yParity as 0 | 1,
      r:       auth.signature.r,
      s:       tamperedS,
    };

    try {
      const recovered = recoverAuthorizationAddress(signed);
      expect(recovered.toLowerCase()).not.toBe(TEST_ADDR.toLowerCase());
    } catch (e) {
      // Off-curve / malformed sig — recoverAddress throws. Route handler
      // catches this and returns 400 INVALID_AUTHORIZATION_SIGNATURE.
      expect(e).toBeInstanceOf(Error);
    }
  });
});

describe("isOfficialQ402Impl", () => {
  it("returns true for the canonical impl address on each chain", () => {
    for (const [chain, expected] of Object.entries(Q402_IMPL_PER_CHAIN)) {
      // Case-insensitive — manifest is mixed-case, our constants lowercase.
      expect(isOfficialQ402Impl(chain as keyof typeof Q402_IMPL_PER_CHAIN, expected)).toBe(true);
      expect(isOfficialQ402Impl(chain as keyof typeof Q402_IMPL_PER_CHAIN, expected.toUpperCase())).toBe(true);
    }
  });

  it("rejects an address that doesn't match the chain's impl", () => {
    // BNB impl pasted under the AVAX chain key — wrong combo.
    expect(isOfficialQ402Impl("avax", Q402_IMPL_PER_CHAIN.bnb)).toBe(false);
  });

  it("rejects undefined / empty / random address", () => {
    expect(isOfficialQ402Impl("bnb", undefined)).toBe(false);
    expect(isOfficialQ402Impl("bnb", "")).toBe(false);
    expect(isOfficialQ402Impl("bnb", "0x0000000000000000000000000000000000000000")).toBe(false);
  });

  it("CHAIN_IDS and Q402_IMPL_PER_CHAIN cover the same 10 chains", () => {
    expect(Object.keys(CHAIN_IDS).sort()).toEqual(Object.keys(Q402_IMPL_PER_CHAIN).sort());
  });
});

describe("parseCodeAsDelegation", () => {
  it("flags 0x as not delegated", () => {
    expect(parseCodeAsDelegation("0x")).toEqual({ delegated: false });
  });

  it("extracts the impl address from an EIP-7702 prefix code", () => {
    // 0xef0100 + 20-byte impl = 7702 delegation marker
    const impl = "0x6cF4aD62C208b6494a55a1494D497713ba013dFa";
    const code = "0xef0100" + impl.slice(2).toLowerCase();
    const parsed = parseCodeAsDelegation(code);
    expect(parsed.delegated).toBe(true);
    expect(parsed.impl?.toLowerCase()).toBe(impl.toLowerCase());
  });

  it("treats unrecognised bytecode (contract account) as not delegated", () => {
    // Some random non-EIP-7702 bytecode — we don't claim it's delegated.
    expect(parseCodeAsDelegation("0x608060405260043610")).toEqual({ delegated: false });
  });

  it("ignores malformed EIP-7702 prefix that doesn't contain a full 20-byte impl", () => {
    // 0xef0100 with only 5 bytes after — not a valid delegation marker.
    expect(parseCodeAsDelegation("0xef01001234567890")).toEqual({ delegated: false });
  });
});
