/**
 * x402-rail-sign.test.ts
 *
 * Guards the client half of the Base x402 rail (app/lib/agentic-wallet-sign.ts
 * ::signAgenticPayment with rail:"x402"). The rail signs an EIP-3009
 * TransferWithAuthorization against USDC's OWN EIP-712 domain (name "USD Coin",
 * version "2") rather than the Q402 EIP-7702 TransferAuthorization witness.
 *
 * The on-chain proof (basescan tx 0x75c6d3a8…) confirmed the live relay path;
 * these offline assertions lock the signing invariants that made it work:
 *   1. the signature recovers to the wallet under the pinned USDC domain, so the
 *      USDC contract's own verification will accept it;
 *   2. the result carries rail "x402" + a bytes32 EIP-3009 nonce and NO EIP-7702
 *      authorization (the relay detects the rail by exactly that shape);
 *   3. the rail is fenced to Base + USDC (X402_BASE_USDC_ONLY otherwise).
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import { signAgenticPayment, AGENTIC_CHAINS } from "@/app/lib/agentic-wallet-sign";

// Well-known deterministic test key (hardhat account #1). No real funds.
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ADDR = privateKeyToAccount(PK).address;
const TO = "0x3C528161f34ddEAB0b71Aede21ae42535E140abE";
const FACILITATOR = "0xfc77FF29178B7286A8bA703D7a70895CA74fF466";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function baseX402Params(overrides: Record<string, unknown> = {}) {
  return {
    privateKey: PK,
    expectedOwner: ADDR,
    chain: "base",
    token: "USDC",
    to: TO,
    amount: "0.001",
    facilitator: FACILITATOR,
    rail: "x402",
    ...overrides,
  } as Parameters<typeof signAgenticPayment>[0];
}

describe("signAgenticPayment — x402 (Base USDC EIP-3009) rail", () => {
  it("returns rail x402 + a bytes32 eip3009Nonce and omits the EIP-7702 authorization", async () => {
    const signed = await signAgenticPayment(baseX402Params());
    expect(signed.rail).toBe("x402");
    expect(signed.eip3009Nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(signed.authorization).toBeUndefined();
  });

  it("signs an EIP-3009 authorization the USDC domain recovers to the wallet", async () => {
    const signed = await signAgenticPayment(baseX402Params());
    const tokenCfg = AGENTIC_CHAINS.base.tokens.USDC;
    const recovered = ethers.verifyTypedData(
      {
        name: "USD Coin",
        version: "2",
        chainId: AGENTIC_CHAINS.base.id,
        verifyingContract: tokenCfg.address,
      },
      EIP3009_TYPES,
      {
        from: ADDR,
        to: TO,
        value: ethers.parseUnits("0.001", 6),
        validAfter: 0n,
        validBefore: signed.deadline,
        nonce: signed.eip3009Nonce!,
      },
      signed.witnessSig,
    );
    expect(recovered.toLowerCase()).toBe(ADDR.toLowerCase());
  });

  it("signs the raw 6-decimal USDC amount (not a re-scaled value)", async () => {
    const signed = await signAgenticPayment(baseX402Params({ amount: "2.5" }));
    expect(signed.amountRaw).toBe(ethers.parseUnits("2.5", 6));
  });

  it("rejects the x402 rail on a non-Base chain", async () => {
    await expect(
      signAgenticPayment(baseX402Params({ chain: "bnb", token: "USDT" })),
    ).rejects.toThrow("X402_BASE_USDC_ONLY");
  });

  it("rejects the x402 rail on a non-USDC token", async () => {
    await expect(
      signAgenticPayment(baseX402Params({ token: "USDT" })),
    ).rejects.toThrow("X402_BASE_USDC_ONLY");
  });

  it("still signs the Q402 EIP-7702 rail (authorization present) on Base by default", async () => {
    // authorizationNonce supplied so the default rail signs fully offline
    // (skips the getTransactionCount RPC call).
    const signed = await signAgenticPayment(baseX402Params({ rail: undefined, authorizationNonce: 0 }));
    expect(signed.rail).not.toBe("x402");
    expect(signed.authorization).toBeDefined();
    expect(signed.eip3009Nonce).toBeUndefined();
  });
});
