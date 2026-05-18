/**
 * activate-idempotent-replay.test.ts
 *
 * If /api/payment/activate succeeds server-side but the response is lost
 * in transit, the browser retry must NOT return a 402 error — the user
 * already paid AND the credits already landed. The retry should converge
 * on the idempotent success path: 200 + the current subscription state.
 *
 * Earlier revision returned 402 "This transaction has already been used
 * for activation" on the retry path, leaving the user staring at an
 * error while their balance was already topped up.
 *
 * Source-grep guards:
 *   - Phase 1a's `alreadyUsed` branch returns a 200 success (status: "already_active")
 *     when the marker's value matches the calling address.
 *   - Mismatched-address retry still 402s (txHash reuse defense).
 *   - The success-path response includes plan, apiKey, sandboxApiKey, and credits
 *     so the client UI lights up identically to the original (lost) response.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSrc = readFileSync(
  resolve(__dirname, "..", "app", "api", "payment", "activate", "route.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("/api/payment/activate idempotent replay", () => {
  it("does NOT return a bare 402 from the alreadyUsed branch anymore", () => {
    // The OLD pattern: `if (alreadyUsed) { return ... 402 ... }` — a single
    // flat branch. The NEW pattern guards on caller-address match and only
    // 402s when the txHash was claimed by a DIFFERENT address.
    expect(routeSrc).not.toMatch(/if\s*\(alreadyUsed\)\s*\{\s*return\s+NextResponse\.json\(\s*\{\s*error:/);
  });

  it("returns 200 status:'already_active' when the same address retries the same txHash", () => {
    // The success body includes status: "already_active" + idempotentReplay: true
    // so client + server logs can distinguish "this was a retry recovery"
    // from "this was the original activation".
    expect(routeSrc).toMatch(/status:\s*["']already_active["']/);
    expect(routeSrc).toMatch(/idempotentReplay:\s*true/);
  });

  it("compares marker value (claiming address) against current caller before idempotent return", () => {
    // The branch must validate it's the same address, not just "any marker exists".
    expect(routeSrc).toMatch(/alreadyUsed\.toLowerCase\(\)\s*===\s*addr\.toLowerCase\(\)/);
  });

  it("still 402s when the marker's address does NOT match the caller", () => {
    // Defense-in-depth: a different account claiming the same txHash is a
    // misuse case (or a real attack), keep the hard reject.
    expect(routeSrc).toMatch(/TXHASH_ALREADY_USED/);
  });

  it("surfaces plan + apiKey + credits in the idempotent-replay body", () => {
    // The client renders the success card off these fields; missing one
    // would leave the UI half-rendered after a recovered retry.
    const block = routeSrc.match(/idempotentReplay:\s*true[\s\S]{0,300}/);
    expect(block).not.toBeNull();
    expect(routeSrc).toMatch(/plan:\s+currentSub\?\.plan/);
    expect(routeSrc).toMatch(/apiKey:\s+currentSub\?\.apiKey/);
    expect(routeSrc).toMatch(/credits:\s+currentCredits/);
  });
});
