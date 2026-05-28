"use client";

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import { MCP_VERSION } from "@/app/lib/version";

/**
 * /claude — landing page for @quackai/q402-mcp.
 *
 * URL kept as `/claude` for backlink stability (npm README, Anthropic
 * Registry, prior tweets all link here), but the page itself is MCP-
 * canonical: Claude / Codex / Cursor / Cline are first-class equals.
 *
 * Three sections total — hero (with 4-client tabbed install), live
 * `q402_quote` simulation, eight-tool compact list. Trust Receipt,
 * Safety guards, and CTA all moved to /docs to keep the page from
 * duplicating documentation that already lives there.
 *
 * Wider container (`max-w-[88rem]`) than the rest of the site — the
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
  { key: "injective", name: "Injective EVM",     chainId: 1776,   gas: "INJ",   approxGasCostUsd: 0.004,  tokens: ["USDT"], note: "USDT only — Circle CCTP USDC announced for Q2 2026" },
  { key: "monad",     name: "Monad",             chainId: 143,    gas: "MON",   approxGasCostUsd: 0.002,  tokens: ["USDC", "USDT"] },
  { key: "scroll",    name: "Scroll",            chainId: 534352, gas: "ETH",   approxGasCostUsd: 0.001,  tokens: ["USDC", "USDT"], note: "zkEVM L2 — EIP-7702 live since Euclid Phase 2 (2025-04-22)." },
  { key: "eth",       name: "Ethereum Mainnet",  chainId: 1,      gas: "ETH",   approxGasCostUsd: 1.2,    tokens: ["USDC", "USDT", "RLUSD"], note: "L1 — gas is volatile. RLUSD (Ripple USD, NY DFS regulated) Ethereum-only." },
];

// ── 4-client install matrix ─────────────────────────────────────────────────
// Each client has either a one-line CLI command (Claude / Codex) or a JSON
// snippet pasted into a config file (Cursor / Cline). Same npm package
// underneath — no client-specific server code.
type ClientKey = "claude" | "codex" | "cursor" | "cline";

// Full mcp.json shape — save as-is when the file does not yet exist.
const SHARED_JSON_FULL = `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`;

// Inner entry — paste INSIDE an existing `mcpServers` object when the
// file already has other MCP servers. We surface this as the safe path
// for any user who already wired up another MCP server, since pasting
// the full SHARED_JSON_FULL would clobber whatever else is there.
const SHARED_JSON_INNER = `"q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] }`;

interface ClientInstall {
  key:           ClientKey;
  name:          string;
  logo:          string;
  kind:          "cli" | "json";
  /** Primary snippet — the one shown front-and-center in the tab. */
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
    hint:    "OpenAI Codex CLI. Restart Codex (`codex` → quit, then re-launch) after running. On Windows, if `codex mcp add` returns \"Access is denied\", add the equivalent stanza to `~/.codex/config.toml` by hand: `[mcp_servers.q402]` / `command = \"npx\"` / `args = [\"-y\", \"@quackai/q402-mcp\"]`.",
  },
  {
    key:          "cursor",
    name:         "Cursor",
    logo:         "/logos/cursor.svg",
    kind:         "json",
    snippet:      SHARED_JSON_FULL,
    innerSnippet: SHARED_JSON_INNER,
    configPath:   "~/.cursor/mcp.json",
    hint:         "Save the full snippet as ~/.cursor/mcp.json if the file is new. After saving, reload Cursor (Cmd/Ctrl+Shift+P → Developer: Reload Window).",
  },
  {
    key:          "cline",
    name:         "Cline",
    logo:         "/logos/cline.svg",
    kind:         "json",
    snippet:      SHARED_JSON_FULL,
    innerSnippet: SHARED_JSON_INNER,
    configPath:   "Cline → Settings → MCP Servers → Edit JSON",
    hint:         "Open Cline's MCP servers JSON editor and paste. Reload VS Code (Cmd/Ctrl+Shift+P → Developer: Reload Window) when done.",
  },
];

