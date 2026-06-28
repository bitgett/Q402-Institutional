"use client";

/**
 * /claude - install + onboarding page for @quackai/q402-mcp.
 *
 * URL kept as `/claude` for backlink stability (npm README, Anthropic Registry,
 * prior tweets all link here), but the page is MCP-canonical: Claude / Codex /
 * Cursor / Cline are first-class equals.
 *
 * Shares the /agents design language (flat technical datasheet, Space Grotesk,
 * sticky numbered index gutter, hairline section rules, navy + #F5C518 + #5BC8FA
 * only) so the two product pages read as one family. But the composition is its
 * own: this is the hands-on page, so it leads with an interactive multi-client
 * install (Claude, Codex, Cursor, Cline, Copilot, Hermes), a wallet-mode
 * picker, a live q402_quote ranking, and the 30-tool
 * surface. No marketing-landing motifs (corner glows, gradient sheen titles).
 */

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";
import { MCP_VERSION } from "@/app/lib/version";
import { MCP_INSTALL, MCP_CLIENTS } from "@/app/lib/mcp-clients";

const INK = "#E6EAF2";
const MUT = "rgba(230,234,242,0.60)";
const MUT2 = "rgba(230,234,242,0.40)";
const LINE = "rgba(255,255,255,0.11)";
const HAIR = "rgba(255,255,255,0.07)";
const YELLOW = "#F5C518";
const CYAN = "#5BC8FA";

// ── chains for the live q402_quote ranking (all 11 EVM chains) ──────────────
interface ChainRow {
  key: string;
  name: string;
  chainId: number;
  gas: string;
  approxGasCostUsd: number;
  tokens: ReadonlyArray<"USDC" | "USDT" | "RLUSD">;
  note?: string;
}

const CHAINS: ChainRow[] = [
  { key: "stable", name: "Stable", chainId: 988, gas: "USDT0", approxGasCostUsd: 0.0005, tokens: ["USDC", "USDT"], note: "USDC and USDT both alias to USDT0" },
  { key: "bnb", name: "BNB Chain", chainId: 56, gas: "BNB", approxGasCostUsd: 0.001, tokens: ["USDC", "USDT"] },
  { key: "scroll", name: "Scroll", chainId: 534352, gas: "ETH", approxGasCostUsd: 0.001, tokens: ["USDC", "USDT"], note: "zkEVM L2, EIP-7702 since Euclid Phase 2" },
  { key: "arbitrum", name: "Arbitrum One", chainId: 42161, gas: "ETH", approxGasCostUsd: 0.0015, tokens: ["USDC", "USDT"], note: "Native USDC (not USDC.e) + USDT" },
  { key: "base", name: "Base", chainId: 8453, gas: "ETH", approxGasCostUsd: 0.0008, tokens: ["USDC", "USDT"], note: "OP Stack L2, EIP-7702 via Isthmus. USDT is bridged" },
  { key: "xlayer", name: "X Layer", chainId: 196, gas: "OKB", approxGasCostUsd: 0.002, tokens: ["USDC", "USDT"] },
  { key: "mantle", name: "Mantle", chainId: 5000, gas: "MNT", approxGasCostUsd: 0.002, tokens: ["USDC", "USDT"] },
  { key: "monad", name: "Monad", chainId: 143, gas: "MON", approxGasCostUsd: 0.002, tokens: ["USDC", "USDT"] },
  { key: "avax", name: "Avalanche C-Chain", chainId: 43114, gas: "AVAX", approxGasCostUsd: 0.003, tokens: ["USDC", "USDT"] },
  { key: "injective", name: "Injective EVM", chainId: 1776, gas: "INJ", approxGasCostUsd: 0.004, tokens: ["USDC", "USDT"] },
  { key: "eth", name: "Ethereum Mainnet", chainId: 1, gas: "ETH", approxGasCostUsd: 1.2, tokens: ["USDC", "USDT", "RLUSD"], note: "L1, volatile gas. RLUSD (Ripple USD) Ethereum-only" },
];

