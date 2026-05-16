/**
 * api-key-platform-model.test.ts (previously trial-from-binding.test.ts)
 *
 * Locks in the platform-as-billing product model: an API key is the
 * BUILDER's billing/quota account, and `from` is the END USER's wallet
 * — distinct from the key owner's address. The witness signature in the
 * request body is signed by `from`'s EOA, so the server cannot move
 * anyone's funds without their direct authorization regardless of who
 * holds the API key.
 *
 * An earlier revision tried to bind `from === keyRecord.address` (or the
 * email-pseudo's linked wallet) for trial-scoped keys. That broke the
 * platform model — a builder selling Q402 settlements to N customers
 * would need N API keys. We reverted, and this test pins the reversal
 * so a future "fix" doesn't reintroduce the enforcement without
 * deliberately rethinking the product.
 *
 * The real defense against API-key leak is operational (rate limits +
 * quota caps + rotation), not structural — captured in section 4c's
 * doc-block in the route source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CRLF→LF so source-grep regexes work in Windows fresh-clones.
const routeSrc = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("API key is the builder's account, NOT a wallet anchor", () => {
  it("does NOT enforce `from === keyRecord.address` anywhere in relay", () => {
    // A direct equality check on these two lower-cased addresses is the
    // tell-tale signature of the old binding revision. If a refactor
    // reintroduces it, this assertion trips.
    expect(routeSrc).not.toMatch(/fromLc\s*!==\s*ownerAddrLc/);
    expect(routeSrc).not.toMatch(/fromLc\s*===\s*ownerAddrLc/);
  });

  it("does NOT enforce `from === bound wallet` for email-pseudo keys", () => {
    // The bind-index lookup path lived in section 4c; locking the
    // expression-shape out so the lookup can't be reintroduced as an
    // enforcement gate (it's still legitimately used elsewhere for
    // 1:1 uniqueness checks at bind time).
    expect(routeSrc).not.toMatch(/fromLc\s*!==\s*boundWallet\.toLowerCase\(\)/);
  });

  it("does NOT return the TRIAL_FROM_NOT_BOUND error code", () => {
    // The error code itself must be gone — its presence anywhere in the
    // relay route is proof the enforcement is back.
    expect(routeSrc).not.toMatch(/TRIAL_FROM_NOT_BOUND/);
  });

  it("documents the platform-as-billing model in source", () => {
    // The reasoning must be inline in the code so a future contributor
    // doesn't try to "fix" the missing enforcement.
    expect(routeSrc).toMatch(/platform-as-billing/i);
    expect(routeSrc).toMatch(/end[- ]user/i);
  });

  it("relies on rate-limit + quota + rotation as the operational defense", () => {
    // The defense-in-depth must be referenced in source — these are the
    // operational backstops that replace the structural binding.
    expect(routeSrc).toMatch(/Per-API-key rate limit/i);
    expect(routeSrc).toMatch(/rotation/i);
  });
});
