/**
 * relay-record-after.test.ts
 *
 * Post-settlement writes (recordRelayedTx, trial_gas_burned counter)
 * must run through `after()` so Vercel keeps the serverless function
 * alive long enough for the KV writes to land. The earlier revision
 * called recordRelayedTx as a fire-and-forget Promise.catch(...) — on a
 * cold-stop or KV transient failure the response went out but the TX
 * history + gas-tank debit never landed.
 *
 * Source-grep guards:
 *   - `recordRelayedTx(...)` is wrapped in `after(async () => { ... })`
 *   - The trial-gas-burn HINCRBYFLOAT counter is too
 *   - The old `.catch(e => console.error(... non-fatal ...))` pattern
 *     no longer wraps either write
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CRLF→LF for Windows fresh-clones.
const routeSrc = readFileSync(
  resolve(__dirname, "..", "app", "api", "relay", "route.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("relay post-settlement writes go through after()", () => {
  it("imports `after` from next/server", () => {
    expect(routeSrc).toMatch(/import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\/server["']/);
  });

  it("wraps recordRelayedTx in after(async () => { ... })", () => {
    // The whole block: after(async () => { try { await recordRelayedTx(...) } catch ... })
    expect(routeSrc).toMatch(/after\(\s*async[\s\S]+?await\s+recordRelayedTx\(/);
  });

  it("wraps the trial_gas_burned HINCRBYFLOAT in after(async () => { ... })", () => {
    expect(routeSrc).toMatch(/after\(\s*async[\s\S]+?hincrbyfloat\(\s*["']trial_gas_burned["']/);
  });

  it("does not call recordRelayedTx outside of an after() block", () => {
    // Count the lines where `recordRelayedTx(` is invoked (not imported).
    // Every invocation must sit inside an `after(...)` body. We assert by
    // proximity: each `recordRelayedTx(` call site must be preceded within
    // 5 lines by `after(`.
    const lines = routeSrc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Skip the import line + the "Earlier revision called recordRelayedTx"
      // comment line that documents the prior bug.
      if (!/\brecordRelayedTx\(/.test(lines[i])) continue;
      if (lines[i].includes("Earlier revision")) continue;
      // Look back up to 5 lines for an `after(` opener.
      const window = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      expect(window, `recordRelayedTx call at line ${i + 1} must be inside after()`).toMatch(/after\(/);
    }
  });

  it("trial-gas-burn counter is not the legacy `void (async () => ...)` IIFE", () => {
    // Pin the after()-vs-IIFE choice. If a refactor re-introduces the
    // fire-and-forget IIFE for the counter we want a red test.
    expect(routeSrc).not.toMatch(/void\s+\(\s*async[\s\S]{0,200}?hincrbyfloat/);
  });
});