// ── install matrix + works-with strip live in app/lib/mcp-clients.ts ─────────
// CLIENTS = the per-client install rows (CLI / JSON / YAML). WORKS_WITH = the
// derived logo strip. Both share one source so the strip can't advertise a
// client the install matrix lacks (which is how Hermes/Copilot drifted before).
const CLIENTS = MCP_INSTALL;
const WORKS_WITH = MCP_CLIENTS;

// ── wallet modes (one unified panel, Mode C recommended) ────────────────────
const MODES: { tag: string; title: string; desc: React.ReactNode; env: string[]; rec?: boolean }[] = [
  {
    tag: "Mode C",
    title: "Server signs for you",
    desc: <><span style={{ color: YELLOW }}>No PK in env.</span> No MetaMask popup. Best for AI agents.</>,
    env: ["Q402_MULTICHAIN_API_KEY=q402_live_..."],
    rec: true,
  },
  {
    tag: "Mode B",
    title: "Local Agent Wallet PK",
    desc: "Mode C's wallet, your private key. Export once from the dashboard. Local signing, MetaMask untouched.",
    env: ["Q402_AGENTIC_PRIVATE_KEY=0x...", "Q402_MULTICHAIN_API_KEY=q402_live_..."],
  },
  {
    tag: "Mode A",
    title: "Your MetaMask EOA signs",
    desc: <>Signs directly via EIP-7702 (shows &quot;Smart account&quot;, reversible). <span style={{ color: YELLOW }}>Use a fresh wallet.</span></>,
    env: ["Q402_PRIVATE_KEY=0x...", "Q402_MULTICHAIN_API_KEY=q402_live_..."],
  },
];

