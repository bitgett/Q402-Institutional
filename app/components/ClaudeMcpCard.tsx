"use client";

import { useMemo, useState } from "react";

/**
 * Dashboard → Claude tab card for the @quackai/q402-mcp launch.
 *
 * Renders an install command + Claude Desktop config snippet pre-filled with
 * the user's API key, plus a one-click copy. Sandbox-default: real-payment
 * env vars are shown as commented-out hints so a user has to opt in
 * deliberately before any on-chain TX would fire.
 */

const INSTALL_CMD = "claude mcp add q402 -- npx -y @quackai/q402-mcp";

function buildConfigJson(apiKey: string): string {
  return `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"],
      "env": {
        "Q402_API_KEY": "${apiKey}"
      }
    }
  }
}`;
}

interface Props {
  /** A live or sandbox API key — pre-filled into the config snippet. */
  apiKey: string;
}

export default function ClaudeMcpCard({ apiKey }: Props) {
  const config = useMemo(() => buildConfigJson(apiKey), [apiKey]);
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
          <span className="text-sm font-semibold">Claude MCP</span>
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
        Use Q402 directly from Claude Desktop, Claude Code, Cline, or any MCP-compatible AI
        client. Sandbox by default — paste this config and Claude can quote across all 7 chains
        immediately, no wallet hookup required.
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
        <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2 font-semibold">
          2 · Or paste this into your config (key pre-filled)
        </div>
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

      <div className="text-[11px] text-white/35 leading-relaxed border-t border-white/8 pt-3">
        Real on-chain payments require three more env vars (
        <code className="text-white/50">Q402_PRIVATE_KEY</code>,{" "}
        <code className="text-white/50">Q402_ENABLE_REAL_PAYMENTS=1</code>, and a{" "}
        <code className="text-white/50">q402_live_</code> key). See{" "}
        <a href="/claude" className="text-yellow hover:underline">
          /claude
        </a>{" "}
        for the full reference.
      </div>
    </div>
  );
}
