/**
 * ccip-route-shape.test.ts
 *
 * Pin the public-facing shape of the CCIP API surface so a future
 * route-handler change can't silently rename a field that the dashboard
 * or MCP relies on. Static — exercises the route source files directly,
 * not the HTTP layer, so this runs in <50 ms without a live server.
 *
 * Specifically guards:
 *   - /api/ccip/lanes returns: { version, chains, lanes[], feeTokens, feePolicy }
 *   - /api/ccip/quote returns: { fee: { link, native }, recommended }
 *   - /api/ccip/send body has: address, nonce, signature, walletId, src, dst,
 *                              amount, feeToken (literals match server enum)
 *   - LINK chain set is exactly the CCIP triangle (no creeping bnb/mantle/etc.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function readFile(p: string): string {
  return readFileSync(resolve(ROOT, p), "utf8");
}

describe("CCIP API route shape", () => {
  describe("/api/ccip/lanes", () => {
    const src = readFile("app/api/ccip/lanes/route.ts");

    it("returns the five top-level fields the dashboard reads", () => {
      // The dashboard's Bridge banner + (future) modal both depend on these
      // exact keys. A rename here without a coordinated UI bump = dead UI.
      for (const k of ["version", "chains", "lanes", "feeTokens", "feePolicy"]) {
        expect(src).toMatch(new RegExp(`\\b${k}\\b`));
      }
    });

    it("includes senderContract on each lane entry", () => {
      expect(src).toMatch(/senderContract/);
    });
  });

  describe("/api/ccip/quote", () => {
    const src = readFile("app/api/ccip/quote/route.ts");

    it("returns fee object with both link + native sub-objects", () => {
      expect(src).toMatch(/link:\s*\{/);
      expect(src).toMatch(/native:\s*\{/);
    });

    it("each fee object exposes raw + whole + usd fields", () => {
      // Pin the 3-field shape the smoke script asserts on
      expect(src).toMatch(/raw:.*\.toString\(\)/);
      expect(src).toMatch(/whole:/);
      expect(src).toMatch(/usd:/);
    });

    it("returns recommended: 'link' | 'native'", () => {
      expect(src).toMatch(/recommended:\s*feeLinkUsd/);
    });

    it("rejects same src/dst with 400", () => {
      expect(src).toMatch(/src and dst must differ/);
    });
  });

  describe("/api/ccip/send", () => {
    const src = readFile("app/api/ccip/send/route.ts");
    // The bridge execution body lives in the shared runner (extracted
    // 0.8.10 so /api/wallet/agentic/bridge can reuse the same code on
    // Mode C API-key auth). Money-flow assertions read against the
    // runner, not the route, since the route is now a thin auth +
    // validation wrapper.
    const runner = readFile("app/lib/ccip-bridge-runner.ts");

    it("body schema accepts only the documented field set", () => {
      for (const f of ["address", "nonce", "signature", "walletId", "src", "dst", "amount", "feeToken"]) {
        expect(src).toMatch(new RegExp(`\\b${f}\\b`));
      }
    });

    it("uses intent action 'ccip.bridge'", () => {
      expect(src).toMatch(/action:\s*"ccip\.bridge"/);
    });

    it("guards CCIP_SENDER_NOT_DEPLOYED before signing", () => {
      // Without this guard a PENDING_DEPLOY manifest entry would try to call
      // a zero-address contract and the user would see a confusing revert.
      expect(src).toMatch(/CCIP_SENDER_NOT_DEPLOYED/);
    });

    it("checks Gas Tank balance BEFORE submitting on-chain TX", () => {
      // Order matters — checking after submit would let a user with empty
      // Gas Tank still incur (and have to pay for) a tx that we then debit
      // them for. Lives in the runner now.
      const sendIdx = runner.indexOf("executeBridge(");
      const balCheckIdx = runner.indexOf("INSUFFICIENT_LINK_BALANCE");
      expect(balCheckIdx).toBeGreaterThan(0);
      expect(balCheckIdx).toBeLessThan(sendIdx);
    });
  });

  describe("Gas Tank LINK scope (lib/db.ts)", () => {
    const src = readFile("app/lib/db.ts");

    it("LINK chain set is exactly eth/avax/arbitrum", () => {
      // Anti-drift: adding bnb/mantle/etc. to LINK chains would accept LINK
      // deposits we can't actually spend (no CCIP USDC pool on those chains).
      expect(src).toMatch(/CCIP_LINK_CHAINS\s*=\s*\["eth",\s*"avax",\s*"arbitrum"\]/);
    });

    it("addLinkDeposit returns false for non-CCIP chains", () => {
      expect(src).toMatch(/isCCIPLinkChain\(deposit\.chain\)/);
    });
  });

  describe("Q402CCIPSender ABI mirror (lib/ccip.ts)", () => {
    const src = readFile("app/lib/ccip.ts");

    it("SENDER_ABI exposes bridgeFor (facilitator-gated) + quoteFee + poolBalances", () => {
      // bridgeFor(owner, ...) replaced the permissionless bridge() 2026-07-11: the
      // pool pays the CCIP fee, so an open entrypoint let anyone drain it. Only the
      // facilitator (relayer) may now trigger a pool-paid send.
      expect(src).toMatch(/function bridgeFor\(address owner, uint64/);
      expect(src).toMatch(/function quoteFee/);
      expect(src).toMatch(/function poolBalances/);
    });

    it("FEE_TOKEN constants match the contract enum (0=LINK, 1=native)", () => {
      expect(src).toMatch(/FEE_TOKEN_LINK\s*=\s*0/);
      expect(src).toMatch(/FEE_TOKEN_NATIVE\s*=\s*1/);
    });
  });
});
