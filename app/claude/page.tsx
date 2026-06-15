"use client";

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import { MCP_VERSION } from "@/app/lib/version";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

/**
 * /claude  landing page for @quackai/q402-mcp.
 *
 * URL kept as `/claude` for backlink stability (npm README, Anthropic
 * Registry, prior tweets all link here), but the page itself is MCP-
 * canonical: Claude / Codex / Cursor / Cline are first-class equals.
 *
 * Re-skinned onto the main landing's design system: navy base #070C16,
 * brand yellow #F5C518, cyan #5BC8FA accent, font-display headings, shared
 * Navbar + Footer. Three sections plus a wallet-mode picker and a grouped,
 * iconographic tools grid. Trust Receipt, safety guards, and CTA live on
 * /docs to avoid duplication.
 *
 * Wider container (`max-w-[88rem]`) than the rest of the site  the
 * live-quote table's 5 columns + the tabbed install snippet both want
 * more horizontal room than `max-w-6xl` gives them.
 */

interface ChainRow {
  key:               string;
  name:              string;
  chainId:           number;
  gas:               string;
  approxGasCostUsd:  number;
  tokens:            ReadonlyArray<"USDC" | "USDT" | "RLUSD">;
  note?:             string;
}

const CHAINS: ChainRow[] = [
  { key: "stable",    name: "Stable",            chainId: 988,    gas: "USDT0", approxGasCostUsd: 0.0005, tokens: ["USDC", "USDT"], note: "USDC and USDT both alias to USDT0" },
  { key: "bnb",       name: "BNB Chain",         chainId: 56,     gas: "BNB",   approxGasCostUsd: 0.001,  tokens: ["USDC", "USDT"] },
  { key: "xlayer",    name: "X Layer",           chainId: 196,    gas: "OKB",   approxGasCostUsd: 0.002,  tokens: ["USDC", "USDT"] },
  { key: "mantle",    name: "Mantle",            chainId: 5000,   gas: "MNT",   approxGasCostUsd: 0.002,  tokens: ["USDC", "USDT"] },
  { key: "avax",      name: "Avalanche C-Chain", chainId: 43114,  gas: "AVAX",  approxGasCostUsd: 0.003,  tokens: ["USDC", "USDT"] },
  { key: "injective", name: "Injective EVM",     chainId: 1776,   gas: "INJ",   approxGasCostUsd: 0.004,  tokens: ["USDC", "USDT"] },
  { key: "monad",     name: "Monad",             chainId: 143,    gas: "MON",   approxGasCostUsd: 0.002,  tokens: ["USDC", "USDT"] },
  { key: "scroll",    name: "Scroll",            chainId: 534352, gas: "ETH",   approxGasCostUsd: 0.001,  tokens: ["USDC", "USDT"], note: "zkEVM L2. EIP-7702 live since Euclid Phase 2 (2025-04-22)." },
  { key: "eth",       name: "Ethereum Mainnet",  chainId: 1,      gas: "ETH",   approxGasCostUsd: 1.2,    tokens: ["USDC", "USDT", "RLUSD"], note: "L1. Gas is volatile. RLUSD (Ripple USD, NY DFS regulated) Ethereum-only." },
];

// 4-client install matrix
// Each client has either a one-line CLI command (Claude / Codex) or a JSON
// snippet pasted into a config file (Cursor / Cline). Same npm package
// underneath  no client-specific server code.
type ClientKey = "claude" | "codex" | "cursor" | "cline";

// Full mcp.json shape  save as-is when the file does not yet exist.
const SHARED_JSON_FULL = `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`;

// Inner entry  paste INSIDE an existing `mcpServers` object when the
// file already has other MCP servers. We surface this as the safe path
// for any user who already wired up another MCP server, since pasting
// the full SHARED_JSON_FULL would clobber whatever else is there.
const SHARED_JSON_INNER = `"q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] }`;

interface ClientInstall {
  key:           ClientKey;
  name:          string;
  logo:          string;
  /** white-on-light logos that need inverting on a white chip */
  invert?:       boolean;
  kind:          "cli" | "json";
  /** Primary snippet  the one shown front-and-center in the tab. */
  snippet:       string;
  /** JSON-only: the safer "merge into existing config" variant. */
  innerSnippet?: string;
  /** Where the inner snippet lives (path or UI breadcrumb). */
  configPath?:   string;
  /** One-line guidance under the snippet. */
  hint:          string;
}

