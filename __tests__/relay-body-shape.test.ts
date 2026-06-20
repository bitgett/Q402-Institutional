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
const sendRouteSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "wallet", "agentic", "send", "route.ts"),
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

  it("pay() exposes an x402 rail that routes Base USDC through the EIP-3009 path", () => {
    // pay({ ..., rail: "x402" }) settles via the Coinbase x402 standard
    // (USDC EIP-3009) instead of the default EIP-7702 rail. It is fenced to
    // Base + USDC, guards an EIP-7702-delegated wallet up front, and reuses
    // the chain-generic _payEIP3009 helper (eip3009Nonce, no authorization).
    expect(sdkSource).toMatch(/async\s+pay\s*\(\s*\{[^}]*\brail\b/);
    expect(sdkSource).toMatch(/rail === "x402"/);
    expect(sdkSource).toMatch(/x402 rail is Base USDC only/);
    expect(sdkSource).toMatch(/getCode\(owner\)/);
    expect(sdkSource).toMatch(/return this\._payEIP3009\(/);
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

  it("detects the Base x402 rail by `eip3009Nonce` present + no `authorization`", () => {
    // isBaseEIP3009 routes the relay to the EIP-3009 settlement path. The shape
    // (chain base + eip3009Nonce + NO authorization) is exactly what the client
    // submitToRelay emits for rail:"x402".
    expect(routeSource).toMatch(
      /isBaseEIP3009\s*=\s*chain === "base"\s*&&\s*!!eip3009Nonce\s*&&\s*!authorization/,
    );
    expect(routeSource).toMatch(/isEIP3009\s*=\s*isXLayerEIP3009\s*\|\|\s*isBaseEIP3009/);
  });

  it("rejects an EIP-7702-delegated wallet on the x402 rail (X402_WALLET_DELEGATED)", () => {
    // A q402-delegated wallet (set-code) cannot settle via USDC EIP-3009: the
    // token's SignatureChecker routes code-bearing accounts to ERC-1271, which
    // the Q402 impl does not implement, so it reverts "FiatTokenV2: invalid
    // signature". The guard must reject up front before spending a credit/gas.
    expect(routeSource).toMatch(/X402_WALLET_DELEGATED/);
    // Guard reads the payer's code and rejects anything that is not empty.
    expect(routeSource).toMatch(/getCode\(from\)/);
    expect(routeSource).toMatch(/fromCode\s*!==\s*"0x"/);
  });

  it("the Base x402 pre-check is fail-CLOSED (format check, 503 on RPC fail, 400 on recovery fail)", () => {
    // The pre-check exists to stop a guaranteed on-chain revert from burning a
    // credit + relayer gas, so for x402 it must reject (not fall through) on a
    // malformed signature, an unreadable delegation state, or a recovery error.
    expect(routeSource).toMatch(/\^0x\[0-9a-fA-F\]\{130\}\$/);          // witnessSig 65-byte shape check
    expect(routeSource).toMatch(/X402_DELEGATION_CHECK_UNAVAILABLE/);    // delegation-RPC failure -> 503
    expect(routeSource).toMatch(/EIP-3009 signature could not be verified/); // recovery throw -> 400
  });
});

describe("agentic send idempotency binds the settlement rail", () => {
  it("fingerprint includes the rail so q402 and x402 never share an idempotency slot", () => {
    // On Base the same (to, amount) settles differently under q402 vs x402, so
    // they must not collide on one idempotency slot. Only the non-default x402
    // rail extends the seed (existing q402 fingerprints stay byte-identical).
    expect(sendRouteSource).toMatch(/rail:\s*string/);                       // fingerprint takes rail
    expect(sendRouteSource).toMatch(/rail !== "q402"\s*\?\s*\[`rail:\$\{rail\}`\]/); // conditional seed extension
    expect(sendRouteSource).toMatch(/body\.rail \?\? "q402"/);               // call site passes the rail
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
    // avax/bnb/eth/mantle/injective → "nonce", xlayer → "xlayerNonce", stable → "stableNonce"
    const cases: Array<[string, string]> = [
      ["avax",      '"nonce"'],
      ["bnb",       '"nonce"'],
      ["eth",       '"nonce"'],
      ["mantle",    '"nonce"'],
      ["injective", '"nonce"'],
      ["xlayer",    '"xlayerNonce"'],
      ["stable",    '"stableNonce"'],
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

  it("toAtomicAmount is string-only — Number path + toFixed clamp fully removed", () => {
    // Mirrors public/q402-sdk.js::toRawAmount. Accepting JS Number (even via
    // toFixed(decimals)) would silently preserve IEEE-754 precision loss on
    // 18-decimal tokens — the exact bug the SDK rewrite closed.
    expect(agentSource).toMatch(/function\s+toAtomicAmount\s*\(\s*amount\s*,\s*decimals\s*\)/);
    expect(agentSource).toMatch(/typeof\s+amount\s*!==\s*"string"/);
    // No lingering Number-accepting branch or toFixed-based clamp.
    expect(agentSource).not.toMatch(/typeof\s+amount\s*===\s*"number"/);
    expect(agentSource).not.toMatch(/\.toFixed\s*\(\s*decimals\s*\)/);
    // And the public entry point must take `amount`, not the old `amountUSD`.
    expect(agentSource).toMatch(/async\s+function\s+sendGaslessPayment\s*\(\s*\{[^}]*\bamount\s*\}/);
    expect(agentSource).not.toMatch(/\bamountUSD\b/);
  });
});
