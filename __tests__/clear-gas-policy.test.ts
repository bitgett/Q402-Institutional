/**
 * clear-gas-policy.test.ts
 *
 * Source-grep guard pinning the unified undelegate (clear-delegation) gas
 * policy across BOTH endpoints + the shared constant + the MCP tool:
 *
 *   Ethereum  → ALWAYS billed to the user's Gas Tank (never sponsored)
 *   all other → ALWAYS sponsored by Q402 ($0 to the user)
 *
 * regardless of wallet mode (A / B / C). The two clear routes must read the
 * same `CLEAR_GAS_TANK_CHAINS` source of truth so the policy can't drift, and
 * the MCP tool must gate on a token-bound consent (not a bare confirm).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function load(...segments: string[]): string {
  return readFileSync(resolve(__dirname, "..", ...segments), "utf8");
}

const EIP7702       = load("app", "lib", "eip7702.ts");
const LOCAL_ROUTE   = load("app", "api", "wallet", "clear-delegation", "route.ts");
const AGENTIC_ROUTE = load("app", "api", "wallet", "agentic", "clear-delegation", "route.ts");
const MCP_CLEAR     = load("mcp-server", "src", "tools", "clear-delegation.ts");

describe("clear-delegation gas policy — single source of truth", () => {
  it("eip7702.ts is the canonical home: CLEAR_GAS_TANK_CHAINS = {eth} only", () => {
    expect(EIP7702).toMatch(/export const CLEAR_GAS_TANK_CHAINS/);
    // eth and ONLY eth — avax / arbitrum are sponsored, not billed.
    expect(EIP7702).toMatch(/new Set<ChainKey>\(\["eth"\]\)/);
  });
  it("neither route redefines the set locally (no drift)", () => {
    expect(LOCAL_ROUTE).not.toMatch(/const CLEAR_GAS_TANK_CHAINS\s*[:=]/);
    expect(AGENTIC_ROUTE).not.toMatch(/const CLEAR_GAS_TANK_CHAINS\s*[:=]/);
  });
  it("both routes import the shared constant from eip7702", () => {
    expect(LOCAL_ROUTE).toMatch(/CLEAR_GAS_TANK_CHAINS/);
    expect(AGENTIC_ROUTE).toMatch(/CLEAR_GAS_TANK_CHAINS/);
  });
});

describe("local clear endpoint (Mode A/B) — eth now bills the Gas Tank", () => {
  it("gates eth on Gas Tank balance with a 402", () => {
    expect(LOCAL_ROUTE).toMatch(/CLEAR_GAS_TANK_CHAINS\.has\(body\.chain\)/);
    expect(LOCAL_ROUTE).toMatch(/getGasBalance\(body\.address\)/);
    expect(LOCAL_ROUTE).toMatch(/INSUFFICIENT_NATIVE_BALANCE/);
  });
  it("debits the actual eth gas after a successful clear (with pending-row fallback)", () => {
    expect(LOCAL_ROUTE).toMatch(/claimAndDebitNativeBridge\(/);
    expect(LOCAL_ROUTE).toMatch(/setPendingClearDebit\(/);
  });
  it("bills the recovered signer's tank (correct for Mode A real EOA)", () => {
    expect(LOCAL_ROUTE).toMatch(/claimAndDebitNativeBridge\(result\.txHash,\s*body\.address\.toLowerCase\(\)/);
  });
});

describe("MCP q402_clear_delegation — token-bound consent + Mode B eth guard", () => {
  it("uses two-phase consentToken, not a bare confirm flag", () => {
    expect(MCP_CLEAR).toMatch(/checkConsent\(/);
    expect(MCP_CLEAR).toMatch(/consentToken/);
    expect(MCP_CLEAR).not.toMatch(/input\.confirm/);
  });
  it("binds the RESOLVED mode + walletId into the consent intent (no preview->execute swap)", () => {
    expect(MCP_CLEAR).toMatch(/action:\s*"clear_delegation"/);
    expect(MCP_CLEAR).toMatch(/mode,/);
    expect(MCP_CLEAR).toMatch(/walletId:\s*resolvedWalletId/);
  });
  it("routes Mode B + eth away from the local endpoint (owner-tank can't be billed)", () => {
    expect(MCP_CLEAR).toMatch(/mode === "agentic-local" && input\.chain === "eth"/);
    expect(MCP_CLEAR).toMatch(/ETH_CLEAR_NEEDS_OWNER_TANK/);
  });
});
