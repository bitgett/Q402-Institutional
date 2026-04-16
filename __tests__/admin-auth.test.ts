/**
 * admin-auth.test.ts
 *
 * Guards the admin-secret comparison — timing-safe, fail-closed on unset env,
 * and consistent across every admin endpoint that imports it. Previously each
 * admin route re-implemented the check inline with `===`, which drifted into
 * two variants (`!!expected && secret === expected` vs. `!secret || secret !==
 * expected`) and opened a theoretical timing side-channel.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkAdminSecret } from "@/app/lib/admin-auth";

function mockReq(headers: Record<string, string>) {
  return {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
  } as unknown as import("next/server").NextRequest;
}

const ORIGINAL_SECRET = process.env.ADMIN_SECRET;

describe("checkAdminSecret", () => {
  beforeEach(() => {
    process.env.ADMIN_SECRET = "supersecret-abc123";
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = ORIGINAL_SECRET;
  });

  it("accepts an exact match", () => {
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "supersecret-abc123" }))).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "DIFFERENTSECRET!!" }))).toBe(false);
  });

  it("rejects a secret with the wrong length (prefix match)", () => {
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "supersecret" }))).toBe(false);
  });

  it("rejects a secret with the wrong length (suffix match)", () => {
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "supersecret-abc1234" }))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(checkAdminSecret(mockReq({}))).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "" }))).toBe(false);
  });

  it("fails closed when ADMIN_SECRET env var is unset", () => {
    delete process.env.ADMIN_SECRET;
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "anything" }))).toBe(false);
  });

  it("fails closed when ADMIN_SECRET env var is empty", () => {
    process.env.ADMIN_SECRET = "";
    expect(checkAdminSecret(mockReq({ "x-admin-secret": "" }))).toBe(false);
  });
});

describe("admin routes all share the canonical checker", () => {
  it("no admin route re-implements the secret comparison with === or !==", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolve } = require("node:path") as typeof import("node:path");
    const paths = [
      "app/api/keys/generate/route.ts",
      "app/api/keys/topup/route.ts",
      "app/api/gas-tank/withdraw/route.ts",
      "app/api/grant/route.ts",
      "app/api/inquiry/route.ts",
    ];
    for (const p of paths) {
      const src = readFileSync(resolve(__dirname, "..", p), "utf8");
      expect(src, `${p} should import the shared helper`).toMatch(
        /from\s+["']@\/app\/lib\/admin-auth["']/
      );
      expect(src, `${p} should not re-implement the check with === or !==`).not.toMatch(
        /secret\s*(===|!==)\s*(expected|process\.env\.ADMIN_SECRET)/
      );
    }
  });
});
