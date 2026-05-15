/**
 * eip7702-authorization-signing.test.ts
 *
 * The EVM evaluates EIP-7702 authorization tuples by ecrecovering the
 * signature against `keccak256(0x05 || rlp([chainId, address, nonce]))`.
 * An earlier revision of both the browser SDK and the MCP Node client
 * signed an EIP-712 typed-data digest with a custom domain instead —
 * the EVM recovered a different address, marked the authorization
 * invalid, and the EOA's delegation code was never installed. Txs
 * still landed as `status: success` because authorizationList failures
 * don't fail the parent tx — they just silently no-op the delegation.
 *
 * Result: every first-time-binding wallet on the trial flow appeared
 * to settle without moving any tokens. Already-delegated wallets
 * accidentally worked because their EOA code was set on a previous,
 * correctly-signed authorization.
 *
 * This test pins the fix in place: both signing paths must use
 * `wallet.authorize(...)` (ethers v6.16+'s native EIP-7702 helper),
 * which produces the spec-correct signature. A regression that
 * re-introduces signTypedData over a custom "EIP7702Authorization"
 * domain will fail this test even though the dev tx might still
 * appear to settle on a stale local wallet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const browserSdkSource = readFileSync(
  resolve(ROOT, "public", "q402-sdk.js"),
  "utf8",
);
const mcpClientSource = readFileSync(
  resolve(ROOT, "mcp-server", "src", "client.ts"),
  "utf8",
);

function extractFn(src: string, fnNamePattern: RegExp): string | null {
  const m = src.match(fnNamePattern);
  return m ? m[0] : null;
}

describe("EIP-7702 authorization signing — protocol-spec, not EIP-712", () => {
  describe("browser SDK (public/q402-sdk.js)", () => {
    const fn = extractFn(
      browserSdkSource,
      /async\s+_signAuthorization\s*\([^)]*\)\s*\{[\s\S]*?\n\s{2}\}/,
    );

    it("the helper exists and is async", () => {
      expect(fn).toBeTruthy();
    });

    it("delegates to signer.authorize (ethers v6.16+ EIP-7702 native helper)", () => {
      expect(fn!).toMatch(/signer\.authorize\(\s*\{\s*chainId,\s*address,\s*nonce\s*\}\s*\)/);
    });

    it("does NOT use signTypedData (the regressed EIP-712 path)", () => {
      expect(fn!).not.toMatch(/signTypedData/);
    });

    it("does NOT reference the custom EIP-712 domain name 'EIP7702Authorization'", () => {
      // The string can still appear in other parts of the file (commit
      // history, doc comments), but it MUST NOT appear inside the
      // _signAuthorization function body.
      expect(fn!).not.toMatch(/EIP7702Authorization/);
    });

    it("returns the canonical r/s/yParity tuple shape the server's authorizationList expects", () => {
      expect(fn!).toMatch(/r:\s*auth\.signature\.r/);
      expect(fn!).toMatch(/s:\s*auth\.signature\.s/);
      expect(fn!).toMatch(/yParity:\s*auth\.signature\.yParity/);
    });
  });

  describe("MCP Node client (mcp-server/src/client.ts)", () => {
    // Greedy across `\n}` would consume into the next function (which
    // legitimately uses signTypedData for the witness EIP-712 sig).
    // Anchor on the function's exact closure: top-level `^}` after the
    // body. Multiline flag so `^` matches line starts.
    const fn = extractFn(
      mcpClientSource,
      /async\s+function\s+signAuthorization\s*\([\s\S]*?\n^\}/m,
    );

    it("the helper exists", () => {
      expect(fn).toBeTruthy();
    });

    it("delegates to wallet.authorize (ethers v6.16+ EIP-7702 native helper)", () => {
      expect(fn!).toMatch(/wallet\.authorize\(\s*\{[\s\S]*?chainId:\s*args\.chainId/);
    });

    it("does NOT use signTypedData (the regressed EIP-712 path)", () => {
      expect(fn!).not.toMatch(/signTypedData/);
    });

    it("does NOT reference the AUTHORIZATION_TYPES const (now removed)", () => {
      expect(mcpClientSource).not.toMatch(/AUTHORIZATION_TYPES\s*=/);
    });

    it("returns the canonical r/s/yParity tuple shape", () => {
      expect(fn!).toMatch(/r:\s*auth\.signature\.r/);
      expect(fn!).toMatch(/s:\s*auth\.signature\.s/);
      expect(fn!).toMatch(/yParity:\s*auth\.signature\.yParity/);
    });
  });
});
