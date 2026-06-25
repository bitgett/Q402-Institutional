/**
 * mcp-tool-count-copy.test.ts
 *
 * The MCP tool count is hardcoded as free-text prose in ~15 user-facing spots
 * across this repo (landing hero, use-cases, /agents stat, /claude, /grant,
 * /docs table header, README). With no single source it has silently drifted
 * every time a tool was added (27 -> 29 -> 30), shipping pages that disagree
 * with each other and with the actual MCP surface.
 *
 * This guard derives the CANONICAL count from the discovery route's tools[]
 * array (which a separate test pins to the MCP CallTool handler set) and asserts
 * every numeric "N tools / N-tool / N MCP tools / N total" copy string matches
 * it. Add a tool -> update /api/mcp/info -> this fails until every copy is bumped.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

// Canonical = how many tools the public discovery route advertises.
const infoSrc = read("app/api/mcp/info/route.ts");
const CANONICAL = [...infoSrc.matchAll(/name:\s*"(q402_[a-z_]+)"/g)].length;

// Every user-facing surface that states the count in prose.
const COPY_FILES = [
  "app/components/LandingBody.tsx",
  "app/components/UseCases.tsx",
  "app/agents/page.tsx",
  "app/claude/page.tsx",
  "app/grant/page.tsx",
  "app/docs/page.tsx",
  "README.md",
];

// Numeric forms the count has actually appeared in (and drifted in).
// `[1-9]\d*` (no leading zero) so section indices like "04 TOOLS" / "4 · Tools"
// don't read as a count of 4.
const NUMERIC_PATTERNS = [
  /\b([1-9]\d*)[ -](?:MCP )?tools?\b/gi,            // "30 tools", "30-tool", "30 MCP tools"
  /v:\s*"([1-9]\d*)",\s*label:\s*"MCP tools"/g,     // the /agents headline stat
  /Tools exposed\s*[—–-]\s*([1-9]\d*)\s*total/gi,    // the /docs table header
];

describe("MCP tool-count copy never drifts from the discovery route", () => {
  it("CANONICAL resolves to a real count", () => {
    expect(CANONICAL).toBeGreaterThanOrEqual(30);
  });

  it.each(COPY_FILES)("%s states the canonical tool count (no stale number)", (file) => {
    const src = read(file);
    const found: number[] = [];
    for (const re of NUMERIC_PATTERNS) {
      for (const m of src.matchAll(re)) found.push(Number(m[1]));
    }
    for (const n of found) {
      expect(n, `${file} has a stale "${n} tools" — bump it to ${CANONICAL}`).toBe(CANONICAL);
    }
    // Spelled-out regressions ("Twenty-nine tools") — only the canonical word
    // form should ever appear; flag any lower count word.
    expect(src, `${file} has a spelled-out stale tool count`).not.toMatch(/twenty-(?:six|seven|eight|nine)/i);
  });
});
