"use client";

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import { MCP_VERSION } from "@/app/lib/version";
import { BNB_FOCUS_MODE } from "@/app/lib/feature-flags";

/**
 * /claude — landing page for the @quackai/q402-mcp Claude integration.
 *
 * Live `q402_quote` simulation that re-ranks 7 chains as the visitor changes
 * the amount, animated install line with one-click copy + npm/GitHub deeplinks,
 * gradient tool cards.
 *
 * Fully static (no fetches) — the chain table mirrors the manifest in
 * mcp-server/src/chains.ts and contracts.manifest.json so the simulation is
 * authoritative without round-tripping the relayer.
 */

const INSTALL_CMD = "claude mcp add q402 -- npx -y @quackai/q402-mcp";

interface ChainRow {
  key: string;
  name: string;
  chainId: number;
  gas: string;
  approxGasCostUsd: number;
  tokens: ReadonlyArray<"USDC" | "USDT" | "RLUSD">;
  note?: string;
}

const ALL_CHAINS: ChainRow[] = [
  { key: "stable",    name: "Stable",            chainId: 988,   gas: "USDT0", approxGasCostUsd: 0.0005, tokens: ["USDC", "USDT"], note: "USDC and USDT both alias to USDT0" },
  { key: "bnb",       name: "BNB Chain",         chainId: 56,    gas: "BNB",   approxGasCostUsd: 0.001,  tokens: ["USDC", "USDT"] },
  { key: "xlayer",    name: "X Layer",           chainId: 196,   gas: "OKB",   approxGasCostUsd: 0.002,  tokens: ["USDC", "USDT"] },
  { key: "mantle",    name: "Mantle",            chainId: 5000,  gas: "MNT",   approxGasCostUsd: 0.002,  tokens: ["USDC", "USDT"] },
  { key: "avax",      name: "Avalanche C-Chain", chainId: 43114, gas: "AVAX",  approxGasCostUsd: 0.003,  tokens: ["USDC", "USDT"] },
  { key: "injective", name: "Injective EVM",     chainId: 1776,  gas: "INJ",   approxGasCostUsd: 0.004,  tokens: ["USDT"], note: "USDT only — Circle CCTP USDC announced for Q2 2026" },
  { key: "eth",       name: "Ethereum Mainnet",  chainId: 1,     gas: "ETH",   approxGasCostUsd: 1.2,    tokens: ["USDC", "USDT", "RLUSD"], note: "L1 — gas is volatile. RLUSD (Ripple USD, NY DFS regulated) Ethereum-only." },
];

