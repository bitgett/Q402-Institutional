/**
 * clear-impl-codehash.test.ts
 *
 * Pins the security fix that replaced the local clear endpoint's griefable
 * NAME()-prefix impl check with a bytecode CODEHASH allowlist.
 *
 * The old `isQ402ImplOnChain` trusted `NAME()` — an attacker-controllable
 * contract method — so anyone could deploy a contract whose NAME() returns
 * "Q402 Fake", self-delegate to it, and get Q402 to sponsor clearing the junk
 * delegation. The fix hashes the on-chain bytecode and checks it against a
 * hardcoded allowlist of known Q402 impl codehashes. These guards prevent a
 * silent revert to the vulnerable check and the two implementation footguns
 * the review flagged (empty-code hash; address-deduped collection).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256 } from "ethers";
import { Q402_IMPL_CODEHASHES } from "../app/lib/eip7702";

const SRC = readFileSync(resolve(__dirname, "..", "app", "lib", "eip7702.ts"), "utf8");
const FN = SRC.slice(SRC.indexOf("export async function isQ402ImplOnChain"));
const ROUTE = readFileSync(
  resolve(__dirname, "..", "app", "api", "wallet", "clear-delegation", "route.ts"),
  "utf8",
);

describe("clear-delegation impl recogniser — codehash, not NAME()", () => {
  it("isQ402ImplOnChain no longer calls the attacker-controllable NAME()", () => {
    expect(FN).not.toMatch(/NAME\(\)/);
    expect(FN).toMatch(/getCode\(/);
    expect(FN).toMatch(/keccak256\(/);
    expect(FN).toMatch(/Q402_IMPL_CODEHASHES\.has/);
  });

  it("short-circuits empty/0x code BEFORE the .has() lookup", () => {
    // Without this, keccak256("0x") could enter the set and make every plain
    // or self-destructed EOA match — a grief variant.
    const codeIdx = FN.search(/code === "0x"/);
    const hasIdx = FN.search(/Q402_IMPL_CODEHASHES\.has/);
    expect(codeIdx).toBeGreaterThanOrEqual(0);
    expect(hasIdx).toBeGreaterThan(codeIdx);
  });

  it("the empty-code hash is NOT in the allowlist", () => {
    expect(Q402_IMPL_CODEHASHES.has(keccak256("0x"))).toBe(false);
  });

  it("the allowlist is non-empty with the expected cardinality and shape", () => {
    // 12 current impls + 10 retired (collected per-(chain,address); the same
    // address has distinct bytecode across chains, so address-dedupe would
    // under-collect). Robinhood's codehash added 2026-07-02; the two slippage-
    // bound ERC-4626 yield impls (BNB Lista + BASE Morpho) added 2026-07-10, then
    // their v4 slippage-measured redeploys added 2026-07-10 (v3 kept for wallets
    // delegated during the v3 window).
    expect(Q402_IMPL_CODEHASHES.size).toBe(26);
    for (const h of Q402_IMPL_CODEHASHES) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the local clear route still gates on the codehash fallback", () => {
    expect(ROUTE).toMatch(/isClearableQ402Impl\(body\.chain, state\.impl\)/);
    expect(ROUTE).toMatch(/isQ402ImplOnChain\(body\.chain, state\.impl/);
  });
});
