/**
 * agentic-wallet-relay-payload.test.ts
 *
 * Behavioural guard against two relay-payload bugs the source-grep
 * tests would not have caught:
 *
 *   1. `submitToRelay` was forwarding the *human* decimal amount string
 *      ("1.5") while /api/relay parses with `BigInt(amount)` → 0 / throw.
 *      The signed witness uses raw atomic units, so the relay's witness
 *      verification and the agentic signer would silently disagree on
 *      integer amounts and outright fail on decimals.
 *
 *   2. X Layer and Stable both require a chain-specific nonce field
 *      (`xlayerNonce` / `stableNonce`); the previous code only ever
 *      wired the generic `nonce` field, which the relay rejects with
 *      400 "xlayer requires either (authorization + xlayerNonce)…".
 *
 * The fix lives in `app/lib/agentic-wallet-sign.ts::submitToRelay`.
 * Both invariants are now exercised by intercepting `fetch` and
 * inspecting the body the function actually emits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ethers } from "ethers";
import {
  submitToRelay,
  type SignedPayment,
} from "@/app/lib/agentic-wallet-sign";

function buildSignedPayment(overrides: Partial<SignedPayment> = {}): SignedPayment {
  const base: SignedPayment = {
    chain: "bnb",
    token: "USDT",
    fromAddr: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    amount: "1.5",
    // 1.5 USDT on a 18-decimal BNB USDT contract.
    amountRaw: ethers.parseUnits("1.5", 18),
    nonceUint: 12345678901234567890n,
    deadline: 1_900_000_000n,
    witnessSig: ("0xabcd" + "00".repeat(63)) as `0x${string}`,
    authorization: {
      chainId: 56,
      address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      nonce: 0,
      yParity: 0,
      r: ("0x" + "00".repeat(32)) as `0x${string}`,
      s: ("0x" + "00".repeat(32)) as `0x${string}`,
    },
  };
  return { ...base, ...overrides };
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

let captured: CapturedRequest | null;
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = null;
  originalFetch = global.fetch;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    captured = { url, body };
    return new Response(JSON.stringify({ txHash: "0xfake" }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("submitToRelay — amount field", () => {
  it("forwards the raw atomic-unit string, NOT the human decimal", async () => {
    const signed = buildSignedPayment({ amount: "1.5", amountRaw: ethers.parseUnits("1.5", 18) });
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    expect(captured).not.toBeNull();
    expect(captured!.body.amount).toBe(signed.amountRaw.toString());
    expect(captured!.body.amount).not.toBe("1.5");
  });

  it("does not lose integer precision when atomic units exceed Number.MAX_SAFE_INTEGER", async () => {
    // 1,000 USDT at 18 decimals = 1e21 — well past 2^53.
    const huge = ethers.parseUnits("1000", 18);
    const signed = buildSignedPayment({ amount: "1000", amountRaw: huge });
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    expect(captured!.body.amount).toBe(huge.toString());
    expect(captured!.body.amount).toBe("1000000000000000000000");
  });
});

describe("submitToRelay — chain-specific nonce field", () => {
  it("uses `nonce` for BNB Chain", async () => {
    const signed = buildSignedPayment({ chain: "bnb" });
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    expect(captured!.body).toHaveProperty("nonce");
    expect(captured!.body).not.toHaveProperty("xlayerNonce");
    expect(captured!.body).not.toHaveProperty("stableNonce");
  });

  it("uses `xlayerNonce` for X Layer (no generic `nonce` field)", async () => {
    const signed = buildSignedPayment({ chain: "xlayer" });
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    expect(captured!.body).toHaveProperty("xlayerNonce");
    expect(captured!.body).not.toHaveProperty("nonce");
    expect(captured!.body).not.toHaveProperty("stableNonce");
    expect(captured!.body.xlayerNonce).toBe(signed.nonceUint.toString());
  });

  it("uses `stableNonce` for Stable (no generic `nonce` field)", async () => {
    const signed = buildSignedPayment({ chain: "stable" });
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    expect(captured!.body).toHaveProperty("stableNonce");
    expect(captured!.body).not.toHaveProperty("nonce");
    expect(captured!.body).not.toHaveProperty("xlayerNonce");
    expect(captured!.body.stableNonce).toBe(signed.nonceUint.toString());
  });

  it("falls back to generic `nonce` for every other supported chain", async () => {
    const others = ["eth", "avax", "mantle", "injective", "monad", "scroll"] as const;
    for (const c of others) {
      const signed = buildSignedPayment({ chain: c });
      await submitToRelay("https://q402.test", "q402_live_x", signed);
      expect(captured!.body, `chain=${c}`).toHaveProperty("nonce");
      expect(captured!.body, `chain=${c}`).not.toHaveProperty("xlayerNonce");
      expect(captured!.body, `chain=${c}`).not.toHaveProperty("stableNonce");
    }
  });
});

describe("submitToRelay — common fields", () => {
  it("always carries chain, token, from, to, deadline, witnessSig, authorization", async () => {
    const signed = buildSignedPayment();
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    const b = captured!.body;
    expect(b.chain).toBe("bnb");
    expect(b.token).toBe("USDT");
    expect(b.from).toBe(signed.fromAddr);
    expect(b.to).toBe(signed.to);
    expect(b.deadline).toBe(signed.deadline.toString());
    expect(b.witnessSig).toBe(signed.witnessSig);
    expect(b.authorization).toEqual(signed.authorization);
    expect(b.apiKey).toBe("q402_live_x");
  });
});

describe("submitToRelay — x402 (Base USDC EIP-3009) rail", () => {
  // The relay route detects this rail by `eip3009Nonce` present + no
  // `authorization` (isBaseEIP3009 in app/api/relay/route.ts). The body must
  // therefore carry the bytes32 EIP-3009 nonce and OMIT the EIP-7702
  // authorization — emitting both would mis-route to the q402 path.
  function buildX402Payment(overrides: Partial<SignedPayment> = {}): SignedPayment {
    return buildSignedPayment({
      chain: "base",
      token: "USDC",
      amount: "0.001",
      amountRaw: ethers.parseUnits("0.001", 6),
      rail: "x402",
      eip3009Nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      authorization: undefined,
      witnessSig: ("0xfeed" + "00".repeat(63)) as `0x${string}`,
      ...overrides,
    });
  }

  it("carries eip3009Nonce and omits the EIP-7702 authorization", async () => {
    const signed = buildX402Payment();
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    const b = captured!.body;
    expect(b.eip3009Nonce).toBe(signed.eip3009Nonce);
    expect(b).not.toHaveProperty("authorization");
  });

  it("emits no uint256-style nonce field (nonce/xlayerNonce/stableNonce)", async () => {
    const signed = buildX402Payment();
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    const b = captured!.body;
    expect(b).not.toHaveProperty("nonce");
    expect(b).not.toHaveProperty("xlayerNonce");
    expect(b).not.toHaveProperty("stableNonce");
  });

  it("forwards raw atomic amount + the EIP-3009 witnessSig on Base USDC", async () => {
    const signed = buildX402Payment();
    await submitToRelay("https://q402.test", "q402_live_x", signed);
    const b = captured!.body;
    expect(b.chain).toBe("base");
    expect(b.token).toBe("USDC");
    expect(b.amount).toBe(ethers.parseUnits("0.001", 6).toString());
    expect(b.witnessSig).toBe(signed.witnessSig);
  });
});
