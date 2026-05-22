/**
 * mcp-config-dotenv.test.ts
 *
 * Locks in the contract of `loadQ402EnvFileFromPath()` — the dotenv-style
 * parser that backs the `~/.q402/mcp.env` auto-load. This is the file users
 * edit during the `q402_doctor` setup flow; if the parser silently drops a
 * value, the user sees "still in sandbox" with no way to debug why.
 *
 * What we lock down:
 *   - missing file is non-fatal (returns {})
 *   - `#` comments + blank lines are ignored
 *   - `Q402_` prefix filter excludes stray vars (e.g. `PATH=`, `OPENAI_API_KEY=`)
 *   - simple `KEY=value` parsing, including values with `=` inside (URLs)
 *   - quoted values have surrounding quotes stripped (single OR double)
 *   - whitespace around the `=` is tolerated
 *   - precedence: process.env > file (verified via ENV constant indirectly —
 *     too invasive to mock at module-load time, so the parser test only
 *     covers parsing; the merge layer is covered by integration usage
 *     inside `loadConfig()` which the existing config tests exercise)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `@quackai/q402-mcp` is shipped from its own repo and gitignored here, so
// fresh clones of q402-landing don't have `mcp-server/` checked out as a
// sibling. The existing drift tests (mcp-tool-description-drift,
// mcp-package-drift) all use the same existsSync + skipIf pattern — the
// initial 0.5.6 version of this file skipped that guard and tripped CI on
// the next PR. We mirror that pattern here so any environment without the
// MCP sources cleanly skips the suite instead of failing module-load.
const MCP_CONFIG_PATH = resolve(__dirname, "..", "mcp-server", "src", "config.ts");
const mcpAvailable    = existsSync(MCP_CONFIG_PATH);

let loadQ402EnvFileFromPath: (p: string) => Record<string, string>;
let classifyApiKey:           (k: string | null) => "live" | "test" | "missing";

beforeAll(async () => {
  if (!mcpAvailable) return;
  // Dynamic import so the static module-load doesn't throw when
  // mcp-server/ is absent. The .skipIf guard below prevents the
  // assertions from running, but vitest still parses the file.
  const mod = await import("../mcp-server/src/config.js");
  loadQ402EnvFileFromPath = mod.loadQ402EnvFileFromPath;
  classifyApiKey          = mod.classifyApiKey;
});

let scratchDir: string;
let envFile:    string;

beforeEach(() => {
  if (!mcpAvailable) return;
  scratchDir = mkdtempSync(join(tmpdir(), "q402-mcp-env-"));
  envFile    = join(scratchDir, "mcp.env");
});

afterEach(() => {
  if (!mcpAvailable) return;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe.skipIf(!mcpAvailable)("loadQ402EnvFileFromPath", () => {
  it("returns empty object when the file does not exist", () => {
    expect(loadQ402EnvFileFromPath(join(scratchDir, "nope.env"))).toEqual({});
  });

  it("parses simple KEY=value pairs", () => {
    writeFileSync(envFile, "Q402_TRIAL_API_KEY=q402_live_abc\nQ402_PRIVATE_KEY=0xdeadbeef\n");
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out).toEqual({
      Q402_TRIAL_API_KEY: "q402_live_abc",
      Q402_PRIVATE_KEY:   "0xdeadbeef",
    });
  });

  it("ignores blank lines and `#` comments", () => {
    writeFileSync(envFile, [
      "# top-level comment",
      "",
      "Q402_TRIAL_API_KEY=q402_live_abc",
      "   # indented comment",
      "",
      "Q402_PRIVATE_KEY=0xdead",
      "",
    ].join("\n"));
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out).toEqual({
      Q402_TRIAL_API_KEY: "q402_live_abc",
      Q402_PRIVATE_KEY:   "0xdead",
    });
  });

  it("filters out non-Q402_ keys (namespace hygiene)", () => {
    writeFileSync(envFile, [
      "Q402_TRIAL_API_KEY=q402_live_abc",
      "PATH=/usr/local/bin",
      "OPENAI_API_KEY=sk-evil",
      "Q402_PRIVATE_KEY=0xdead",
    ].join("\n"));
    const out = loadQ402EnvFileFromPath(envFile);
    expect(Object.keys(out).sort()).toEqual([
      "Q402_PRIVATE_KEY",
      "Q402_TRIAL_API_KEY",
    ]);
    expect(out).not.toHaveProperty("PATH");
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("keeps `=` inside values intact (URLs, base64, etc.)", () => {
    writeFileSync(envFile, "Q402_RELAY_BASE_URL=https://example.com/api?k=v&x=1\n");
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out.Q402_RELAY_BASE_URL).toBe("https://example.com/api?k=v&x=1");
  });

  it("strips a single pair of surrounding double or single quotes", () => {
    writeFileSync(envFile, [
      `Q402_TRIAL_API_KEY="q402_live_quoted"`,
      `Q402_MULTICHAIN_API_KEY='q402_live_single'`,
      `Q402_PRIVATE_KEY=0xbare`,
    ].join("\n"));
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out.Q402_TRIAL_API_KEY).toBe("q402_live_quoted");
    expect(out.Q402_MULTICHAIN_API_KEY).toBe("q402_live_single");
    expect(out.Q402_PRIVATE_KEY).toBe("0xbare");
  });

  it("tolerates whitespace around the `=`", () => {
    writeFileSync(envFile, "Q402_TRIAL_API_KEY   =   q402_live_abc   \n");
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out.Q402_TRIAL_API_KEY).toBe("q402_live_abc");
  });

  it("skips lines without an `=` separator", () => {
    writeFileSync(envFile, [
      "Q402_TRIAL_API_KEY=q402_live_abc",
      "Q402_BROKEN_LINE_NO_EQUALS",
      "Q402_PRIVATE_KEY=0xdead",
    ].join("\n"));
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out).toEqual({
      Q402_TRIAL_API_KEY: "q402_live_abc",
      Q402_PRIVATE_KEY:   "0xdead",
    });
    expect(out).not.toHaveProperty("Q402_BROKEN_LINE_NO_EQUALS");
  });

  it("handles CRLF line endings (Windows-friendly)", () => {
    writeFileSync(envFile, "Q402_TRIAL_API_KEY=q402_live_abc\r\nQ402_PRIVATE_KEY=0xdead\r\n");
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out).toEqual({
      Q402_TRIAL_API_KEY: "q402_live_abc",
      Q402_PRIVATE_KEY:   "0xdead",
    });
  });

  // ── classifyApiKey ────────────────────────────────────────────────────
  // 0.5.16 exposes `classifyApiKey` so detectPhase() + loadConfig.mode can
  // detect "any scoped key is live" per-slot, instead of relying on the
  // aliased single `apiKey` slot. The alias picks one of (multichain ??
  // trial ?? legacy) and would mis-report e.g. multichain=q402_test_typo
  // + trial=q402_live_real as "test" — but the trial key is live for
  // BNB-scope q402_pay. Tests below lock in the contract that one bad
  // slot can't poison the live signal for the other slots.

  it("classifyApiKey returns 'live' for q402_live_* prefix", () => {
    expect(classifyApiKey("q402_live_abc")).toBe("live");
    expect(classifyApiKey("q402_live_")).toBe("live");
  });

  it("classifyApiKey returns 'test' for q402_test_* prefix", () => {
    expect(classifyApiKey("q402_test_abc")).toBe("test");
    expect(classifyApiKey("q402_test_typo")).toBe("test");
  });

  it("classifyApiKey returns 'missing' for null / empty / unknown prefix", () => {
    expect(classifyApiKey(null)).toBe("missing");
    expect(classifyApiKey("")).toBe("missing");
    expect(classifyApiKey("sk_live_other_provider")).toBe("missing");
    expect(classifyApiKey("q402_other_prefix")).toBe("missing");
  });

  it("treats `KEY=` (empty value) as unset", () => {
    // The 0.5.15 template ships the three secret lines uncommented but
    // empty (no `#` to remove, just paste the value on the right). The
    // parser must NOT propagate empty strings into FILE_ENV — otherwise
    // detectPhase() / envSlot() would see "configured" when the user
    // hasn't pasted anything yet, and skip the first-install branch.
    writeFileSync(envFile, [
      "Q402_TRIAL_API_KEY=",
      "Q402_MULTICHAIN_API_KEY=q402_live_real",
      "Q402_PRIVATE_KEY=   ",
      "Q402_ENABLE_REAL_PAYMENTS=1",
    ].join("\n"));
    const out = loadQ402EnvFileFromPath(envFile);
    expect(out).toEqual({
      Q402_MULTICHAIN_API_KEY:    "q402_live_real",
      Q402_ENABLE_REAL_PAYMENTS:  "1",
    });
    expect(out).not.toHaveProperty("Q402_TRIAL_API_KEY");
    expect(out).not.toHaveProperty("Q402_PRIVATE_KEY");
  });
});
