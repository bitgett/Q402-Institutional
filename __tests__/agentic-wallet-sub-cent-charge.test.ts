/**
 * agentic-wallet-sub-cent-charge.test.ts
 *
 * Regression guard for the sub-cent daily-spend bypass. Without the
 * floor, `Math.round(0.004 * 100) = 0` left the daily ledger
 * untouched — a spam loop of sub-cent sends could approach the daily
 * cap while reporting $0 spent. Pin the source so the floor stays put.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("agentic-wallet daily-spend: sub-cent floor", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "app", "lib", "agentic-wallet.ts"),
    "utf8",
  );

  it("exports a `chargeUsdToCents` helper distinct from `usdToCents`", () => {
    expect(src).toMatch(/function chargeUsdToCents\(/);
    expect(src).toMatch(/Math\.max\(1, Math\.round\(amountUsd \* 100\)\)/);
  });

  it("chargeAgainstDailyLimit uses chargeUsdToCents (NOT usdToCents) for the charge", () => {
    // Find the function body and assert the charge call uses the
    // floored helper. Drift back to `usdToCents` reopens the bypass.
    const fnIdx = src.indexOf("export async function chargeAgainstDailyLimit");
    const endIdx = src.indexOf("\nexport ", fnIdx + 1);
    const body = src.slice(fnIdx, endIdx > -1 ? endIdx : undefined);
    expect(body).toMatch(/chargeUsdToCents\(amountUsd\)/);
    expect(body).not.toMatch(/const amountCents = usdToCents\(amountUsd\)/);
  });

  it("refundDailySpend uses the same floored helper (symmetric)", () => {
    const fnIdx = src.indexOf("export async function refundDailySpend");
    const endIdx = src.indexOf("\nexport ", fnIdx + 1);
    const body = src.slice(fnIdx, endIdx > -1 ? endIdx : undefined);
    expect(body).toMatch(/-chargeUsdToCents\(amountUsd\)/);
  });

  it("recordDailySpend (legacy path) uses the floored helper too", () => {
    const fnIdx = src.indexOf("export async function recordDailySpend");
    const endIdx = src.indexOf("\nexport ", fnIdx + 1);
    const body = src.slice(fnIdx, endIdx > -1 ? endIdx : undefined);
    expect(body).toMatch(/chargeUsdToCents\(amountUsd\)/);
  });
});

describe("export route — fail-closed on audit-log failure", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "app", "api", "wallet", "agentic", "export", "route.ts"),
    "utf8",
  );

  it("refuses the export with 503 when recordExportEvent throws", () => {
    expect(src).toMatch(/AUDIT_LOG_UNAVAILABLE/);
    expect(src).toMatch(/status:\s*503/);
  });

  it("the privateKey is returned ONLY after the audit log succeeded", () => {
    // The try/await/catch around recordExportEvent must precede the
    // NextResponse.json that carries the privateKey. If anyone
    // reorders these so the response fires inside the catch, the
    // fail-closed invariant breaks.
    const auditIdx = src.indexOf("await recordExportEvent");
    const keyResponseIdx = src.indexOf("privateKey: pk");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(keyResponseIdx).toBeGreaterThan(-1);
    expect(keyResponseIdx).toBeGreaterThan(auditIdx);
  });

  it("the catch path returns 503 (not a success-path with privateKey)", () => {
    // Anchor on `await recordExportEvent(` — the awaited call, not the
    // import or docstring mention. The catch directly following is the
    // audit-log fail-closed path.
    const awaitIdx = src.indexOf("await recordExportEvent(");
    expect(awaitIdx).toBeGreaterThan(-1);
    const catchIdx = src.indexOf("catch (e)", awaitIdx);
    expect(catchIdx).toBeGreaterThan(-1);
    const openIdx = src.indexOf("{", catchIdx);
    let depth = 0;
    let endIdx = openIdx;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    const catchBlock = src.slice(openIdx, endIdx);
    expect(catchBlock).toMatch(/status:\s*503/);
    expect(catchBlock).not.toMatch(/privateKey:/);
  });
});