const CLIENTS: ClientInstall[] = [
  {
    key:     "claude",
    name:    "Claude",
    logo:    "/logos/claude.svg",
    kind:    "cli",
    snippet: "claude mcp add q402 -- npx -y @quackai/q402-mcp",
    hint:    "Claude Code CLI or Claude Desktop. Reload / restart the app after running.",
  },
  {
    key:     "codex",
    name:    "Codex",
    logo:    "/logos/codex.svg",
    kind:    "cli",
    snippet: "codex mcp add q402 -- npx -y @quackai/q402-mcp",
    hint:    "OpenAI Codex CLI. Restart Codex (`codex`, quit, then re-launch) after running. On Windows, if `codex mcp add` returns \"Access is denied\", add the equivalent stanza to `~/.codex/config.toml` by hand: `[mcp_servers.q402]` / `command = \"npx\"` / `args = [\"-y\", \"@quackai/q402-mcp\"]`.",
  },
  {
    key:          "cursor",
    name:         "Cursor",
    logo:         "/logos/cursor.svg",
    invert:       true,
    kind:         "json",
    snippet:      SHARED_JSON_FULL,
    innerSnippet: SHARED_JSON_INNER,
    configPath:   "~/.cursor/mcp.json",
    hint:         "Save the full snippet as ~/.cursor/mcp.json if the file is new. After saving, reload Cursor (Cmd/Ctrl+Shift+P, Developer: Reload Window).",
  },
  {
    key:          "cline",
    name:         "Cline",
    logo:         "/logos/cline.svg",
    invert:       true,
    kind:         "json",
    snippet:      SHARED_JSON_FULL,
    innerSnippet: SHARED_JSON_INNER,
    configPath:   "Cline, Settings, MCP Servers, Edit JSON",
    hint:         "Open Cline's MCP servers JSON editor and paste. Reload VS Code (Cmd/Ctrl+Shift+P, Developer: Reload Window) when done.",
  },
];

// "works with" logo strip  uniform white chips, in addition to the tab
// icons. Copilot + Hermes are raster logos, the rest are SVGs; cursor +
// cline ship white-on-transparent so they get inverted onto a white chip.
const WORKS_WITH: Array<{ name: string; logo: string; invert?: boolean }> = [
  { name: "Claude",  logo: "/logos/claude.svg" },
  { name: "Codex",   logo: "/logos/codex.svg" },
  { name: "Cursor",  logo: "/logos/cursor.svg", invert: true },
  { name: "Cline",   logo: "/logos/cline.svg",  invert: true },
  { name: "Copilot", logo: "/logos/copilot.jpg" },
  { name: "Hermes",  logo: "/logos/hermes.jpg" },
];

// 20 tools, grouped by domain. Each group renders as a card with a small
// inline line-icon header; tool rows keep the mono name + auth + note.
type ToolGroupKey = "payments" | "wallet" | "recurring" | "bridge" | "diagnostics";

interface Tool { name: string; auth: string; note: string; group: ToolGroupKey }

const TOOLS: Tool[] = [
  { group: "diagnostics", name: "q402_doctor",              auth: "no auth",     note: "Install + ongoing health check. Call on \"set up Q402\"." },
  { group: "payments",    name: "q402_quote",               auth: "no auth",     note: "Compare gas across 10 chains. Read-only." },
  { group: "diagnostics", name: "q402_balance",             auth: "api key",     note: "Verify key + remaining quota." },
  { group: "payments",    name: "q402_pay",                 auth: "live mode",   note: "Single-recipient gasless USDC / USDT / RLUSD send. Sandbox by default." },
  { group: "payments",    name: "q402_batch_pay",           auth: "live mode",   note: "Up to 20 recipients in one signed batch (trial: 5)." },
  { group: "payments",    name: "q402_receipt",             auth: "no auth",     note: "Fetch + locally verify a Trust Receipt." },
  { group: "wallet",      name: "q402_wallet_status",       auth: "private key", note: "Per-chain EIP-7702 delegation state. Read-only." },
  { group: "wallet",      name: "q402_clear_delegation",    auth: "private key", note: "Clear EIP-7702 delegation on a chain. Q402-sponsored gas." },
  { group: "wallet",      name: "q402_agentic_info",        auth: "api key",     note: "Agent Wallet info (addresses, caps, ERC-8004 id). Read-only." },
  { group: "recurring",   name: "q402_recurring_list",      auth: "api key",     note: "List recurring rules." },
  { group: "recurring",   name: "q402_recurring_create",    auth: "api key",     note: "Author a recurring rule (paid Multichain only)." },
  { group: "recurring",   name: "q402_recurring_fires",     auth: "api key",     note: "Last 50 fires for one rule (timestamps + txHashes)." },
  { group: "recurring",   name: "q402_recurring_pause",     auth: "api key",     note: "Pause a rule. Reversible." },
  { group: "recurring",   name: "q402_recurring_resume",    auth: "api key",     note: "Resume a paused / stopped rule." },
  { group: "recurring",   name: "q402_recurring_skip_next", auth: "api key",     note: "Skip ONLY the next fire. Cadence preserved." },
  { group: "recurring",   name: "q402_recurring_cancel",    auth: "api key",     note: "Permanently stop a rule." },
  { group: "bridge",      name: "q402_bridge_quote",        auth: "no auth",     note: "Quote CCIP fee for a USDC bridge on eth/avax/arbitrum." },
  { group: "bridge",      name: "q402_bridge_send",         auth: "live key",    note: "Execute a CCIP USDC bridge from your Agent Wallet (Mode C). Sandbox-by-default; sandbox: false + live key fires a real bridge." },
  { group: "bridge",      name: "q402_bridge_history",      auth: "owner sig",   note: "List recent CCIP bridges. Owner-sig auth via dashboard." },
  { group: "bridge",      name: "q402_bridge_gas_tank",     auth: "owner sig",   note: "LINK + native Gas Tank bucket per CCIP chain." },
];