// ── the 30-tool surface (grouped, with auth + one-line note) ────────────────
const TOOL_GROUPS: { label: string; tools: { name: string; auth: string; note: string }[] }[] = [
  {
    label: "Setup and read",
    tools: [
      { name: "q402_doctor", auth: "no auth", note: "Install + ongoing health check. Call on \"set up Q402\"." },
      { name: "q402_quote", auth: "no auth", note: "Compare gas across all 11 chains. Read-only." },
      { name: "q402_balance", auth: "api key", note: "Verify key + remaining quota." },
      { name: "q402_agentic_info", auth: "api key", note: "Agent Wallet info: addresses, caps, ERC-8004 id. Read-only." },
      { name: "q402_wallet_status", auth: "private key", note: "Per-chain EIP-7702 delegation state. Read-only." },
    ],
  },
  {
    label: "Pay",
    tools: [
      { name: "q402_pay", auth: "live mode", note: "Single-recipient gasless USDC / USDT / RLUSD send. Sandbox by default." },
      { name: "q402_batch_pay", auth: "live mode", note: "Up to 20 recipients in one signed batch (trial: 5 with your own key; server-managed Agent Wallet batch is paid Multichain-only)." },
    ],
  },
  {
    label: "Receipts",
    tools: [
      { name: "q402_receipt", auth: "no auth", note: "Fetch + locally verify a Trust Receipt." },
    ],
  },
  {
    label: "Recurring",
    tools: [
      { name: "q402_recurring_list", auth: "api key", note: "List recurring rules + next run." },
      { name: "q402_recurring_create", auth: "api key", note: "Author a recurring rule (paid Multichain only)." },
      { name: "q402_recurring_fires", auth: "api key", note: "Last 50 fires for one rule (timestamps + txHashes)." },
      { name: "q402_recurring_pause", auth: "api key", note: "Pause a rule. Reversible." },
      { name: "q402_recurring_resume", auth: "api key", note: "Resume a paused or stopped rule." },
      { name: "q402_recurring_skip_next", auth: "api key", note: "Skip only the next fire. Cadence preserved." },
      { name: "q402_recurring_cancel", auth: "api key", note: "Permanently stop a rule." },
    ],
  },
  {
    label: "Yield",
    tools: [
      { name: "q402_yield_reserves", auth: "no auth", note: "Markets + supply APY across curated lending vaults on BNB and Base. Read-only." },
      { name: "q402_yield_positions", auth: "api key", note: "Your open yield positions + total supplied. Read-only." },
      { name: "q402_yield_deposit", auth: "live mode", note: "Supply stablecoins into a curated lending vault (BNB USDC/USDT, Base USDC). Mode C. Sandbox by default." },
      { name: "q402_yield_withdraw", auth: "live mode", note: "Withdraw from a lending vault on BNB or Base (\"max\" = full). Sandbox by default." },
    ],
  },
  {
    label: "Staking",
    tools: [
      { name: "q402_stake", auth: "live mode", note: "Gasless Q staking on BNB. Lock tiers 0-3 (30d/10%, 60d/15%, 120d/32%, 180d/40% APR). amount \"max\" supported. Sandbox by default." },
      { name: "q402_unstake", auth: "live mode", note: "Gasless unstake of matured Q on BNB by record index, or all matured (per-record exit). Sandbox by default." },
      { name: "q402_stake_positions", auth: "live mode", note: "Read-only: the Agent Wallet's Q stakes (indices, maturity, exitable) + liquid Q balance." },
    ],
  },
  {
    label: "Bridge",
    tools: [
      { name: "q402_bridge_quote", auth: "no auth", note: "Quote CCIP fee for a USDC bridge on eth / avax / arbitrum." },
      { name: "q402_bridge_send", auth: "live key", note: "Execute a CCIP USDC bridge from your Agent Wallet (Mode C). Sandbox by default." },
      { name: "q402_bridge_history", auth: "owner sig", note: "List recent CCIP bridges. Owner-sig auth via dashboard." },
      { name: "q402_bridge_gas_tank", auth: "owner sig", note: "LINK + native Gas Tank bucket per CCIP chain." },
    ],
  },
  {
    label: "Delegation",
    tools: [
      { name: "q402_clear_delegation", auth: "private key / api key", note: "Clear EIP-7702 delegation on a chain (Mode A/B local key OR Mode C api key, server-signed). Sponsored except Ethereum (Gas Tank). Two-phase consentToken (preview then execute)." },
    ],
  },
  {
    label: "Requests",
    tools: [
      { name: "q402_request_create", auth: "api key", note: "Publish a payment request (invoice). No funds move; returns a /pay link + req_ id." },
      { name: "q402_request_status", auth: "no auth", note: "Look up a request by req_ id: amount, recipient, status. Read-only." },
      { name: "q402_request_pay", auth: "live mode", note: "Pay a request gaslessly from your own Agent Wallet. Terms locked to the request." },
    ],
  },
];
const TOOL_COUNT = TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0); // 30

