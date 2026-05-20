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
import { readFileSync } from "node:fs";
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
    const source = readFileSync(resolve(ROOT, path), "utf8");
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
      ["avax", "bnb", "eth", "injective", "mantle", "monad", "scroll", "stable", "xlayer"],
    );
  });
});