// Small inline line-icons (inherit currentColor, scale crisply) matching the
// main landing's icon language. One per tool group.
function GroupIcon({ group }: { group: ToolGroupKey }) {
  const common = {
    width: 20, height: 20, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const, "aria-hidden": true,
  };
  switch (group) {
    case "payments":
      return (
        <svg {...common}>
          <circle cx="12" cy="8.5" r="4.3" />
          <path d="M12 6.6v3.8M10.4 8.9 12 10.5l1.6-1.6" />
          <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
        </svg>
      );
    case "wallet":
      return (
        <svg {...common}>
          <rect x="2.5" y="5.5" width="19" height="14" rx="2.5" />
          <path d="M2.5 10h19" />
          <circle cx="17" cy="14.7" r="1.25" fill="currentColor" stroke="none" />
        </svg>
      );
    case "recurring":
      return (
        <svg {...common}>
          <path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4" />
          <path d="M19.8 4.2v3.6h-3.6" />
          <path d="M12 8.4v4l2.4 1.5" opacity=".55" />
        </svg>
      );
    case "bridge":
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="2.3" />
          <circle cx="19" cy="12" r="2.3" />
          <path d="M7.3 12h9.4" />
          <path d="M4 12c0-3 .8-5 8-5s8 2 8 5" opacity=".55" />
        </svg>
      );
    case "diagnostics":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M8.4 12.2l2.5 2.5 4.6-5.1" />
        </svg>
      );
  }
}

const TOOL_GROUPS: Array<{ key: ToolGroupKey; label: string; blurb: string }> = [
  { key: "payments",    label: "Payments",    blurb: "Quote, send, batch, verify." },
  { key: "wallet",      label: "Wallet",      blurb: "EIP-7702 delegation + Agent Wallet." },
  { key: "recurring",   label: "Recurring",   blurb: "Author + manage scheduled rules." },
  { key: "bridge",      label: "Bridge",      blurb: "CCIP cross-chain USDC moves." },
  { key: "diagnostics", label: "Diagnostics", blurb: "Health, setup, quota." },
];

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className={`font-display text-[11px] px-2.5 py-1 rounded-full font-semibold transition-all ${
        copied
          ? "bg-yellow/15 text-yellow"
          : "bg-white/5 text-white/45 hover:bg-yellow/15 hover:text-yellow"
      }`}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