const rise = {
  initial: { opacity: 0, y: 10 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { amount: 0.2, once: true } as const,
  transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
};

// ── shared bits ─────────────────────────────────────────────────────────────

// Small document mark for the Docs chip (inherits chip color). ---------------
function IconDoc() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 1.8h4.5L12 5.3v8.9H4z" />
      <path d="M8.4 1.8v3.4H12" />
      <path d="M5.8 8.6h4.4M5.8 11h4.4" />
    </svg>
  );
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }).catch(() => {});
        }
      }}
      className="font-mono text-[11px] uppercase tracking-[0.12em] px-2.5 py-1 rounded-[4px] border transition-colors"
      style={{ borderColor: LINE, color: copied ? CYAN : MUT }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

function Section({
  index,
  label,
  title,
  sub,
  accent = YELLOW,
  id,
  children,
}: {
  index: string;
  label: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  accent?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-t py-11 lg:py-14 scroll-mt-20" style={{ borderColor: HAIR }}>
      <div className="grid lg:grid-cols-[92px_1fr] gap-7 lg:gap-12">
        <div className="hidden lg:block">
          <div className="sticky top-24 font-grotesk font-semibold text-2xl" style={{ color: "rgba(255,255,255,0.18)" }}>
            {index}
          </div>
        </div>
        <div>
          <motion.div {...rise} className="mb-6">
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] mb-5" style={{ color: accent }}>
              [ {label} ]
            </div>
            <h2 className="font-grotesk font-semibold tracking-[-0.03em] leading-[1.05] text-[clamp(1.85rem,3.8vw,2.8rem)] max-w-[24ch]" style={{ color: INK }}>
              {title}
            </h2>
            {sub && (
              <p className="text-[15px] mt-4 max-w-[46rem] leading-relaxed" style={{ color: MUT }}>
                {sub}
              </p>
            )}
          </motion.div>
          {children}
        </div>
      </div>
    </section>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function ClaudePage() {
  const [amount, setAmount] = useState("50");
  const [tokenFilter, setTokenFilter] = useState<"USDC" | "USDT" | "RLUSD" | "ANY">("ANY");
  const [activeClient, setActiveClient] = useState<string>("claude");

  const current = CLIENTS.find((c) => c.key === activeClient) ?? CLIENTS[0];

  const ranked = useMemo(() => {
    const filtered = CHAINS.filter((c) => (tokenFilter === "ANY" ? true : c.tokens.includes(tokenFilter)));
    return [...filtered].sort((a, b) => a.approxGasCostUsd - b.approxGasCostUsd);
  }, [tokenFilter]);

  return (
    <>
      <Navbar />
      <main className="font-poppins" style={{ background: "linear-gradient(180deg, #070B14 0%, #0A0F1C 100%)", color: INK }}>
        <div className="max-w-[1240px] mx-auto px-6 sm:px-8">

          {/* ── HERO ─────────────────────────────────────────────────────── */}
          <section className="pt-24 lg:pt-28 pb-6 lg:pb-8">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
              <div className="flex items-center justify-between gap-4 mb-7">
                <div className="font-mono text-[11px] uppercase tracking-[0.34em]" style={{ color: MUT2 }}>
                  [ MCP / @quackai/q402-mcp ]
                </div>
                <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border font-mono text-[12px] shrink-0" style={{ borderColor: "rgba(91,200,250,0.3)", color: CYAN }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: CYAN, boxShadow: `0 0 6px ${CYAN}` }} />
                  v{MCP_VERSION} <span style={{ color: "rgba(91,200,250,0.6)" }}>live</span>
                </span>
              </div>
              <h1 className="font-grotesk font-semibold tracking-[-0.035em] leading-[0.98] text-[clamp(2.6rem,7vw,5.2rem)] max-w-[15ch]" style={{ color: INK }}>
                Your agent gets a{" "}
                <span style={{ color: YELLOW }}>checking account.</span>
              </h1>
              <p className="text-lg leading-relaxed mt-6 max-w-[40rem]" style={{ color: MUT }}>
                Gasless stablecoin payments across 11 EVM chains, from any MCP client. One install,
                then ask your AI to set it up. {TOOL_COUNT} tools, one package.
              </p>
              <div className="flex flex-wrap gap-3 mt-7">
                <Link
                  href="#install"
                  className="group inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold font-grotesk text-navy bg-yellow hover:bg-yellow-hover transition-colors"
                >
                  Install
                  <span className="inline-block transition-transform group-hover:translate-y-0.5" aria-hidden>&darr;</span>
                </Link>
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium font-grotesk border transition-colors hover:border-white/30"
                  style={{ borderColor: LINE, color: "rgba(230,234,242,0.9)" }}
                >
                  Open dashboard
                </Link>
              </div>
            </motion.div>

            {/* meta row: version + npm + github + works-with */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="mt-8 pt-6 border-t flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6"
              style={{ borderColor: HAIR }}
            >
              <div className="flex flex-wrap items-center gap-2.5 font-mono text-[13px]">
                <a href="https://www.npmjs.com/package/@quackai/q402-mcp" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-white/10 text-white/65 hover:text-white hover:border-white/25 transition-colors">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/logos/npm.webp" alt="npm" className="w-4 h-4 object-contain" /> npm <span className="text-[11px] opacity-70" aria-hidden>&#8599;</span>
                </a>
                <a href="https://github.com/bitgett/q402-mcp" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-white/10 text-white/65 hover:text-white hover:border-white/25 transition-colors">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/logos/github.svg" alt="GitHub" className="w-4 h-4 object-contain invert opacity-90" /> GitHub <span className="text-[11px] opacity-70" aria-hidden>&#8599;</span>
                </a>
                <Link href="/docs#claude-mcp" className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-white/10 text-white/65 hover:text-white hover:border-white/25 transition-colors">
                  <IconDoc /> Docs
                </Link>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-[10px] uppercase tracking-[0.24em] font-mono" style={{ color: MUT2 }}>Works with</span>
                <div className="flex items-center gap-2">
                  {WORKS_WITH.map((c) => (
                    <span key={c.name} className="w-8 h-8 rounded-md bg-white p-1.5 flex items-center justify-center" title={c.name}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.src} alt={c.name} className={`w-full h-full object-contain ${c.invert ? "invert" : ""}`} />
                    </span>
                  ))}
                  <span className="text-[12px] font-mono ml-1" style={{ color: MUT2 }}>+ any</span>
                </div>
              </div>
            </motion.div>
          </section>

          {/* ── 01 INSTALL ───────────────────────────────────────────────── */}
          <Section
            id="install"
            index="01"
            label="Install"
            title="Pick your client. One package underneath."
            sub="Same @quackai/q402-mcp server for every client. CLI for Claude and Codex, a JSON snippet for Cursor, Cline and Copilot, YAML for Hermes."
          >
            {/* tab row */}
            <div className="flex flex-wrap gap-2 mb-4">
              {CLIENTS.map((c) => {
                const isActive = activeClient === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setActiveClient(c.key)}
                    className="flex items-center gap-2 px-4 py-2 rounded-[4px] text-[13px] font-medium font-grotesk border transition-colors"
                    style={
                      isActive
                        ? { borderColor: "rgba(245,197,24,0.5)", background: "rgba(245,197,24,0.08)", color: YELLOW }
                        : { borderColor: LINE, color: MUT }
                    }
                  >
                    <span className="w-4 h-4 rounded-[3px] bg-white p-0.5 flex items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.logo} alt={c.name} className={`w-full h-full object-contain ${c.invert ? "invert" : ""}`} />
                    </span>
                    {c.name}
                  </button>
                );
              })}
            </div>

            {/* snippet box - flat, single thin top rule */}
            <div className="border rounded-[4px] p-5 md:p-6 font-mono text-[13px] min-h-[116px] flex flex-col" style={{ borderColor: LINE, background: "rgba(255,255,255,0.015)" }}>
              <div className="h-px -mx-5 md:-mx-6 -mt-5 md:-mt-6 mb-5" style={{ background: "rgba(91,200,250,0.4)" }} />
              {current.kind === "cli" ? (
                <div className="flex flex-col gap-3 flex-1">
                  <div className="flex items-center gap-3">
                    <span style={{ color: MUT2 }}>$</span>
                    <span className="flex-1 break-all" style={{ color: INK }}>{current.snippet}</span>
                    <CopyButton value={current.snippet} />
                  </div>
                  <div className="text-[11.5px] leading-relaxed" style={{ color: MUT2 }}>
                    Writes the q402 entry into{" "}
                    <code style={{ color: MUT }}>{current.key === "claude" ? "~/.claude.json" : "~/.codex/config.toml"}</code>
                    {" "}for you, no editing by hand.
                    {current.key === "codex" && <> If you already have other MCP servers there, back the file up first; the merge behavior is Codex CLI&apos;s to define, not ours.</>}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-[0.2em]" style={{ color: MUT2 }}>paste as {current.kind === "yaml" ? "YAML" : "JSON"}</span>
                    <CopyButton value={current.snippet} />
                  </div>
                  <pre className="text-[12.5px] whitespace-pre overflow-x-auto leading-relaxed" style={{ color: INK }}>{current.snippet}</pre>
                  {current.innerSnippet && (
                    <details className="mt-3 group">
                      <summary className="text-[11.5px] cursor-pointer select-none list-none flex items-center gap-1.5" style={{ color: CYAN }}>
                        <span className="inline-block transition-transform group-open:rotate-90" style={{ color: MUT2 }}>&#9656;</span>
                        Already have <code style={{ color: MUT }}>{current.configPath}</code> with other servers?
                      </summary>
                      <div className="mt-2 text-[11.5px] leading-relaxed pl-4" style={{ color: MUT }}>
                        Paste this <strong style={{ color: INK }}>inside</strong> the existing <code style={{ color: INK }}>{current.wrapperKey}</code> object (do not replace the file):
                        <div className="mt-2 flex items-center gap-2">
                          <pre className="flex-1 text-[11.5px] whitespace-pre overflow-x-auto leading-relaxed" style={{ color: INK }}>{current.innerSnippet}</pre>
                          <CopyButton value={current.innerSnippet} label="Copy entry" />
                        </div>
                      </div>
                    </details>
                  )}
                  {current.createFile && (
                    <details className="mt-2 group">
                      <summary className="text-[11.5px] cursor-pointer select-none list-none flex items-center gap-1.5" style={{ color: CYAN }}>
                        <span className="inline-block transition-transform group-open:rotate-90" style={{ color: MUT2 }}>&#9656;</span>
                        Need to create the file?
                      </summary>
                      <div className="mt-2 text-[11.5px] leading-relaxed pl-4 space-y-2" style={{ color: MUT }}>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.16em] mb-1" style={{ color: MUT2 }}>macOS / Linux</div>
                          <pre className="text-[11px] whitespace-pre overflow-x-auto rounded-[3px] px-2 py-1.5" style={{ color: INK, background: "rgba(7,11,20,0.6)" }}>{current.createFile.unix}</pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.16em] mb-1" style={{ color: MUT2 }}>Windows (PowerShell)</div>
                          <pre className="text-[11px] whitespace-pre overflow-x-auto rounded-[3px] px-2 py-1.5" style={{ color: INK, background: "rgba(7,11,20,0.6)" }}>{current.createFile.win}</pre>
                        </div>
                        <div style={{ color: MUT2 }}>Paste, save, then reload the client. {current.key === "hermes" ? "In Hermes, run /reload-mcp." : "In VS Code, reload the window."}</div>
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>

            <p className="text-[11.5px] mt-3 leading-relaxed" style={{ color: MUT2 }}>{current.hint}</p>

            {/* doctor-first CTA */}
            <div className="mt-4 border rounded-[4px] p-4 flex items-start gap-3" style={{ borderColor: "rgba(245,197,24,0.22)", background: "rgba(245,197,24,0.04)" }}>
              <span className="font-mono text-xs mt-0.5" style={{ color: YELLOW }}>&rarr;</span>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(230,234,242,0.85)" }}>
                Restart, then ask <span className="font-semibold" style={{ color: INK }}>&ldquo;Set up Q402&rdquo;</span>. It runs{" "}
                <code className="font-mono text-xs" style={{ color: YELLOW }}>q402_doctor</code>, creates{" "}
                <code className="font-mono text-xs" style={{ color: YELLOW }}>~/.q402/mcp.env</code>, and walks you through pasting keys in your editor, never in chat.
              </p>
            </div>
          </Section>

          {/* ── 02 WALLET MODE ───────────────────────────────────────────── */}
          <Section
            index="02"
            label="Wallet mode"
            title="Do I need a private key?"
            sub={<>Two modes use a local private key; one lets Q402 sign server-side. Most users want <span style={{ color: YELLOW }}>Mode C</span>, no PK, just an API key.</>}
          >
            <div className="border rounded-[4px] overflow-hidden" style={{ borderColor: LINE }}>
              {MODES.map((m) => (
                <div
                  key={m.tag}
                  className="grid md:grid-cols-[210px_1fr_minmax(0,300px)] gap-x-6 gap-y-3 items-start px-5 py-5 border-b last:border-0"
                  style={{ borderColor: HAIR, background: m.rec ? "rgba(245,197,24,0.045)" : "transparent" }}
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: m.rec ? YELLOW : MUT2 }}>{m.tag}</span>
                      {m.rec && (
                        <span className="text-[8.5px] uppercase tracking-[0.12em] font-bold px-1.5 py-0.5 rounded-full" style={{ background: YELLOW, color: "#0A0F1C" }}>Recommended</span>
                      )}
                    </div>
                    <div className="font-grotesk font-semibold text-[15px] leading-snug" style={{ color: INK }}>{m.title}</div>
                  </div>
                  <p className="text-[13px] leading-relaxed" style={{ color: MUT }}>{m.desc}</p>
                  <div>
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] mb-1.5" style={{ color: MUT2 }}>~/.q402/mcp.env</div>
                    <pre className="text-[10.5px] font-mono rounded-[3px] px-2.5 py-1.5 leading-relaxed whitespace-pre overflow-x-auto border" style={{ color: YELLOW, background: "rgba(7,11,20,0.55)", borderColor: HAIR }}>{m.env.join("\n")}</pre>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 text-[11.5px] leading-relaxed max-w-2xl" style={{ color: MUT2 }}>
              Change later by editing <code className="font-mono" style={{ color: MUT }}>~/.q402/mcp.env</code>. <code className="font-mono" style={{ color: MUT }}>q402_doctor</code> asks on first install.
            </div>
          </Section>

          {/* ── 03 LIVE QUOTE ────────────────────────────────────────────── */}
          <Section
            index="03"
            label="Live demo"
            title="The exact tool your agent calls."
            accent={CYAN}
            sub="Change the amount or token. The table re-ranks all 11 chains by gas, the same q402_quote the MCP server returns to the agent."
          >
            {/* controls */}
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.16em] font-mono" style={{ color: MUT2 }}>Amount</span>
                <div className="flex items-center gap-1.5 px-3 py-2 rounded-[4px] font-mono text-sm border" style={{ background: "rgba(255,255,255,0.02)", borderColor: LINE }}>
                  <span style={{ color: MUT2 }}>$</span>
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^\d{0,8}(\.\d{0,2})?$/.test(v)) setAmount(v);
                    }}
                    className="bg-transparent outline-none w-20 font-bold"
                    style={{ color: YELLOW }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-1.5 ml-auto">
                {(["ANY", "USDC", "USDT", "RLUSD"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTokenFilter(t)}
                    className="px-3 py-1.5 rounded-[4px] text-[11px] font-mono uppercase tracking-[0.1em] border transition-colors"
                    style={tokenFilter === t ? { borderColor: "rgba(245,197,24,0.5)", background: "rgba(245,197,24,0.08)", color: YELLOW } : { borderColor: LINE, color: MUT2 }}
                  >
                    {t === "ANY" ? "All tokens" : t}
                  </button>
                ))}
              </div>
            </div>

            {/* ranking */}
            <div className="border rounded-[4px] overflow-hidden" style={{ borderColor: LINE }}>
              <div className="px-5 py-3 flex items-center gap-3 border-b text-[10px] uppercase tracking-[0.18em] font-mono" style={{ borderColor: HAIR, color: MUT2 }}>
                <span className="w-6">#</span>
                <span className="flex-1">Chain</span>
                <span className="w-20 text-right max-sm:hidden">Gas token</span>
                <span className="w-28 text-right">Approx gas</span>
                <span className="w-16 text-right max-sm:hidden">Sender</span>
              </div>
              <ul>
                <AnimatePresence initial={false}>
                  {ranked.map((c, i) => (
                    <motion.li
                      layout
                      key={c.key}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.3, delay: i * 0.03 }}
                      className="px-5 py-3.5 flex items-center gap-3 text-sm border-b last:border-0"
                      style={{ borderColor: HAIR }}
                    >
                      <span className="w-6 font-mono text-xs font-bold" style={{ color: i === 0 ? YELLOW : MUT2 }}>{String(i + 1).padStart(2, "0")}</span>
                      <span className="flex-1 flex items-center gap-2 min-w-0">
                        <span className="font-medium" style={{ color: INK }}>{c.name}</span>
                        <span className="text-[10px] font-mono" style={{ color: MUT2 }}>chain {c.chainId}</span>
                        {c.note && <span className="hidden lg:inline text-[10px] truncate" style={{ color: MUT2 }}>{c.note}</span>}
                      </span>
                      <span className="w-20 text-right font-mono text-xs max-sm:hidden" style={{ color: MUT }}>{c.gas}</span>
                      <span className="w-28 text-right font-mono text-xs font-semibold" style={{ color: i === 0 ? YELLOW : MUT }}>${c.approxGasCostUsd.toFixed(c.approxGasCostUsd >= 1 ? 2 : 4)}</span>
                      <span className="w-16 text-right font-mono font-bold text-xs max-sm:hidden" style={{ color: CYAN }}>$0.00</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
              <div className="px-5 py-3 text-[11px] border-t font-mono" style={{ borderColor: HAIR, color: MUT2 }}>
                {`Sending $${amount || "0"} ${tokenFilter === "ANY" ? "USDC, USDT, or RLUSD" : tokenFilter}. Agent picks ${ranked[0]?.name ?? "-"} by default. Sender always pays $0; gas comes from the developer's gas tank.`}
              </div>
            </div>
          </Section>

          {/* ── 04 TOOLS ─────────────────────────────────────────────────── */}
          <Section
            index="04"
            label={`${TOOL_COUNT} tools`}
            title="Only what an agent should reach for."
            sub="No hidden admin endpoints. Nothing moves funds outside the confirm-and-sign flow. Grouped by what they do, with the auth each one needs."
          >
            <div className="grid md:grid-cols-2 gap-x-10 gap-y-7">
              {TOOL_GROUPS.map((g) => (
                <motion.div key={g.label} {...rise}>
                  <div className="flex items-baseline justify-between mb-3 pb-2 border-b" style={{ borderColor: HAIR }}>
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em]" style={{ color: YELLOW }}>{g.label}</span>
                    <span className="font-mono text-[11px]" style={{ color: MUT2 }}>{g.tools.length}</span>
                  </div>
                  <ul className="flex flex-col gap-3">
                    {g.tools.map((t) => (
                      <li key={t.name}>
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <code className="font-mono text-[12.5px] font-medium" style={{ color: INK }}>{t.name}</code>
                          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-[3px] border" style={{ borderColor: "rgba(91,200,250,0.26)", color: "rgba(91,200,250,0.85)" }}>{t.auth}</span>
                        </div>
                        <div className="text-[12.5px] leading-snug mt-1" style={{ color: MUT }}>{t.note}</div>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ))}
            </div>

            <p className="text-[12px] mt-8" style={{ color: MUT2 }}>
              Full reference, EIP-7702 details, Trust Receipt + safety guards:{" "}
              <Link href="/docs#claude-mcp" className="underline-offset-2 hover:underline" style={{ color: CYAN }}>/docs, MCP for AI Clients</Link>
              {" · "}
              <Link href="/agents" className="underline-offset-2 hover:underline" style={{ color: CYAN }}>what the Agent Wallet does</Link>
            </p>
          </Section>

        </div>
      </main>
      <Footer />
    </>
  );
}
