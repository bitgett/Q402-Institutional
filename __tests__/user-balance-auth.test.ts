/**
 * user-balance-auth.test.ts — Q402-SEC-003 regression guard.
 *
 * The /api/gas-tank/user-balance endpoint used to accept an anonymous
 * `?address=` parameter, letting anyone enumerate a wallet's Q402 gas-tank
 * posture (per-chain balance + deposit history) by knowing its public
 * address. This source-grep test keeps nonce+signature auth wired through
 * `requireAuth`, matching /api/transactions and /api/webhook.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSource = readFileSync(
  resolve(__dirname, "..", "app", "api", "gas-tank", "user-balance", "route.ts"),
  "utf8"
);

describe("Q402-SEC-003 — user-balance requires wallet auth", () => {
  it("imports requireAuth from the shared auth module", () => {
    expect(routeSource).toMatch(/import\s*\{\s*requireAuth\s*\}\s*from\s*"@\/app\/lib\/auth"/);
  });

  it("reads nonce and signature from the query string", () => {
    expect(routeSource).toMatch(/searchParams\.get\("nonce"\)/);
    expect(routeSource).toMatch(/searchParams\.get\("sig"\)/);
  });

  it("calls requireAuth(address, nonce, sig) before touching balance state", () => {
    // The guard must fire before getGasBalance / getGasDeposits so an
    // unauthenticated caller never reaches the KV reads.
    const authIdx       = routeSource.search(/const\s+authResult\s*=\s*await\s+requireAuth/);
    const balanceReadIdx = routeSource.search(/getGasBalance\s*\(/);
    const depositReadIdx = routeSource.search(/getGasDeposits\s*\(/);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(balanceReadIdx).toBeGreaterThan(authIdx);
    expect(depositReadIdx).toBeGreaterThan(authIdx);
  });

  it("returns auth errors with the status code requireAuth provides", () => {
    expect(routeSource).toMatch(/status:\s*authResult\.status/);
  });

  it("still enforces the per-IP rate limit as defense in depth", () => {
    expect(routeSource).toMatch(/rateLimit\(ip,\s*"user-balance",\s*30,\s*60\)/);
  });
});