// uniform white logo chip used by the tab row + the "works with" strip
function LogoChip({ logo, name, invert, size = "md" }: { logo: string; name: string; invert?: boolean; size?: "sm" | "md" }) {
  const box = size === "sm" ? "w-5 h-5 rounded bg-white p-0.5" : "w-7 h-7 rounded-md bg-white p-1 shadow-[0_1px_3px_rgba(0,0,0,0.35)]";
  return (
    <span className={`inline-flex items-center justify-center flex-shrink-0 overflow-hidden ${box}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logo}
        alt={name}
        className={`w-full h-full object-contain ${invert ? "invert" : ""}`}
      />
    </span>
  );
}

// shared scroll-reveal props (no once:true, so it re-animates on scroll back)
const revealProps = (delay = 0) => ({
  initial:    { opacity: 0, y: 24 },
  whileInView:{ opacity: 1, y: 0 },
  viewport:   { amount: 0.2 },
  transition: { duration: 0.6, delay },
});

export default function ClaudePage() {
  const [amount, setAmount]             = useState("50");
  const [tokenFilter, setTokenFilter]   = useState<"USDC" | "USDT" | "RLUSD" | "ANY">("ANY");
  const [activeClient, setActiveClient] = useState<ClientKey>("claude");

  const current = CLIENTS.find(c => c.key === activeClient)!;

  const ranked = useMemo(() => {
    const filtered = CHAINS.filter(c =>
      tokenFilter === "ANY" ? true : c.tokens.includes(tokenFilter),
    );
    return [...filtered].sort((a, b) => a.approxGasCostUsd - b.approxGasCostUsd);
  }, [tokenFilter]);

  return (
    <div className="min-h-screen text-white" style={{ background: "#070C16" }}>
      <Navbar />

      {/* HERO  pt accounts for the 72px fixed navbar */}
      <section className="relative overflow-hidden border-b pt-[72px]" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        {/* Background atmosphere  yellow + cyan blooms over a faded grid. */}
        <div className="absolute inset-0 pointer-events-none">
          <motion.div
            className="absolute -top-40 -left-40 w-[700px] h-[700px] rounded-full blur-[160px]"
            animate={{ opacity: [0.35, 0.6, 0.35] }}
            transition={{ duration: 8, repeat: Infinity }}
            style={{ background: "rgba(245,197,24,0.13)" }}
          />
          <motion.div
            className="absolute -bottom-40 -right-32 w-[640px] h-[640px] rounded-full blur-[150px]"
            animate={{ opacity: [0.25, 0.55, 0.25] }}
            transition={{ duration: 10, repeat: Infinity, delay: 2 }}
            style={{ background: "rgba(91,200,250,0.10)" }}
          />
          <div
            className="absolute inset-0 opacity-[0.05]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
              backgroundSize: "64px 64px",
              maskImage: "radial-gradient(ellipse at center, black 50%, transparent 95%)",
              WebkitMaskImage: "radial-gradient(ellipse at center, black 50%, transparent 95%)",
            }}
          />
        </div>

        <div className="relative max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 mb-7 px-3 py-1 rounded-full"
            style={{
              background: "linear-gradient(120deg, rgba(245,197,24,0.10), rgba(91,200,250,0.06))",
              border:     "1px solid rgba(245,197,24,0.30)",
              boxShadow:  "0 0 30px rgba(245,197,24,0.10)",
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
            <span className="font-display text-[10px] uppercase tracking-[0.22em] text-yellow/95 font-bold">
              MCP × Quack AI
            </span>
            <span className="text-white/20 text-xs">·</span>
            <span className="font-display text-[10px] uppercase tracking-[0.18em] text-white/55 font-semibold">
              v{MCP_VERSION} live on npm
            </span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.05 }}
            className="font-display text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.02]"
          >
            Your agent <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(120deg, #F5C518 0%, #FFE599 45%, #5BC8FA 100%)",
              }}
            >
              has a checking account.
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="text-base md:text-lg text-white/70 mt-6 max-w-3xl leading-relaxed"
          >
            10 EVM chains, gasless stablecoin payments, any MCP client. One install. Ask your AI to set it up.
          </motion.p>

          {/* works-with logo strip */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.26 }}
            className="mt-7 flex items-center gap-3 flex-wrap"
          >
            <span className="font-display text-[10px] uppercase tracking-[0.22em] text-white/35 font-bold">
              works with
            </span>
            <div className="flex items-center gap-2.5 flex-wrap">
              {WORKS_WITH.map(c => (
                <span key={c.name} className="flex items-center gap-2 pr-3 pl-1.5 py-1.5 rounded-full border border-white/10 bg-white/[0.02]">
                  <LogoChip logo={c.logo} name={c.name} invert={c.invert} />
                  <span className="text-xs text-white/70 font-medium">{c.name}</span>
                </span>
              ))}
            </div>
          </motion.div>

          {/* Install  4-client tabs */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.34 }}
            className="mt-10 max-w-3xl"
          >
            <div className="font-display text-[10px] uppercase tracking-[0.22em] text-white/30 font-bold mb-2">
              install · pick your client
            </div>

            {/* Tab row */}
            <div
              className="flex flex-wrap gap-1 p-1 rounded-2xl border mb-2"
              style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
            >
              {CLIENTS.map(c => {
                const isActive = activeClient === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setActiveClient(c.key)}
                    className={`font-display flex items-center gap-2 px-3.5 py-2 rounded-full text-xs font-bold transition-colors ${
                      isActive
                        ? "bg-yellow/20 text-yellow border border-yellow/40"
                        : "text-white/60 hover:text-white/90 border border-transparent"
                    }`}
                  >
                    <LogoChip logo={c.logo} name={c.name} invert={c.invert} size="sm" />
                    {c.name}
                  </button>
                );
              })}
            </div>

            {/* Snippet box  same min-h across CLI / JSON so switching tabs
                doesn't jump the layout. */}
            <div
              className="relative px-4 py-3.5 rounded-2xl font-mono text-sm overflow-hidden min-h-[180px] flex flex-col"
              style={{
                background: "linear-gradient(120deg, rgba(245,197,24,0.06), rgba(255,255,255,0.02))",
                border:     "1px solid rgba(245,197,24,0.30)",
                boxShadow:  "0 0 35px rgba(245,197,24,0.08)",
              }}
            >
              <motion.span
                className="absolute inset-y-0 w-20 -skew-x-12 pointer-events-none"
                initial={{ x: "-150%" }}
                animate={{ x: "550%" }}
                transition={{ duration: 4.2, repeat: Infinity, repeatDelay: 3, ease: "easeInOut" }}
                style={{ background: "linear-gradient(90deg, transparent, rgba(255,224,160,0.18), transparent)" }}
              />
              {current.kind === "cli" ? (
                <div className="relative flex flex-col gap-3 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="text-yellow/80">$</span>
                    <span className="flex-1 truncate text-white/85">{current.snippet}</span>
                    <CopyButton value={current.snippet} />
                  </div>
                  <div className="text-[11px] text-white/35 leading-relaxed">
                    The command writes the q402 entry into{" "}
                    <code className="text-white/55">
                      {current.key === "claude" ? "~/.claude.json" : "~/.codex/config.toml"}
                    </code>
                    {" "}for you. No need to find or edit the file by hand.
                    {current.key === "codex" && (
                      <> If you already have other MCP servers configured there, it&apos;s worth
                      backing the file up before running. Codex CLI handles the merge but the
                      behavior is its own to define, not ours.</>
                    )}
                  </div>
                </div>
              ) : (
                <div className="relative flex flex-col flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[10px] uppercase tracking-widest text-white/35 font-semibold">
                      paste as JSON
                    </span>
                    <CopyButton value={current.snippet} />
                  </div>
                  <pre className="text-xs text-white/85 whitespace-pre overflow-x-auto leading-relaxed">{current.snippet}</pre>
                  {current.innerSnippet && (
                    <details className="mt-3 group">
                      <summary className="text-[11px] text-yellow/70 hover:text-yellow cursor-pointer select-none list-none flex items-center gap-1.5">
                        <span className="inline-block transition-transform group-open:rotate-90 text-white/35">▸</span>
                        Already have <code className="text-white/55 text-[11px]">{current.configPath}</code> with other MCP servers?
                      </summary>
                      <div className="mt-2 text-[11px] text-white/70 leading-relaxed pl-4">
                        Paste this <strong className="text-white/90">inside</strong> the existing <code className="text-white/85 text-[11px]">mcpServers</code> object (don&apos;t replace the file):
                        <div className="mt-2 flex items-center gap-2">
                          <pre className="flex-1 text-[11px] text-white/85 whitespace-pre overflow-x-auto leading-relaxed">{current.innerSnippet}</pre>
                          <CopyButton value={current.innerSnippet} label="Copy entry" />
                        </div>
                      </div>
                    </details>
                  )}
                  {current.kind === "json" && current.configPath && (
                    <details className="mt-2 group">
                      <summary className="text-[11px] text-yellow/70 hover:text-yellow cursor-pointer select-none list-none flex items-center gap-1.5">
                        <span className="inline-block transition-transform group-open:rotate-90 text-white/35">▸</span>
                        Don&apos;t have <code className="text-white/55 text-[11px]">{current.configPath}</code> yet? Create it.
                      </summary>
                      <div className="mt-2 text-[11px] text-white/70 leading-relaxed pl-4 space-y-2">
                        <div>
                          <div className="font-display text-[10px] uppercase tracking-widest text-white/55 font-semibold mb-1">macOS / Linux</div>
                          <pre className="text-[11px] text-white/85 whitespace-pre overflow-x-auto bg-white/[0.02] rounded px-2 py-1.5">{`mkdir -p ~/.cursor && code ~/.cursor/mcp.json`}</pre>
                        </div>
                        <div>
                          <div className="font-display text-[10px] uppercase tracking-widest text-white/55 font-semibold mb-1">Windows (PowerShell)</div>
                          <pre className="text-[11px] text-white/85 whitespace-pre overflow-x-auto bg-white/[0.02] rounded px-2 py-1.5">{`New-Item -ItemType Directory -Force "$env:USERPROFILE\\.cursor" | Out-Null; code "$env:USERPROFILE\\.cursor\\mcp.json"`}</pre>
                        </div>
                        <div className="text-white/55">
                          Paste the snippet, save, reload. Cline edits config from inside VS Code, no shell.
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>

            <p className="text-[11px] text-white/40 mt-2 leading-relaxed">{current.hint}</p>

            {/* doctor-first call-to-action  the actual setup prompt */}
            <div
              className="mt-5 px-4 py-3 rounded-2xl flex items-start gap-3"
              style={{ background: "rgba(245,197,24,0.05)", border: "1px solid rgba(245,197,24,0.20)" }}
            >
              <span className="text-yellow/90 text-xs font-bold mt-0.5">→</span>
              <p className="text-white/80 text-sm leading-relaxed">
                Restart, ask:{" "}
                <span className="text-white font-semibold">&ldquo;Set up Q402&rdquo;</span>.{" "}
                It runs <code className="text-yellow text-xs">q402_doctor</code>, creates{" "}
                <code className="text-yellow text-xs">~/.q402/mcp.env</code>, walks you through pasting keys in your editor, never in chat.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* WALLET MODE PICKER */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <motion.div className="mb-8" {...revealProps()}>
            <div className="font-display text-[10px] uppercase tracking-[0.22em] text-yellow/80 font-bold mb-2">
              3 wallet modes · pick one
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-bold text-white mb-3">
              Do I need a private key?
            </h2>
            <p className="text-white/75 text-sm md:text-base max-w-2xl leading-relaxed">
              Two modes use a local PK; one lets Q402 sign server-side. Most users want{" "}
              <span className="text-yellow font-semibold">Mode C</span>, no PK, just an API key.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Mode C  Recommended */}
            <motion.div
              className="rounded-2xl border p-5 relative"
              style={{
                background: "rgba(245,197,24,0.04)",
                borderColor: "rgba(245,197,24,0.30)",
              }}
              {...revealProps(0.05)}
            >
              <div className="absolute -top-2 right-3 font-display text-[9px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-full bg-yellow text-navy">
                Recommended
              </div>
              <div className="font-display text-[10px] uppercase tracking-[0.18em] text-yellow/85 font-semibold mb-1">
                Mode C
              </div>
              <div className="font-display text-white font-semibold text-base mb-2">
                Server signs for you
              </div>
              <div className="text-[12.5px] text-white/75 leading-relaxed mb-3">
                <span className="text-yellow font-medium">No PK in env.</span> No MetaMask popup. Best for AI agents.
              </div>
              <div className="text-[10.5px] text-white/45 leading-relaxed">
                Set in <code className="text-yellow text-[10px]">~/.q402/mcp.env</code>:
              </div>
              <pre className="mt-1 text-[10.5px] text-yellow/85 font-mono bg-black/30 rounded px-2 py-1 leading-tight">
{`Q402_MULTICHAIN_API_KEY=q402_live_…`}
              </pre>
            </motion.div>

            {/* Mode B */}
            <motion.div
              className="rounded-2xl border p-5"
              style={{
                background: "rgba(255,255,255,0.02)",
                borderColor: "rgba(255,255,255,0.08)",
              }}
              {...revealProps(0.12)}
            >
              <div className="font-display text-[10px] uppercase tracking-[0.18em] text-white/55 font-semibold mb-1">
                Mode B
              </div>
              <div className="font-display text-white font-semibold text-base mb-2">
                Local Agent Wallet PK
              </div>
              <div className="text-[12.5px] text-white/75 leading-relaxed mb-3">
                Mode C&apos;s wallet, your private key. Export once from the dashboard. Local signing; MetaMask untouched.
              </div>
              <div className="text-[10.5px] text-white/45 leading-relaxed">
                Set in <code className="text-yellow text-[10px]">~/.q402/mcp.env</code>:
              </div>
              <pre className="mt-1 text-[10.5px] text-yellow font-mono bg-black/30 rounded px-2 py-1 leading-tight whitespace-pre">
{`Q402_AGENTIC_PRIVATE_KEY=0x…
Q402_MULTICHAIN_API_KEY=q402_live_…`}
              </pre>
            </motion.div>

            {/* Mode A */}
            <motion.div
              className="rounded-2xl border p-5"
              style={{
                background: "rgba(255,255,255,0.02)",
                borderColor: "rgba(255,255,255,0.08)",
              }}
              {...revealProps(0.19)}
            >
              <div className="font-display text-[10px] uppercase tracking-[0.18em] text-white/55 font-semibold mb-1">
                Mode A
              </div>
              <div className="font-display text-white font-semibold text-base mb-2">
                Your MetaMask EOA signs
              </div>
              <div className="text-[12.5px] text-white/75 leading-relaxed mb-3">
                Your MetaMask EOA signs directly via EIP-7702 (shows &quot;Smart account&quot;, reversible). <span className="text-[#5BC8FA]">Use a fresh wallet.</span>
              </div>
              <div className="text-[10.5px] text-white/45 leading-relaxed">
                Set in <code className="text-yellow text-[10px]">~/.q402/mcp.env</code>:
              </div>
              <pre className="mt-1 text-[10.5px] text-yellow font-mono bg-black/30 rounded px-2 py-1 leading-tight whitespace-pre">
{`Q402_PRIVATE_KEY=0x…
Q402_MULTICHAIN_API_KEY=q402_live_…`}
              </pre>
            </motion.div>
          </div>

          <div className="mt-6 text-[11px] text-white/60 leading-relaxed max-w-2xl">
            Change later by editing <code className="text-yellow">~/.q402/mcp.env</code>.{" "}
            <code className="text-yellow">q402_doctor</code> asks on first install.
          </div>
        </div>
      </section>

      {/* LIVE QUOTE SIMULATION */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
            <div>
              <div className="font-display text-[10px] uppercase tracking-[0.22em] text-yellow/80 font-bold mb-2">
                live demo · q402_quote
              </div>
              <h2 className="font-display text-2xl md:text-4xl font-bold">
                The exact tool your agent calls.
              </h2>
              <p className="text-white/65 text-sm mt-2 max-w-xl">
                Change the amount or token. The table re-ranks chains by gas, same as the MCP server returns to the agent.
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3 mt-6 mb-5">
            <div className="flex items-center gap-2">
              <span className="font-display text-xs text-white/35 uppercase tracking-widest font-semibold">
                Amount
              </span>
              <div
                className="flex items-center gap-1.5 px-3 py-2 rounded-full font-mono text-sm"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border:     "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <span className="text-white/40">$</span>
                <input
                  type="text"
                  value={amount}
                  onChange={e => {
                    const v = e.target.value;
                    if (/^\d{0,8}(\.\d{0,2})?$/.test(v)) setAmount(v);
                  }}
                  className="bg-transparent outline-none w-20 text-yellow font-bold"
                />
              </div>
            </div>
            <div className="flex items-center gap-1 ml-auto">
              {(["ANY", "USDC", "USDT", "RLUSD"] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTokenFilter(t)}
                  className={`font-display px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${
                    tokenFilter === t
                      ? "bg-yellow/20 text-yellow border border-yellow/40"
                      : "text-white/40 hover:text-white/80 border border-transparent"
                  }`}
                >
                  {t === "ANY" ? "ALL TOKENS" : t}
                </button>
              ))}
            </div>
          </div>

          {/* Animated ranking */}
          <div
            className="rounded-2xl overflow-hidden"
            style={{
              background: "linear-gradient(180deg, rgba(245,197,24,0.04) 0%, rgba(255,255,255,0.02) 100%)",
              border:     "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div
              className="font-display px-5 py-3 flex items-center gap-3 border-b text-[11px] uppercase tracking-[0.18em] text-white/40 font-semibold"
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
            >
              <span className="w-6">#</span>
              <span className="flex-1">Chain</span>
              <span className="w-20 text-right">Gas token</span>
              <span className="w-28 text-right">Approx gas</span>
              <span className="w-16 text-right">Sender</span>
            </div>
            <ul>
              <AnimatePresence initial={false}>
                {ranked.map((c, i) => (
                  <motion.li
                    layout
                    key={c.key}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.35, delay: i * 0.04 }}
                    className="px-5 py-3.5 flex items-center gap-3 text-sm border-b last:border-0"
                    style={{ borderColor: "rgba(255,255,255,0.04)" }}
                  >
                    <span
                      className={`w-6 font-mono text-xs font-bold ${
                        i === 0 ? "text-yellow" : "text-white/30"
                      }`}
                    >
                      {i === 0 ? "★" : i + 1}
                    </span>
                    <span className="flex-1 flex items-center gap-2">
                      <span className="text-white/85 font-medium">{c.name}</span>
                      <span className="text-[10px] text-white/30 font-mono">
                        chain {c.chainId}
                      </span>
                      {c.note && (
                        <span className="hidden md:inline text-[10px] text-white/35 ml-1 italic">
                          {c.note}
                        </span>
                      )}
                    </span>
                    <span className="w-20 text-right text-white/55 font-mono text-xs">
                      {c.gas}
                    </span>
                    <span
                      className={`w-28 text-right font-mono text-xs font-semibold ${
                        i === 0 ? "text-yellow" : "text-white/65"
                      }`}
                    >
                      ${c.approxGasCostUsd.toFixed(c.approxGasCostUsd >= 1 ? 2 : 4)}
                    </span>
                    <span className="w-16 text-right text-yellow/85 font-bold text-xs">
                      $0.00
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
            <div
              className="px-5 py-3 text-[11px] text-white/30 border-t"
              style={{ borderColor: "rgba(255,255,255,0.04)" }}
            >
              {`Sending $${amount || "0"} ${tokenFilter === "ANY" ? "USDC, USDT, or RLUSD" : tokenFilter}` +
                `. Your agent picks ${ranked[0]?.name ?? "any chain"} by default. Sender always pays $0;` +
                " gas comes from the developer's pre-funded gas tank."}
            </div>
          </div>
        </div>
      </section>

      {/* TOOLS  grouped, iconographic card grid */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <motion.div {...revealProps()}>
            <div className="font-display text-[10px] uppercase tracking-[0.22em] text-white/55 font-bold mb-2">
              twenty tools · one package
            </div>
            <h2 className="font-display text-2xl md:text-4xl font-bold mb-2">
              Only what an agent should reach for.
            </h2>
            <p className="text-white/65 text-sm max-w-xl mb-10">
              No hidden admin endpoints. Nothing moves funds outside the confirm-and-sign flow.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
            {TOOL_GROUPS.map((g, gi) => {
              const tools = TOOLS.filter(t => t.group === g.key);
              return (
                <motion.div
                  key={g.key}
                  className="rounded-2xl border p-5"
                  style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.012))",
                    borderColor: "rgba(255,255,255,0.09)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 24px 50px -38px rgba(0,0,0,0.95)",
                  }}
                  {...revealProps(0.04 * gi)}
                >
                  <div className="flex items-center gap-3 mb-4">
                    <span
                      className="w-9 h-9 rounded-xl grid place-items-center flex-shrink-0 text-yellow"
                      style={{ background: "rgba(245,197,24,0.08)", border: "1px solid rgba(245,197,24,0.18)" }}
                    >
                      <GroupIcon group={g.key} />
                    </span>
                    <div>
                      <div className="font-display text-base font-bold text-white leading-tight">{g.label}</div>
                      <div className="text-[11px] text-white/45">{g.blurb}</div>
                    </div>
                    <span className="font-mono text-[10px] text-white/30 ml-auto">{tools.length}</span>
                  </div>
                  <ul className="space-y-2.5">
                    {tools.map(t => (
                      <li
                        key={t.name}
                        className="rounded-xl px-3 py-2.5"
                        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
                      >
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <code className="text-yellow font-mono text-[12px] font-bold">{t.name}</code>
                          <span className="font-display text-[9px] uppercase tracking-widest font-semibold text-[#5BC8FA]/70 border border-[#5BC8FA]/20 rounded-full px-1.5 py-0.5">
                            {t.auth}
                          </span>
                        </div>
                        <div className="text-white/60 text-[12.5px] leading-relaxed">{t.note}</div>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              );
            })}
          </div>

          <p className="text-[11px] text-white/35 mt-8">
            Full reference, EIP-7702 details, Trust Receipt + safety guards:{" "}
            <Link href="/docs#claude-mcp" className="text-yellow/80 hover:text-yellow underline-offset-2 hover:underline">
              /docs, MCP for AI Clients
            </Link>
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