// ── 8-tool flat list ────────────────────────────────────────────────────────
// Compact row layout (NOT the previous card grid) — the cards burned a lot
// of vertical space + duplicated content from /docs#claude-mcp.
const TOOLS: Array<{ name: string; auth: string; note: string }> = [
  { name: "q402_doctor",           auth: "no auth",     note: "First-install onboarding + ongoing health check. Call this when the user says \"set up Q402\" or \"is Q402 working\"." },
  { name: "q402_quote",            auth: "no auth",     note: "Compare gas + supported tokens across 9 chains. Read-only — works without any setup." },
  { name: "q402_balance",          auth: "api key",     note: "Verify the configured API key(s) and report each one's plan tier + remaining quota credits." },
  { name: "q402_pay",              auth: "live mode",   note: "Send a gasless USDC, USDT, or RLUSD payment to a single recipient. Sandbox by default." },
  { name: "q402_batch_pay",        auth: "live mode",   note: "Up to 20 recipients in one signed batch on a single chain × token (trial keys: 5)." },
  { name: "q402_receipt",          auth: "no auth",     note: "Fetch + locally verify a Trust Receipt by rct_… id (ECDSA recovery against the relayer EOA)." },
  { name: "q402_wallet_status",    auth: "private key", note: "Per-chain EIP-7702 delegation status for the EOA derived from Q402_PRIVATE_KEY. Read-only." },
  { name: "q402_clear_delegation", auth: "private key", note: "Clear the EIP-7702 delegation on a single chain. Local signing; Q402 sponsors the on-chain TX." },
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
      className={`text-[11px] px-2.5 py-1 rounded-md font-semibold transition-all ${
        copied
          ? "bg-green-400/15 text-green-400"
          : "bg-white/5 text-white/45 hover:bg-yellow/15 hover:text-yellow"
      }`}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

export default function ClaudePage() {
  const [amount, setAmount]           = useState("50");
  const [tokenFilter, setTokenFilter] = useState<"USDC" | "USDT" | "RLUSD" | "ANY">("ANY");
  const [activeClient, setActiveClient] = useState<ClientKey>("claude");

  const current = CLIENTS.find(c => c.key === activeClient)!;

  const ranked = useMemo(() => {
    const filtered = CHAINS.filter(c =>
      tokenFilter === "ANY" ? true : c.tokens.includes(tokenFilter),
    );
    return [...filtered].sort((a, b) => a.approxGasCostUsd - b.approxGasCostUsd);
  }, [tokenFilter]);

  return (
    <div className="min-h-screen text-white" style={{ background: "#06060C" }}>
      {/* ── Top nav (slim) ─────────────────────────────────────────────── */}
      <header
        className="border-b sticky top-0 z-30 backdrop-blur-md"
        style={{ background: "rgba(6,6,12,0.82)", borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="max-w-[88rem] mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
              <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
            </span>
            <span className="text-yellow font-bold text-base tracking-tight">Q402</span>
            <span className="text-white/20 text-xs">/</span>
            <span className="text-orange-300/70 text-xs font-medium">mcp</span>
          </Link>
          <div className="flex items-center gap-4 text-xs text-white/45">
            <Link href="/docs#claude-mcp" className="hover:text-white">Docs</Link>
            <Link href="/dashboard" className="hover:text-white">Dashboard</Link>
            <a
              href="https://www.npmjs.com/package/@quackai/q402-mcp"
              target="_blank"
              rel="noreferrer"
              className="hover:text-yellow"
            >
              npm
            </a>
            <a
              href="https://github.com/bitgett/q402-mcp"
              target="_blank"
              rel="noreferrer"
              className="hover:text-yellow"
            >
              GitHub
            </a>
          </div>
        </div>
      </header>

      {/* ── HERO ───────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        {/* Background atmosphere — keep the existing gradient blooms; cheap and on-brand. */}
        <div className="absolute inset-0 pointer-events-none">
          <motion.div
            className="absolute -top-40 -left-40 w-[700px] h-[700px] rounded-full blur-[160px]"
            animate={{ opacity: [0.35, 0.6, 0.35] }}
            transition={{ duration: 8, repeat: Infinity }}
            style={{ background: "rgba(245,158,11,0.13)" }}
          />
          <motion.div
            className="absolute -bottom-40 -right-32 w-[640px] h-[640px] rounded-full blur-[150px]"
            animate={{ opacity: [0.25, 0.55, 0.25] }}
            transition={{ duration: 10, repeat: Infinity, delay: 2 }}
            style={{ background: "rgba(139,92,246,0.10)" }}
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

        <div className="relative max-w-[88rem] mx-auto px-6 py-20 md:py-24">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 mb-7 px-3 py-1 rounded-full"
            style={{
              background: "linear-gradient(120deg, rgba(245,158,11,0.10), rgba(139,92,246,0.06))",
              border:     "1px solid rgba(245,158,11,0.30)",
              boxShadow:  "0 0 30px rgba(245,158,11,0.10)",
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-orange-300 animate-pulse" />
            <span className="text-[10px] uppercase tracking-[0.22em] text-orange-300/95 font-bold">
              MCP × Quack AI
            </span>
            <span className="text-white/20 text-xs">·</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-white/55 font-semibold">
              v{MCP_VERSION} live on npm
            </span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.05 }}
            className="text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.02]"
          >
            Your agent <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(120deg, #F59E0B 0%, #F5C518 40%, #FFE599 70%, #C4B5FD 100%)",
              }}
            >
              has a checking account.
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="text-base md:text-lg text-white/55 mt-6 max-w-3xl leading-relaxed"
          >
            Q402 makes 9 EVM chains feel like one rail — gasless, instant, from any
            MCP client. One install, ask your agent to set it up, send your first
            stablecoin payment.
          </motion.p>

          {/* ── Install — 4-client tabs ──────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="mt-10 max-w-3xl"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/30 font-bold mb-2">
              install · pick your client
            </div>

            {/* Tab row */}
            <div
              className="flex flex-wrap gap-1 p-1 rounded-xl border mb-2"
              style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
            >
              {CLIENTS.map(c => {
                const isActive = activeClient === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setActiveClient(c.key)}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-colors ${
                      isActive
                        ? "bg-yellow/20 text-yellow border border-yellow/40"
                        : "text-white/60 hover:text-white/90 border border-transparent"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.logo} alt={c.name} className="w-4 h-4" />
                    {c.name}
                  </button>
                );
              })}
            </div>

            {/* Snippet box — same min-h across CLI / JSON so switching tabs
                doesn't jump the layout. */}
            <div
              className="relative px-4 py-3.5 rounded-xl font-mono text-sm overflow-hidden min-h-[180px] flex flex-col"
              style={{
                background: "linear-gradient(120deg, rgba(245,158,11,0.06), rgba(255,255,255,0.02))",
                border:     "1px solid rgba(245,158,11,0.30)",
                boxShadow:  "0 0 35px rgba(245,158,11,0.08)",
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
                    {" "}for you — no need to find or edit the file by hand.
                    {current.key === "codex" && (
                      <> If you already have other MCP servers configured there, it&apos;s worth
                      backing the file up before running — Codex CLI handles the merge but the
                      behavior is its own to define, not ours.</>
                    )}
                  </div>
                </div>
              ) : (
                <div className="relative flex flex-col flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-widest text-white/35 font-semibold">
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
                      <div className="mt-2 text-[11px] text-white/55 leading-relaxed pl-4">
                        Don&apos;t replace the file — that&apos;d clobber your other servers. Open
                        it and add this entry <strong className="text-white/75">inside</strong> the
                        existing <code className="text-white/60 text-[11px]">mcpServers</code> object:
                        <div className="mt-2 flex items-center gap-2">
                          <pre className="flex-1 text-[11px] text-white/75 whitespace-pre overflow-x-auto leading-relaxed">{current.innerSnippet}</pre>
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
                      <div className="mt-2 text-[11px] text-white/55 leading-relaxed pl-4 space-y-2">
                        <div>The file lives in a hidden dot-directory. Quickest way to create + open it:</div>
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-white/35 font-semibold mb-1">macOS / Linux</div>
                          <pre className="text-[11px] text-white/75 whitespace-pre overflow-x-auto bg-white/[0.02] rounded px-2 py-1.5">{`mkdir -p ~/.cursor && code ~/.cursor/mcp.json`}</pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-white/35 font-semibold mb-1">Windows (PowerShell)</div>
                          <pre className="text-[11px] text-white/75 whitespace-pre overflow-x-auto bg-white/[0.02] rounded px-2 py-1.5">{`New-Item -ItemType Directory -Force "$env:USERPROFILE\\.cursor" | Out-Null; code "$env:USERPROFILE\\.cursor\\mcp.json"`}</pre>
                        </div>
                        <div className="text-white/40">
                          Paste the JSON snippet above, save, and reload the window. (Replace <code className="text-white/55 text-[11px]">.cursor</code> with the relevant client&apos;s path if you&apos;re on Cline — Cline edits its config from inside VS Code, no shell needed.)
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>

            <p className="text-[11px] text-white/40 mt-2 leading-relaxed">{current.hint}</p>

            {/* doctor-first call-to-action — the actual setup prompt */}
            <div
              className="mt-5 px-4 py-3 rounded-lg flex items-start gap-3"
              style={{ background: "rgba(74,222,128,0.05)", border: "1px solid rgba(74,222,128,0.20)" }}
            >
              <span className="text-green-400/90 text-xs font-bold mt-0.5">→</span>
              <p className="text-white/70 text-sm leading-relaxed">
                After restarting, ask your agent:{" "}
                <span className="text-white font-semibold">&ldquo;Set up Q402&rdquo;</span>.
                <br />
                It calls <code className="text-yellow text-xs">q402_doctor</code>, which creates
                {" "}<code className="text-yellow text-xs">~/.q402/mcp.env</code> with placeholders
                and walks you through pasting your API key + wallet private key — in your editor,
                never in chat.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── WALLET MODE PICKER ─────────────────────────────────────────── */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <div className="mb-8">
            <div className="text-[10px] uppercase tracking-[0.22em] text-yellow/80 font-bold mb-2">
              3 wallet modes · pick one
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-3">
              Do I need a private key?
            </h2>
            <p className="text-white/65 text-sm md:text-base max-w-2xl leading-relaxed">
              Depends which mode. Two modes sign locally with a private key; one
              lets Q402&apos;s server sign for you. Most users want{" "}
              <span className="text-emerald-300 font-semibold">Mode C</span> — no PK,
              just an API key.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Mode C — Recommended */}
            <div
              className="rounded-lg border p-5 relative"
              style={{
                background: "rgba(74,222,128,0.04)",
                borderColor: "rgba(74,222,128,0.30)",
              }}
            >
              <div className="absolute -top-2 right-3 text-[9px] uppercase tracking-widest font-bold px-2 py-0.5 rounded bg-emerald-500 text-black">
                Recommended
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/85 font-semibold mb-1">
                Mode C
              </div>
              <div className="text-white font-semibold text-base mb-2">
                Server signs for you
              </div>
              <div className="text-[12.5px] text-white/65 leading-relaxed mb-3">
                Q402 holds an encrypted Agent Wallet for you. <span className="text-emerald-300 font-medium">No private key in your env.</span>{" "}
                No MetaMask popup. No Smart-account marker. Best for AI agents + most users.
              </div>
              <div className="text-[10.5px] text-white/45 leading-relaxed">
                Set in <code className="text-yellow text-[10px]">~/.q402/mcp.env</code>:
              </div>
              <pre className="mt-1 text-[10.5px] text-emerald-300/85 font-mono bg-black/30 rounded px-2 py-1 leading-tight">
{`Q402_MULTICHAIN_API_KEY=q402_live_…`}
              </pre>
            </div>

            {/* Mode B */}
            <div
              className="rounded-lg border p-5"
              style={{
                background: "rgba(255,255,255,0.02)",
                borderColor: "rgba(255,255,255,0.08)",
              }}
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 font-semibold mb-1">
                Mode B
              </div>
              <div className="text-white font-semibold text-base mb-2">
                Local Agent Wallet PK
              </div>
              <div className="text-[12.5px] text-white/65 leading-relaxed mb-3">
                Same Agent Wallet as Mode C, but YOU hold the private key. Export it from the dashboard once, paste into the env. MCP signs locally — key never leaves your machine. Your MetaMask is never touched.
              </div>
              <div className="text-[10.5px] text-white/45 leading-relaxed">
                Set in <code className="text-yellow text-[10px]">~/.q402/mcp.env</code>:
              </div>
              <pre className="mt-1 text-[10.5px] text-yellow font-mono bg-black/30 rounded px-2 py-1 leading-tight whitespace-pre">
{`Q402_AGENTIC_PRIVATE_KEY=0x…
Q402_MULTICHAIN_API_KEY=q402_live_…`}
              </pre>
            </div>

            {/* Mode A */}
            <div
              className="rounded-lg border p-5"
              style={{
                background: "rgba(255,255,255,0.02)",
                borderColor: "rgba(255,255,255,0.08)",
              }}
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 font-semibold mb-1">
                Mode A
              </div>
              <div className="text-white font-semibold text-base mb-2">
                Your MetaMask EOA signs
              </div>
              <div className="text-[12.5px] text-white/65 leading-relaxed mb-3">
                Your existing EOA signs directly. EIP-7702 delegates it to Q402 for the call — the wallet shows a &quot;Smart account&quot; marker after first use (normal + reversible). Best for power users who want their MetaMask address to be the on-chain payer. <span className="text-amber-200/80">Use a fresh wallet.</span>
              </div>
              <div className="text-[10.5px] text-white/45 leading-relaxed">
                Set in <code className="text-yellow text-[10px]">~/.q402/mcp.env</code>:
              </div>
              <pre className="mt-1 text-[10.5px] text-yellow font-mono bg-black/30 rounded px-2 py-1 leading-tight whitespace-pre">
{`Q402_PRIVATE_KEY=0x…
Q402_MULTICHAIN_API_KEY=q402_live_…`}
              </pre>
            </div>
          </div>

          <div className="mt-6 text-[11px] text-white/45 leading-relaxed max-w-2xl">
            You can change later by editing <code className="text-yellow">~/.q402/mcp.env</code> and restarting your MCP client.{" "}
            <code className="text-yellow">q402_doctor</code> on first install also asks the question and walks you through whichever mode you pick.
          </div>
        </div>
      </section>

      {/* ── LIVE QUOTE SIMULATION ──────────────────────────────────────── */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-yellow/80 font-bold mb-2">
                live demo · q402_quote
              </div>
              <h2 className="text-2xl md:text-4xl font-bold">
                The exact tool your agent calls.
              </h2>
              <p className="text-white/50 text-sm mt-2 max-w-xl">
                Change the amount or token filter — the table re-ranks every chain by gas the
                same way the MCP server returns to the agent in real time.
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3 mt-6 mb-5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/35 uppercase tracking-widest font-semibold">
                Amount
              </span>
              <div
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-mono text-sm"
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
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
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
              className="px-5 py-3 flex items-center gap-3 border-b text-[11px] uppercase tracking-[0.18em] text-white/40 font-semibold"
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
                    <span className="w-16 text-right text-green-400/85 font-bold text-xs">
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
                ` — your agent picks ${ranked[0]?.name ?? "—"} by default. Sender always pays $0;` +
                " gas comes from the developer's pre-funded gas tank."}
            </div>
          </div>
        </div>
      </section>

      {/* ── TOOLS — flat 8-row list ─────────────────────────────────────── */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-[88rem] mx-auto px-6 py-16 md:py-20">
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/40 font-bold mb-2">
            nine tools · one package
          </div>
          <h2 className="text-2xl md:text-4xl font-bold mb-2">
            Only what an agent should reach for.
          </h2>
          <p className="text-white/50 text-sm max-w-xl mb-10">
            No hidden admin endpoints, no key-rotation paths, nothing in the agent surface
            that can move funds outside the explicit confirm-and-sign flow.
          </p>

          <ul className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
            {TOOLS.map(t => (
              <li
                key={t.name}
                className="flex items-baseline gap-4 md:gap-6 py-3.5"
                style={{ borderTopColor: "rgba(255,255,255,0.04)" }}
              >
                <code className="text-yellow font-mono text-xs md:text-sm font-bold whitespace-nowrap min-w-[12rem] md:min-w-[14rem]">
                  {t.name}
                </code>
                <span className="text-white/35 text-[10px] uppercase tracking-widest font-semibold whitespace-nowrap hidden md:inline-block min-w-[6rem]">
                  {t.auth}
                </span>
                <span className="text-white/65 text-sm leading-relaxed flex-1">
                  {t.note}
                </span>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-white/35 mt-8">
            Full reference, EIP-7702 details, Trust Receipt + safety guards:{" "}
            <Link href="/docs#claude-mcp" className="text-yellow/80 hover:text-yellow underline-offset-2 hover:underline">
              /docs → MCP for AI Clients
            </Link>
          </p>
        </div>
      </section>

      {/* ── Footer (minimal) ─────────────────────────────────────────────── */}
      <footer className="py-10">
        <div className="max-w-[88rem] mx-auto px-6 text-xs text-white/30 text-center">
          <a className="text-yellow/70 hover:text-yellow" href="https://www.npmjs.com/package/@quackai/q402-mcp">@quackai/q402-mcp</a>
          {" · "}
          <a className="text-yellow/70 hover:text-yellow" href="https://github.com/bitgett/q402-mcp">github.com/bitgett/q402-mcp</a>
          {" · "}
          <Link className="text-yellow/70 hover:text-yellow" href="/docs#claude-mcp">/docs → MCP for AI Clients</Link>
          <div className="mt-3 text-white/20">
            Apache-2.0 · Built by Quack AI Labs · MCP is an open standard from Anthropic.
          </div>
        </div>
      </footer>
    </div>
  );
}
