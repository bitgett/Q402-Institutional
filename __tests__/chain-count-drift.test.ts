/**
 * chain-count-drift.test.ts
 *
 * Lock the "N EVM chains" marketing copy across every public-facing
 * surface to the actual count in contracts.manifest.json. Without
 * this, every new chain integration silently leaves a stale "8 EVM
 * chains" string somewhere (README cover row, Hero hook, MCP tool
 * description, partner pages) — and the visible mismatch only
 * surfaces in production after the chain is announced.
 *
 * The previous chain rollouts (Monad, Injective) each shipped with
 * at least one stale count; the rolling fix history made it clear
 * that grep-by-hand isn't reliable. This test fails the build at
 * the first missing site so the integration PR can't ship without
 * updating every copy of the string.
 *
 * Add new files to FILES below as more surfaces start mentioning
 * the count. Removing a file is fine — the test asserts presence,
 * not exclusivity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

const manifest = JSON.parse(
  readFileSync(resolve(ROOT, "contracts.manifest.json"), "utf8"),
) as { chains: Record<string, unknown> };

const chainCount = Object.keys(manifest.chains).length;

// Surfaces that mention the chain count directly. Each entry is a
// {path, label} pair so failure messages identify the file by purpose
// instead of just by path. Sites that quote the count in a less direct
// form (e.g. "supports BNB, Ethereum, …, and N more") need their own
// regex assertion and don't belong in this list.
const FILES: { path: string; label: string }[] = [
  { path: "README.md",                                   label: "README cover paragraph" },
  { path: "app/components/Hero.tsx",                     label: "Hero hook copy" },
  { path: "app/claude/page.tsx",                         label: "Claude landing" },
  { path: "app/agents/page.tsx",                         label: "Agents page" },
  { path: "app/grant/page.tsx",                          label: "Grant page" },
  { path: "mcp-server/README.md",                        label: "MCP package README (npm front page)" },
  { path: "mcp-server/.codex-plugin/plugin.json",        label: "Codex MCP plugin manifest" },
  { path: "mcp-server/server.json",                      label: "Anthropic MCP registry manifest" },
];

describe(`chain-count drift (${chainCount} EVM chains)`, () => {
  it.each(FILES)("$label mentions \"$path\" with the correct chain count", ({ path }) => {
    const abs = resolve(ROOT, path);
    // Optional surfaces — `mcp-server/*` is a sibling repo and may be
    // absent in a bare clone or a CI job that didn't fetch it. Skip
    // silently rather than hard-fail the suite; the matching files in
    // the MCP repo's own test suite cover the same drift assertions.
    if (!existsSync(abs)) return;
    const source = readFileSync(abs, "utf8");
    // Accept "N EVM chains" or "N chains" — the docs use both forms.
    // Tighten to one form if drift in the wording starts to bite.
    const evmPattern = new RegExp(`\\b${chainCount}\\s+EVM\\s+chains?\\b`);
    const chainsPattern = new RegExp(`\\b${chainCount}\\s+chains?\\b`);
    const ok = evmPattern.test(source) || chainsPattern.test(source);
    expect(
      ok,
      `${path}: expected mention of "${chainCount} EVM chains" or "${chainCount} chains" ` +
      `to match contracts.manifest.json (Object.keys(chains).length === ${chainCount}). ` +
      `Update the count anywhere that quotes it directly.`,
    ).toBe(true);
  });

  it("contracts.manifest.json has the expected chain set", () => {
    // Sanity check so a future manifest mis-edit (e.g. accidentally
    // dropping a chain) is caught by this file as well — the other
    // assertions cascade-fail with confusing messages otherwise.
    expect(Object.keys(manifest.chains).sort()).toEqual(
      ["arbitrum", "avax", "bnb", "eth", "injective", "mantle", "monad", "scroll", "stable", "xlayer"],
    );
  });
});

// ── Negative drift guard — repo-wide ────────────────────────────────────────
//
// The positive guard above catches missing-mention regressions on a hand-
// curated allowlist. The negative guard below catches the opposite mistake:
// a stale "(N-1) chains" / "(N-1)-chain" string left somewhere in the
// codebase after a chain rollout. Past releases (Injective → 8, Monad →
// 8 retained, Scroll → 9) each shipped with at least one site still
// reading the old count; this test makes that class of bug fail the
// build. Once the next chain ships the constant below bumps by 1 and the
// stale-count grep follows automatically.
//
// Scope: source-bearing trees only. `node_modules`, `.next`, `dist`, and
// the MCP package's bundled `dist/index.js` are excluded — the published
// bundle is rebuilt from source as part of the release flow, so source
// is authoritative.

const STALE_COUNT = chainCount - 1;

// English word form for the stale count. The numeric guard misses prose
// like "Zero gas. Eight EVM chains." or "All eight chains share…" because
// the source spells the count out instead of using a digit. The map covers
// the realistic range of chain counts; missing entries skip the word-form
// guard rather than crash. Case-insensitive matching catches Eight/eight/
// EIGHT in one pattern.
const STALE_WORD: Record<number, string> = {
  6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
  11: "eleven", 12: "twelve",
};
const SOURCE_DIRS = [
  "app",
  "public",
  "scripts",
  "mcp-server/src",
  "mcp-server/README.md",
  "mcp-server/server.json",
  "mcp-server/.codex-plugin/plugin.json",
  "README.md",
  "contracts.manifest.json",
];

describe(`stale chain-count guard (no "${STALE_COUNT}" leftovers)`, () => {
  // Patterns the chain-rollout history has actually broken on. Add new
  // shapes here if the next reviewer catches a phrasing this list misses.
  const STALE_PATTERNS = [
    new RegExp(`\\b${STALE_COUNT}\\s+EVM\\s+chains?\\b`, "i"),
    new RegExp(`\\b${STALE_COUNT}\\s+chains?\\b`, "i"),
    new RegExp(`\\b${STALE_COUNT}-chain\\b`, "i"),
    new RegExp(`\\ball\\s+${STALE_COUNT}\\b`, "i"),
    new RegExp(`\\bpaid\\s+${STALE_COUNT}-chain\\b`, "i"),
    new RegExp(`\\b${STALE_COUNT}-CHAIN\\b`),
    // "8 supported chains" / "8 evm-compatible chains" / "8 live chains" —
    // a single modifier word can slip past the bare "N chains" form. Allows
    // up to two intervening words so we catch "all 8 active chains" too.
    new RegExp(`\\b${STALE_COUNT}\\s+\\w+(?:\\s+\\w+)?\\s+chains?\\b`, "i"),
    // Word-form variants — "Eight EVM chains" / "All eight chains" / etc.
    // Only added when STALE_WORD has a mapping for the current STALE_COUNT.
    ...(STALE_WORD[STALE_COUNT]
      ? [
          new RegExp(`\\b${STALE_WORD[STALE_COUNT]}\\s+EVM\\s+chains?\\b`, "i"),
          new RegExp(`\\b${STALE_WORD[STALE_COUNT]}\\s+chains?\\b`, "i"),
          new RegExp(`\\ball\\s+${STALE_WORD[STALE_COUNT]}\\s+chains?\\b`, "i"),
        ]
      : []),
  ];

  // Recursively gather files we care about. Skips binaries + build
  // artifacts. Reads each once; for the repo's current scale (a few
  // hundred source files) this is fast enough that the test runs in
  // well under a second.
  function collect(dir: string, out: string[]) {
    // Optional source roots — `mcp-server/src` is a sibling repo that may
    // not be present in a bare clone or a CI job that didn't fetch it.
    // Skip silently rather than crash the test with ENOENT.
    if (!existsSync(dir)) return;
    const stat = statSync(dir);
    if (stat.isFile()) { out.push(dir); return; }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip nested build / dependency output.
        if (entry.name === "node_modules" || entry.name === ".next"
            || entry.name === "dist" || entry.name === ".git"
            || entry.name === "cache" || entry.name === "artifacts"
            || entry.name === "typechain-types") continue;
        collect(full, out);
      } else if (entry.isFile()) {
        // Source files only — skip lockfiles, images, etc.
        if (/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(entry.name)) out.push(full);
      }
    }
  }

  const files: string[] = [];
  for (const d of SOURCE_DIRS) collect(resolve(ROOT, d), files);

  it.each(STALE_PATTERNS)("no file matches %s", (pattern) => {
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (pattern.test(src)) hits.push(f.replace(ROOT + "/", "").replace(ROOT + "\\", ""));
    }
    expect(
      hits,
      `Found stale "${STALE_COUNT}-chain" references in:\n  ${hits.join("\n  ")}\n\n` +
      `Update to "${chainCount}" so the marketing copy matches the manifest.`,
    ).toEqual([]);
  });
});
