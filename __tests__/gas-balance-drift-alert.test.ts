/**
 * gas-balance-drift-alert.test.ts
 *
 * `getGasBalance` clamps negative balances to 0 for the user UI (a user
 * can't have a negative claim on their own funds), but a pre-clamp
 * negative value is a real ledger divergence — settlement debited gas
 * against a deposit we never recorded in KV. Silently swallowing the
 * negative loses ops's only signal that the deposit ledger and the
 * usage ledger have drifted apart.
 *
 * Source-grep that:
 *   - The clamp still happens (user UI invariant)
 *   - But the pre-clamp value is captured and an ops alert fires
 *   - The alert is deduped per (address, chains-set) so a read-storm
 *     doesn't page on every dashboard poll
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dbSrc = readFileSync(
  resolve(__dirname, "..", "app", "lib", "db.ts"),
  "utf8",
);

describe("getGasBalance — negative drift alert", () => {
  it("still clamps negative balances to 0 for the user UI", () => {
    expect(dbSrc).toMatch(/totals\[chain\]\s*=\s*0;/);
  });

  it("captures the pre-clamp negative value before clamping", () => {
    // The drifting[] array must accumulate the negative value BEFORE
    // totals[chain] is set to 0.
    const fn = dbSrc.match(/export async function getGasBalance[\s\S]+?\n\}/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    // The push of {balance: totals[chain]} happens inside the same `if`
    // that detects negative — i.e. before the clamp.
    expect(body).toMatch(/drifting\.push\([\s\S]*?balance:\s*totals\[chain\]/);
    // The push appears BEFORE the clamp assignment.
    const pushIdx  = body.indexOf("drifting.push");
    const clampIdx = body.indexOf("totals[chain] = 0;");
    expect(pushIdx).toBeGreaterThan(0);
    expect(clampIdx).toBeGreaterThan(0);
    expect(pushIdx).toBeLessThan(clampIdx);
  });

  it("fires an ops alert with the per-chain breakdown when drift is detected", () => {
    expect(dbSrc).toMatch(/emitGasDriftAlert/);
    expect(dbSrc).toMatch(/sendOpsAlert/);
  });

  it("dedups alerts per (address, chains-set) with 1h TTL", () => {
    expect(dbSrc).toMatch(/gas_drift_alert:\$\{address\}:\$\{drifting\.map/);
    expect(dbSrc).toMatch(/ex:\s*3600/);
    expect(dbSrc).toMatch(/nx:\s*true/);
  });

  it("alert path never throws out of getGasBalance (the read must not fail)", () => {
    // emitGasDriftAlert wraps everything in try/catch. getGasBalance only
    // void-fires it.
    expect(dbSrc).toMatch(/void\s+emitGasDriftAlert/);
    const helperFn = dbSrc.match(/async function emitGasDriftAlert[\s\S]+?^\}/m);
    expect(helperFn).toBeTruthy();
    expect(helperFn![0]).toMatch(/try\s*\{[\s\S]+?\}\s*catch/);
  });
});
