"use client";

import { useMemo, useState } from "react";

/**
 * Dashboard → Claude tab card for the @quackai/q402-mcp launch.
 *
 * Renders an install command + Claude Desktop config snippet pre-filled with
 * the user's *sandbox* API key only. Real on-chain payments deliberately are
 * NOT one-click here — the recommended live path is `q402_doctor` (it writes
 * the live key + private key into ~/.q402/mcp.env, which the server auto-
 * loads on startup). Keeping live secrets out of this JSON also keeps them
 * out of any config file that syncs through iCloud/OneDrive.
 */

const INSTALL_CMD = "claude mcp add q402 -- npx -y @quackai/q402-mcp";

function buildConfigJson(sandboxKey: string): string {
  // Sandbox keys (q402_test_*) work in any scope — slot choice is just a
  // placeholder. We use Q402_MULTICHAIN_API_KEY since Multichain is the
  // broader scope, and when the user upgrades to live they typically
  // paste a paid Multichain key into the same slot. (Q402_API_KEY still
  // resolves silently for old integrations but isn't surfaced anywhere
  // new users see.)
  return `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"],
      "env": {
        "Q402_MULTICHAIN_API_KEY": "${sandboxKey}"
      }
    }
  }
}`;
}

interface Props {
  /**
   * The user's sandbox key (q402_test_*) — pre-filled into the config snippet.
   * Live keys are deliberately not surfaced here; see the component header.
   */
  sandboxApiKey: string;
}

export default function ClaudeMcpCard({ sandboxApiKey }: Props) {
  const config = useMemo(() => buildConfigJson(sandboxApiKey), [sandboxApiKey]);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  function copy(value: string, kind: "cmd" | "json") {
    navigator.clipboard.writeText(value);
    if (kind === "cmd") {
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    } else {
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  }

  return (
    <div
      className="rounded-2xl border p-5 space-y-4"
      style={{
        background: "linear-gradient(135deg, rgba(245,158,11,0.04), rgba(245,197,24,0.03))",
        borderColor: "rgba(245,158,11,0.20)",
      }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">MCP for AI Clients</span>
          <span className="text-[10px] bg-orange-300/10 text-orange-300 border border-orange-300/30 px-2 py-0.5 rounded-full font-bold tracking-widest">
            NEW
          </span>
        </div>
        <a
          href="/claude"
          className="text-xs text-yellow hover:underline"
        >
          Full guide →
        </a>
      </div>

      <p className="text-white/45 text-xs leading-relaxed">
        Use Q402 directly from Claude (Desktop / Code), OpenAI Codex CLI, Cursor, Cline, or any
        MCP-compatible AI client. The config below is pre-filled with your sandbox key — safe to
        paste anywhere. For live payments the recommended path is to ask your AI &ldquo;Set up
        Q402&rdquo; after install — <code className="text-white/55">q402_doctor</code> creates{" "}
        <code className="text-white/55">~/.q402/mcp.env</code> for you and walks you through it.
      </p>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2 font-semibold">
          1 · Install in Claude Desktop
        </div>
        <div className="flex gap-2 items-stretch">
          <code className="flex-1 bg-navy border border-white/8 rounded-xl px-3 py-2.5 font-mono text-xs text-white/70 truncate">
            {INSTALL_CMD}
          </code>
          <button
            type="button"
            onClick={() => copy(INSTALL_CMD, "cmd")}
            className={`flex-shrink-0 text-xs px-3 py-1 rounded-lg font-semibold transition-all ${
              copiedCmd
                ? "bg-green-400/15 text-green-400"
                : "bg-yellow/10 text-yellow hover:bg-yellow/20"
            }`}
          >
            {copiedCmd ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2 font-semibold flex items-center gap-2">
          <span>2 · Or paste this into your config</span>
          <span className="text-yellow/70 normal-case tracking-normal font-mono text-[10px]">
            sandbox key
          </span>
        </div>
        <p className="text-white/35 text-[11px] mb-2 leading-relaxed">
          Snippet ships with your <strong className="text-white/55">sandbox key</strong> in the
          {" "}<code className="text-white/50">Q402_MULTICHAIN_API_KEY</code> slot — safe to paste
          anywhere. For live payments, the recommended path is to ask your AI{" "}
          <strong className="text-white/65">&ldquo;Set up Q402&rdquo;</strong> after install — it
          calls <code className="text-yellow/80">q402_doctor</code> and walks you through
          creating <code className="text-white/50">~/.q402/mcp.env</code> with your real key and
          wallet private key. (The server auto-loads that file, so you never have to put live
          secrets in this JSON.)
        </p>
        <div className="relative">
          <pre className="bg-[#060C14] border border-white/7 rounded-xl p-4 overflow-x-auto">
            <code className="font-mono text-[11px] text-white/75 leading-relaxed whitespace-pre">
              {config}
            </code>
          </pre>
          <button
            type="button"
            onClick={() => copy(config, "json")}
            className={`absolute top-3 right-3 text-[10px] px-2.5 py-1 rounded-md font-semibold transition-all ${
              copiedJson
                ? "bg-green-400/15 text-green-400"
                : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/80"
            }`}
          >
            {copiedJson ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div className="text-[11px] text-white/40 leading-relaxed border-t border-white/8 pt-3 space-y-2">
        <div>
          <span className="text-orange-300/80 font-semibold uppercase tracking-widest text-[10px] mr-2">
            Live mode
          </span>
          Recommended: after restart, ask your AI{" "}
          <strong className="text-white/75">&ldquo;Set up Q402&rdquo;</strong>. The MCP server
          ships with a <code className="text-white/55">q402_doctor</code> tool that creates{" "}
          <code className="text-white/55">~/.q402/mcp.env</code>, opens it in your editor, and
          walks you through pasting your real key (Trial or Multichain) and wallet private key.
          The server auto-loads that file on startup, so live secrets stay out of this JSON —
          which syncs through iCloud/OneDrive on most setups and would otherwise be the leak surface.
        </div>
        <div className="text-white/30">
          See{" "}
          <a href="/claude" className="text-yellow/70 hover:text-yellow hover:underline">
            /claude
          </a>{" "}
          or{" "}
          <a href="/docs#claude-mcp" className="text-yellow/70 hover:text-yellow hover:underline">
            /docs#claude-mcp
          </a>{" "}
          for the live-mode walkthrough.
        </div>
      </div>
    </div>
  );
}