// Sprint narrowing: the live q402_quote simulation collapses to BNB-only so
// what the visitor sees here matches what the MCP server actually returns.
const CHAINS: ChainRow[] = BNB_FOCUS_MODE
  ? ALL_CHAINS.filter(c => c.key === "bnb")
  : ALL_CHAINS;

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
  const [amount, setAmount] = useState("50");
  const [tokenFilter, setTokenFilter] = useState<"USDC" | "USDT" | "RLUSD" | "ANY">("ANY");

  const ranked = useMemo(() => {
    const filtered = CHAINS.filter(c =>
      tokenFilter === "ANY" ? true : c.tokens.includes(tokenFilter),
    );
    return [...filtered].sort((a, b) => a.approxGasCostUsd - b.approxGasCostUsd);
  }, [tokenFilter]);

  return (
    <div className="min-h-screen text-white" style={{ background: "#06060C" }}>
      {/* Top nav (slim) */}
      <header
        className="border-b sticky top-0 z-30 backdrop-blur-md"
        style={{ background: "rgba(6,6,12,0.82)", borderColor: "rgba(255,255,255,0.06)" }}
      >
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-yellow flex items-center justify-center shadow-[0_0_12px_rgba(245,197,24,0.35)]">
              <span className="w-2.5 h-2.5 rounded-sm bg-navy/90" />
            </span>
            <span className="text-yellow font-bold text-base tracking-tight">Q402</span>
            <span className="text-white/20 text-xs">/</span>
            <span className="text-orange-300/70 text-xs font-medium">claude</span>
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

      {/* HERO */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        {/* Background atmosphere */}
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

        <div className="relative max-w-6xl mx-auto px-6 py-20 md:py-28">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 mb-7 px-3 py-1 rounded-full"
            style={{
              background: "linear-gradient(120deg, rgba(245,158,11,0.10), rgba(139,92,246,0.06))",
              border: "1px solid rgba(245,158,11,0.30)",
              boxShadow: "0 0 30px rgba(245,158,11,0.10)",
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-orange-300 animate-pulse" />
            <span className="text-[10px] uppercase tracking-[0.22em] text-orange-300/95 font-bold">
              Claude × Quack AI
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
            className="text-base md:text-lg text-white/55 mt-6 max-w-2xl leading-relaxed"
          >
            Q402 ships as a Model Context Protocol server. One install and Claude can quote
            stablecoin transfers across {BNB_FOCUS_MODE
              ? <span className="text-white/85 font-semibold">BNB Chain — USDC + USDT (sprint focus)</span>
              : <span className="text-white/85 font-semibold">7 EVM chains</span>},
            settle them gaslessly, and confirm on-chain — all from a single prompt. The recipient
            gets the full amount. The sender pays $0 in gas. The agent never holds a key it
            shouldn&apos;t.
          </motion.p>

          {/* Install line */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.32 }}
            className="mt-10 max-w-2xl"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/30 font-bold mb-2">
              one line · install
            </div>
            <div
              className="relative flex items-center gap-3 px-4 py-3.5 rounded-xl font-mono text-sm overflow-hidden"
              style={{
                background: "linear-gradient(120deg, rgba(245,158,11,0.06), rgba(255,255,255,0.02))",
                border: "1px solid rgba(245,158,11,0.30)",
                boxShadow: "0 0 35px rgba(245,158,11,0.08)",
              }}
            >
              {/* Animated shine */}
              <motion.span
                className="absolute inset-y-0 w-20 -skew-x-12 pointer-events-none"
                initial={{ x: "-150%" }}
                animate={{ x: "550%" }}
                transition={{ duration: 4.2, repeat: Infinity, repeatDelay: 3, ease: "easeInOut" }}
                style={{ background: "linear-gradient(90deg, transparent, rgba(255,224,160,0.18), transparent)" }}
              />
              <span className="relative text-yellow/80">$</span>
              <span className="relative flex-1 truncate text-white/85">{INSTALL_CMD}</span>
              <span className="relative">
                <CopyButton value={INSTALL_CMD} />
              </span>
            </div>
            <p className="text-[11px] text-white/35 mt-3">
              Sandbox-default — no API key, no signup, no funds at risk to try{" "}
              <code className="text-yellow/80">q402_quote</code>.
            </p>
          </motion.div>
        </div>
      </section>

      {/* LIVE QUOTE SIMULATION */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-yellow/80 font-bold mb-2">
                live demo · q402_quote
              </div>
              <h2 className="text-2xl md:text-4xl font-bold">
                The exact tool Claude calls.
              </h2>
              <p className="text-white/50 text-sm mt-2 max-w-xl">
                Change the amount or token filter — the table re-ranks every chain by gas the same
                way the MCP server returns to Claude in real time.
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
                  border: "1px solid rgba(255,255,255,0.10)",
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
              {(BNB_FOCUS_MODE
                ? (["ANY", "USDC", "USDT"] as const)
                : (["ANY", "USDC", "USDT", "RLUSD"] as const)
              ).map(t => (
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
              background:
                "linear-gradient(180deg, rgba(245,197,24,0.04) 0%, rgba(255,255,255,0.02) 100%)",
              border: "1px solid rgba(255,255,255,0.06)",
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
            {/* Footer note */}
            <div
              className="px-5 py-3 text-[11px] text-white/30 border-t"
              style={{ borderColor: "rgba(255,255,255,0.04)" }}
            >
              {`Sending $${amount || "0"} ${
                tokenFilter === "ANY"
                  ? BNB_FOCUS_MODE ? "USDC or USDT" : "USDC, USDT, or RLUSD"
                  : tokenFilter
              }` +
                ` — Claude picks ${ranked[0]?.name ?? "—"} by default. Sender always pays $0;` +
                " gas comes from the developer's pre-funded gas tank."}
            </div>
          </div>
        </div>
      </section>

      {/* TOOLS */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/40 font-bold mb-2">
            four tools · one package
          </div>
          <h2 className="text-2xl md:text-4xl font-bold mb-2">
            Only what an agent should reach for.
          </h2>
          <p className="text-white/50 text-sm max-w-xl mb-10">
            No hidden admin endpoints, no key-rotation paths, nothing that could let a
            hallucination cost you money.
          </p>

          <div className="grid md:grid-cols-2 gap-5">
            {[
              {
                name: "q402_quote",
                auth: "no auth",
                color: "rgba(74,222,128,0.30)",
                bg: "rgba(74,222,128,0.05)",
                description: BNB_FOCUS_MODE
                  ? "BNB-focus sprint: shows BNB Chain + USDC/USDT. Read-only, no key. Perfect first call before anything signs."
                  : "Compare gas + supported tokens across all 7 chains. Read-only, no key. Perfect first call before anything signs.",
              },
              {
                name: "q402_balance",
                auth: "api key",
                color: "rgba(245,197,24,0.30)",
                bg: "rgba(245,197,24,0.05)",
                description:
                  "Verify the configured key, report its plan tier and remaining quota credits.",
              },
              {
                name: "q402_pay",
                auth: "live mode",
                color: "rgba(245,158,11,0.32)",
                bg: "rgba(245,158,11,0.06)",
                description: BNB_FOCUS_MODE
                  ? 'BNB-focus sprint: only chain "bnb" with USDC or USDT goes through; others return a sprint-aware error. Sandbox by default — three env vars must align before a single wei moves.'
                  : "Send a gasless USDC, USDT, or RLUSD payment. Sandbox by default — three env vars must align before a single wei moves.",
              },
              {
                name: "q402_receipt",
                auth: "no auth",
                color: "rgba(96,165,250,0.32)",
                bg: "rgba(96,165,250,0.06)",
                description:
                  "Fetch a Trust Receipt by rct_… id and locally verify its ECDSA signature against the relayer EOA. Read-only.",
              },
            ].map(t => (
              <motion.div
                key={t.name}
                whileHover={{ y: -3 }}
                className="rounded-2xl p-6 flex flex-col gap-3 transition-shadow hover:shadow-[0_10px_50px_rgba(245,158,11,0.10)]"
                style={{
                  background: t.bg,
                  border: `1px solid ${t.color}`,
                }}
              >
                <div className="flex items-center justify-between">
                  <code className="text-yellow font-mono font-bold">{t.name}</code>
                  <span className="text-[10px] uppercase tracking-widest text-white/35">
                    {t.auth}
                  </span>
                </div>
                <p className="text-sm text-white/65 leading-relaxed">{t.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* TRUST RECEIPT */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/40 font-bold mb-2">
            trust receipt
          </div>
          <h2 className="text-2xl md:text-4xl font-bold mb-3">
            Receipts are how AI agents communicate.
          </h2>
          <p className="text-white/50 text-sm max-w-2xl mb-10">
            Every successful Q402 settlement now produces a verifiable proof page.
            ECDSA-signed by the relayer, recovered locally in your browser, with
            on-chain tx + delivery trace on one URL. The receipt URL is the proof —
            no server round-trip, no trusted UI layer.
          </p>

          <div className="grid md:grid-cols-3 gap-5 mb-10">
            <div className="rounded-2xl p-6 border border-white/10 bg-white/[0.02]">
              <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">01 · settlement facts</div>
              <p className="text-sm text-white/70 leading-relaxed">
                Payer · recipient · amount · chain · method. The actual on-chain
                tx hash, block, and the gas Q402 sponsored on the customer&apos;s
                behalf — all surfaced inline.
              </p>
            </div>
            <div className="rounded-2xl p-6 border border-white/10 bg-white/[0.02]">
              <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">02 · cryptographic proof</div>
              <p className="text-sm text-white/70 leading-relaxed">
                EIP-191 ECDSA signature over a canonical hash of the settlement
                fields. Click <code className="text-yellow text-xs">Verify</code> —
                the recovery runs in your browser against the relayer EOA.
              </p>
            </div>
            <div className="rounded-2xl p-6 border border-white/10 bg-white/[0.02]">
              <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">03 · live delivery trace</div>
              <p className="text-sm text-white/70 leading-relaxed">
                Webhook delivery state polls in real time — pending → delivered
                or failed. Customers see exactly which downstream system saw the
                event without grepping logs.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border p-6 bg-yellow/5"
               style={{ borderColor: "rgba(245,197,24,0.30)" }}>
            <div className="text-[10px] uppercase tracking-widest text-yellow/80 font-bold mb-2">
              live demo
            </div>
            <a
              href="https://q402.quackai.ai/receipt/rct_afa5f50bc49a65ebba3b28ab"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs md:text-sm text-yellow hover:text-yellow/80 transition break-all"
            >
              q402.quackai.ai/receipt/rct_afa5f50bc49a65ebba3b28ab ↗
            </a>
            <p className="text-white/45 text-xs mt-3 leading-relaxed">
              First production Trust Receipt — 0.01 USDT settled on BNB Chain via
              EIP-7702. Click through to see the verify button in action.
            </p>
          </div>
        </div>
      </section>

      {/* SAFETY */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/40 font-bold mb-2">
            safe by design
          </div>
          <h2 className="text-2xl md:text-4xl font-bold mb-3">
            Four guards before any wei moves.
          </h2>
          <p className="text-white/50 text-sm max-w-xl mb-10">
            Letting an LLM touch a payment rail demands more than &ldquo;the model will be
            careful.&rdquo;
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              {
                n: "01",
                title: "Sandbox by default",
                body: (
                  <>
                    Without three env vars (
                    <code className="text-yellow text-xs">Q402_API_KEY</code> live tier,{" "}
                    <code className="text-yellow text-xs">Q402_PRIVATE_KEY</code>,{" "}
                    <code className="text-yellow text-xs">Q402_ENABLE_REAL_PAYMENTS=1</code>),
                    every <code className="text-yellow text-xs">q402_pay</code> returns a fake
                    hash. No funds, no quota.
                  </>
                ),
              },
              {
                n: "02",
                title: "Per-call hard cap",
                body: (
                  <>
                    <code className="text-yellow text-xs">Q402_MAX_AMOUNT_PER_CALL</code> defaults
                    to $5. Larger amounts are rejected before any signature happens.
                  </>
                ),
              },
              {
                n: "03",
                title: "Recipient allowlist",
                body: (
                  <>
                    <code className="text-yellow text-xs">Q402_ALLOWED_RECIPIENTS</code> takes a
                    comma-separated list. Unset = no restriction; set = nothing else gets through.
                  </>
                ),
              },
              {
                n: "04",
                title: "Confirm-in-chat contract",
                body: (
                  <>
                    The tool description requires the model to obtain explicit user OK in chat
                    before passing <code className="text-yellow text-xs">confirm: true</code>.
                    Combine with the cap and allowlist for defense in depth.
                  </>
                ),
              },
            ].map(g => (
              <div
                key={g.n}
                className="rounded-2xl p-5 flex gap-4"
                style={{
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <span className="text-yellow font-mono text-xs font-bold">{g.n}</span>
                <div>
                  <div className="font-semibold mb-1.5">{g.title}</div>
                  <p className="text-sm text-white/55 leading-relaxed">{g.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-6xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-3">
            Try the quote tool now.
          </h2>
          <p className="text-white/55 text-sm max-w-xl mx-auto mb-9">
            No signup. No API key. Sandbox-safe. Real payments later — your first $1 of gas is on us.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(INSTALL_CMD)}
              className="bg-yellow hover:bg-yellow-hover text-navy font-bold px-7 py-3.5 rounded-full transition-colors shadow-lg shadow-yellow/20"
            >
              Copy install command
            </button>
            <Link
              href="/dashboard"
              className="border border-white/15 hover:border-white/35 text-white/85 hover:text-white px-7 py-3.5 rounded-full transition-colors"
            >
              Get an API key →
            </Link>
          </div>
          <p className="text-[11px] text-white/30 mt-10">
            <a className="text-yellow/70 hover:text-yellow" href="https://www.npmjs.com/package/@quackai/q402-mcp">@quackai/q402-mcp</a>
            {" · "}
            <a className="text-yellow/70 hover:text-yellow" href="https://github.com/bitgett/q402-mcp">github.com/bitgett/q402-mcp</a>
            {" · "}
            <Link className="text-yellow/70 hover:text-yellow" href="/docs#claude-mcp">/docs → Claude MCP</Link>
          </p>
        </div>
      </section>

      <footer className="py-10">
        <div className="max-w-6xl mx-auto px-6 text-xs text-white/25 text-center">
          Apache-2.0 · Built by Quack AI Labs · MCP is an open standard from Anthropic.
        </div>
      </footer>
    </div>
  );
}
