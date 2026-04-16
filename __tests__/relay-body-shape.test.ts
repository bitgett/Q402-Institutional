/**
 * relay-body-shape.test.ts
 *
 * Guards against runtime body-shape drift between the relay server contract
 * (`app/api/relay/route.ts`) and its two canonical client payload builders:
 *
 *   1. public/q402-sdk.js       — browser/dApp SDK (three pay paths)
 *   2. scripts/agent-example.mjs — Node.js agent reference
 *
 * The server body type accepts `token` as the symbol string "USDC" | "USDT"
 * and a chain-specific nonce field: `nonce` (avax/bnb/eth), `xlayerNonce`
 * (xlayer), `stableNonce` (stable). Earlier drift shipped `token` as an
 * address and a single `nonce` field for all chains — that regression is
 * what this file is here to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sdkSource = readFileSync(
  resolve(__dirname, "..", "public", "q402-sdk.js"),
  "utf8"
);
const agentSource = readFileSync(
  resolve(__dirname, "..", "scripts", "agent-example.mjs"),
  "utf8"
);
const routeSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
  "utf8"
);

describe("SDK relay body shape", () => {
  it("avax/bnb/eth path sends `nonce:` (not xlayerNonce/stableNonce)", () => {
    // _payEIP7702 block: contains `nonce:   paymentNonce.toString()`
    expect(sdkSource).toMatch(/_payEIP7702\s*\(/);
    expect(sdkSource).toMatch(/nonce:\s*paymentNonce\.toString\(\)/);
  });

  it("xlayer EIP-7702 path sends `xlayerNonce:`", () => {
    expect(sdkSource).toMatch(/_payXLayerEIP7702\s*\(/);
    expect(sdkSource).toMatch(/xlayerNonce:\s*xlayerNonce\.toString\(\)/);
  });

  it("stable EIP-7702 path sends `stableNonce:`", () => {
    expect(sdkSource).toMatch(/_payStableEIP7702\s*\(/);
    expect(sdkSource).toMatch(/stableNonce:\s*stableNonce\.toString\(\)/);
  });

  it("pay() does not accept paymentId (legacy field removed)", () => {
    expect(sdkSource).not.toMatch(/paymentId/);
  });

  it("pay() destructures `token` as the symbol argument", () => {
    // `async pay({ to, amount, token = "USDC" })`
    expect(sdkSource).toMatch(/async\s+pay\s*\(\s*\{[^}]*\btoken\s*=\s*"USDC"/);
  });
});

describe("relay route server contract", () => {
  it("rejects requests that include a legacy paymentId field", () => {
    // Early 400 guard — the server should explicitly reject the deprecated field
    // so old SDKs surface a clear error instead of silently hashing paymentId.
    expect(routeSource).toMatch(/paymentId is deprecated/);
    expect(routeSource).toMatch(/\(body as \{ paymentId\?: unknown \}\)\.paymentId/);
  });

  it("no longer derives a nonce from paymentId", () => {
    // The old `else if (paymentId)` fallback must be gone; nonce is either the
    // SDK-supplied value or auto-generated from tx context.
    expect(routeSource).not.toMatch(/else if \(paymentId\)/);
    expect(routeSource).not.toMatch(/paymentId\?:\s*string;\s*\/\/ legacy/);
  });
});

describe("agent-example.mjs relay body shape", () => {
  it("submitToRelay sends `token` as the symbol argument, not an address", () => {
    // Body must include `token:    tokenSymbol` — never `token: cfg.token`
    // or `token: tokenAddress`.
    expect(agentSource).toMatch(/token:\s*tokenSymbol/);
    expect(agentSource).not.toMatch(/token:\s*cfg\.token\b/);
    expect(agentSource).not.toMatch(/token:\s*tokenAddress\b(?!,)/); // allow in witness message only
  });

  it("validates the token argument is \"USDC\" or \"USDT\"", () => {
    expect(agentSource).toMatch(/tokenSymbol\s*!==\s*"USDC"\s*&&\s*tokenSymbol\s*!==\s*"USDT"/);
  });

  it("uses chain-specific nonce field via `[cfg.nonceField]`", () => {
    expect(agentSource).toMatch(/\[cfg\.nonceField\]:\s*nonceStr/);
  });

  it("declares the correct nonceField per chain", () => {
    // avax/bnb/eth → "nonce", xlayer → "xlayerNonce", stable → "stableNonce"
    const cases: Array<[string, string]> = [
      ["avax",   '"nonce"'],
      ["bnb",    '"nonce"'],
      ["eth",    '"nonce"'],
      ["xlayer", '"xlayerNonce"'],
      ["stable", '"stableNonce"'],
    ];
    for (const [chain, expected] of cases) {
      // Match the chain's config block up to its `nonceField: "..."` line.
      const re = new RegExp(
        `${chain}:\\s*\\{[\\s\\S]*?nonceField:\\s*${expected}`,
        "m"
      );
      expect(agentSource, `${chain} nonceField should be ${expected}`).toMatch(re);
    }
  });

  it("Stable chain maps both USDC and USDT to the USDT0 address", () => {
    // Both aliases → 0x779ded0c9e1022225f8e0630b35a9b54be713736
    const usdt0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
    const stableBlock = agentSource.match(/stable:\s*\{[\s\S]*?nonceField:\s*"stableNonce"[\s\S]*?\},/);
    expect(stableBlock, "stable block not found").not.toBeNull();
    const block = stableBlock![0].toLowerCase();
    const matches = block.match(new RegExp(usdt0, "g")) ?? [];
    expect(matches.length, "USDT0 address should appear at least twice (USDC + USDT aliases)").toBeGreaterThanOrEqual(2);
  });
});
