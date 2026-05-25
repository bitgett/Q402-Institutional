"use client";

/**
 * /agents — Q402 Agent Wallet landing.
 *
 * Brand-distinct surface: deep slate base, emerald accent for the
 * Agent-Wallet feature line, console mockup right of the hero. Avoids
 * the navy/yellow gradient that the main landing uses while staying
 * inside the broader "developer infrastructure" voice.
 *
 * No pricing tier on this page; the trial promise (2,000 sponsored TX on
 * BNB Chain) appears in the proof row, and the page funnels into the
 * dashboard's Agent tab.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

const INSTALL_CMD = "npx @quackai/q402-mcp";

// Six lines that drip in one-by-one to make the hero feel live. Kept as
// data so the animation timing is obvious + tweakable.
const CONSOLE_LINES: { text: string; tone?: "muted" | "good" | "accent" | "warn"; pause?: number }[] = [
  { text: "$ q402 agent run shop.bot", tone: "muted" },
  { text: "agent: ordering analytics data ($3.24 USDC)", tone: "accent" },
  { text: "→ q402_pay(chain: 'bnb', to: 0x9c…2f4a, amount: 3.24)", tone: "muted" },
  { text: "✓ settled · gas sponsored · tx 0x4a1c…e83f", tone: "good" },
  { text: "agent: forwarding 0.5 USDT to data provider", tone: "accent" },
  { text: "✓ settled · 248 ms · receipt rct_aB12cd34", tone: "good" },
];

export default function AgentsPage() {
  return (
    <>
      <Navbar />

      <main
        className="pt-24 pb-24 px-6 relative overflow-hidden"
        style={{
          background:
            "radial-gradient(900px 500px at 70% 0%, rgba(34,197,94,0.12), transparent 60%), linear-gradient(180deg, #060B14 0%, #08111E 100%)",
          color: "#E2E8F0",
        }}
      >
        <GridBacker />

        <div className="relative max-w-6xl mx-auto">
          <Hero />
          <PromptExamplesSection />
          <ProofRow />
          <ConsoleMockupSection />
          <FlowSection />
          <PatternsSection />
          <Closing />
        </div>
      </main>

      <Footer />
    </>
  );
}

// ── Background grid ───────────────────────────────────────────────────────

function GridBacker() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none opacity-[0.06]"
      style={{
        backgroundImage:
          "linear-gradient(rgba(74,222,128,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(74,222,128,0.6) 1px, transparent 1px)",
        backgroundSize: "60px 60px",
        maskImage: "radial-gradient(ellipse at center, black 35%, transparent 75%)",
        WebkitMaskImage: "radial-gradient(ellipse at center, black 35%, transparent 75%)",
      }}
    />
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="max-w-3xl mx-auto text-center mb-16"
    >
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.22em] font-bold mb-6"
        style={{ background: "rgba(74,222,128,0.10)", color: "#86efac", border: "1px solid rgba(74,222,128,0.22)" }}
      >
        <span>✦</span>
        Agent Wallet
      </div>
      <h1 className="text-5xl md:text-6xl font-semibold tracking-tight mb-5 leading-[1.05]">
        Give your AI a wallet
        <span style={{ color: "#86efac" }}> it can actually use.</span>
      </h1>
      <p className="text-base md:text-lg leading-relaxed max-w-2xl mx-auto" style={{ color: "rgba(226,232,240,0.65)" }}>
        A dedicated wallet your AI signs through — without ever touching
        your MetaMask. Set per-tx and per-day spend caps, send across
        nine EVM chains, and keep the option to walk away with the keys
        whenever you want.
      </p>
      <div className="flex flex-wrap justify-center gap-3 mt-7">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-md text-sm font-semibold transition-colors"
          style={{ background: "#22C55E", color: "#0B1A12" }}
        >
          Open dashboard →
        </Link>
        <Link
          href="/claude"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-md text-sm font-medium transition-colors border"
          style={{
            borderColor: "rgba(226,232,240,0.18)",
            color: "rgba(226,232,240,0.85)",
            background: "rgba(226,232,240,0.02)",
          }}
        >
          Use from Claude · Codex · Cursor · Cline
        </Link>
      </div>
    </motion.div>
  );
}

// ── Prompt examples — "Try saying this" block ────────────────────────────
//
// Lifted out of the abstract feature list so the user immediately sees what
// kind of *thing they could ask their AI to do* once the wallet exists.
// Three deliberately concrete prompts: a recurring payout, a routing
// preference, and a spending policy.

function PromptExamplesSection() {
  const prompts: { quote: string; lane: "recurring" | "routing" | "policy" }[] = [
    {
      quote: "Every Friday, send 25 USDT to these 8 contributors.",
      lane: "recurring",
    },
    {
      quote: "If Scroll gas is cheaper than Ethereum, use Scroll.",
      lane: "routing",
    },
    {
      quote: "Never spend more than $200 per transaction or $500 per day.",
      lane: "policy",
    },
  ];
  const laneLabel: Record<"recurring" | "routing" | "policy", string> = {
    recurring: "recurring payout",
    routing: "chain routing",
    policy: "spending policy",
  };
  return (
    <div className="mb-20 max-w-3xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="text-center mb-7"
      >
        <div className="text-[10px] uppercase tracking-[0.22em] font-bold mb-2" style={{ color: "#86efac" }}>
          Try saying this
        </div>
        <div className="text-2xl md:text-3xl font-semibold tracking-tight mb-2">
          Plain English. Real settlement.
        </div>
        <div className="text-sm" style={{ color: "rgba(226,232,240,0.55)" }}>
          Works inside Claude, Codex CLI, Cursor, and Cline — same MCP tool,
          same Agent Wallet underneath.
        </div>
      </motion.div>

      <div className="space-y-3">
        {prompts.map((p, i) => (
          <motion.div
            key={p.quote}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.08 }}
            className="rounded-2xl border p-5 flex items-start gap-4"
            style={{
              background: "rgba(226,232,240,0.025)",
              borderColor: "rgba(74,222,128,0.18)",
            }}
          >
            <div
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[14px] font-semibold"
              style={{ background: "rgba(74,222,128,0.10)", color: "#86efac", border: "1px solid rgba(74,222,128,0.25)" }}
              aria-hidden
            >
              ❝
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[18px] md:text-[19px] font-medium leading-snug" style={{ color: "#E2E8F0" }}>
                {p.quote}
              </div>
              <div className="text-[10.5px] uppercase tracking-[0.18em] mt-1.5" style={{ color: "rgba(134,239,172,0.7)" }}>
                {laneLabel[p.lane]}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-5 text-center text-[11px]" style={{ color: "rgba(226,232,240,0.4)" }}>
        Your agent only ever spends what you let it — caps are enforced server-side
        on every send.
      </div>
    </div>
  );
}

// ── Console mockup — its own section between proof + flow ─────────────────

function ConsoleMockupSection() {
  return (
    <div className="mb-20 max-w-2xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="text-center mb-6"
      >
        <div className="text-[10px] uppercase tracking-[0.22em] font-bold mb-2" style={{ color: "#86efac" }}>
          What an agent run looks like
        </div>
        <div className="text-2xl font-semibold tracking-tight">
          Two payments, no popups.
        </div>
      </motion.div>
      <ConsoleMockup />
    </div>
  );
}

// ── Console mockup (animated) ─────────────────────────────────────────────

function ConsoleMockup() {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (visible >= CONSOLE_LINES.length) return;
    const delay = 600 + (CONSOLE_LINES[visible].pause ?? 0);
    const t = setTimeout(() => setVisible((v) => v + 1), delay);
    return () => clearTimeout(t);
  }, [visible]);

  const colorFor = (tone?: "muted" | "good" | "accent" | "warn") => {
    if (tone === "good") return "#86efac";
    if (tone === "accent") return "#E2E8F0";
    if (tone === "warn") return "#FCD34D";
    return "rgba(226,232,240,0.45)";
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay: 0.1 }}
      className="rounded-2xl border p-5 font-mono text-[13px] leading-relaxed relative"
      style={{
        background: "rgba(8,17,30,0.85)",
        borderColor: "rgba(74,222,128,0.22)",
        boxShadow: "0 0 0 1px rgba(74,222,128,0.05), 0 30px 80px rgba(0,0,0,0.35)",
      }}
    >
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 mb-4">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(239,68,68,0.55)" }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(234,179,8,0.55)" }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(74,222,128,0.55)" }} />
        <span className="ml-3 text-[10px] uppercase tracking-[0.22em]" style={{ color: "rgba(226,232,240,0.35)" }}>
          mcp · q402_pay · live
        </span>
      </div>

      <div className="space-y-1.5 min-h-[180px]">
        {CONSOLE_LINES.slice(0, visible).map((line, i) => (
          <div key={i} style={{ color: colorFor(line.tone) }}>
            {line.text}
          </div>
        ))}
        {visible < CONSOLE_LINES.length && (
          <div className="inline-block w-2 h-4 align-middle" style={{ background: "#86efac" }} />
        )}
      </div>

      <div
        className="mt-5 pt-3 border-t flex items-center justify-between text-[11px]"
        style={{ borderColor: "rgba(226,232,240,0.06)", color: "rgba(226,232,240,0.4)" }}
      >
        <span>Real flow · sandboxed in this mockup</span>
        <span style={{ color: "#86efac" }}>● connected</span>
      </div>
    </motion.div>
  );
}

// ── Proof row ─────────────────────────────────────────────────────────────

function ProofRow() {
  const rows: { label: string; value: string; foot: string }[] = [
    { label: "Chains live",       value: "9 EVM chains",     foot: "BNB · ETH · AVAX · X Layer · Stable · Mantle · Injective · Monad · Scroll" },
    { label: "Wallet popups",     value: "Zero",             foot: "Your agent signs through Q402 — your MetaMask never touched" },
    { label: "Spend controls",    value: "Per-tx · daily",   foot: "Caps enforced at the relay on every send + batch row" },
    { label: "Settle time",       value: "~1–3 s",           foot: "Median, single-recipient, sender pays $0 gas" },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.45 }}
      className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-20"
    >
      {rows.map((r) => (
        <div
          key={r.label}
          className="rounded-xl border p-4"
          style={{ background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.08)" }}
        >
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold mb-2" style={{ color: "rgba(226,232,240,0.4)" }}>
            {r.label}
          </div>
          <div className="text-xl font-semibold mb-1" style={{ color: "#86efac" }}>
            {r.value}
          </div>
          <div className="text-[11px] leading-snug" style={{ color: "rgba(226,232,240,0.5)" }}>
            {r.foot}
          </div>
        </div>
      ))}
    </motion.div>
  );
}

// ── Flow ──────────────────────────────────────────────────────────────────

function FlowSection() {
  const steps = [
    {
      n: "01",
      title: "Install Q402 MCP",
      body: "One package across every MCP-capable client. Same surface in Claude, Codex CLI, Cursor, and Cline.",
      code: INSTALL_CMD,
    },
    {
      n: "02",
      title: "Mint the wallet",
      body: "One signature from your dashboard. Q402 generates a dedicated wallet for your agent, ties it to your account, and lets you export the key anytime.",
      code: 'POST /api/wallet/agentic\n  → { address: "0xD2…ff64", createdAt: 1717... }',
    },
    {
      n: "03",
      title: "Let the agent run",
      body: "Your agent calls one tool and Q402 handles the rest. Server signs, relayer pays gas, every transfer comes back with a verifiable Trust Receipt.",
      code: 'agent.pay({\n  chain: "bnb",\n  token: "USDC",\n  to:   "0x9c…2f4a",\n  amount: "3.24"\n})',
    },
  ];
  return (
    <div className="mb-20">
      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="text-3xl font-semibold tracking-tight mb-2"
      >
        Three steps to autonomous spend.
      </motion.h2>
      <p className="text-sm mb-9" style={{ color: "rgba(226,232,240,0.55)" }}>
        Bounded by limits you set. Trust-receipted on every transfer.
      </p>

      <div className="space-y-4">
        {steps.map((s, i) => (
          <motion.div
            key={s.n}
            initial={{ opacity: 0, x: -8 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: i * 0.08 }}
            className="grid md:grid-cols-[120px_1fr_1.05fr] gap-5 items-start rounded-2xl border p-5"
            style={{ background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.07)" }}
          >
            <div className="text-2xl font-mono font-semibold" style={{ color: "#86efac" }}>{s.n}</div>
            <div>
              <div className="text-lg font-semibold mb-2">{s.title}</div>
              <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.6)" }}>
                {s.body}
              </div>
            </div>
            <pre
              className="rounded-md p-4 text-[12px] font-mono leading-relaxed whitespace-pre overflow-x-auto"
              style={{
                background: "rgba(8,17,30,0.7)",
                color: "#cbd5e1",
                border: "1px solid rgba(74,222,128,0.16)",
              }}
            >
              {s.code}
            </pre>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ── Patterns / use-case strip ────────────────────────────────────────────

function PatternsSection() {
  const patterns = [
    {
      eyebrow: "Streaming spend",
      headline: "Pay per row, not per call.",
      body: "Crawlers / RAG pipelines fan out micro-payments to data providers in real time. Limits cap the worst case.",
    },
    {
      eyebrow: "Batch payouts",
      headline: "20 recipients, one call.",
      body: "Reward distribution, ambassador stipends, vendor invoices — submit up to 20 transfers in a single batch and get per-row results back.",
    },
    {
      eyebrow: "Recurring API spend",
      headline: "Keep the lights on, automatically.",
      body: "Top up worker bots and partner services on cron. Reverse-direction sweep keeps the agent wallet itself funded.",
    },
  ];
  return (
    <div className="mb-20">
      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="text-3xl font-semibold tracking-tight mb-9"
      >
        Patterns this unlocks.
      </motion.h2>

      <div className="grid md:grid-cols-3 gap-4">
        {patterns.map((p, i) => (
          <motion.div
            key={p.eyebrow}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.08 }}
            className="rounded-2xl border p-6"
            style={{ background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.07)" }}
          >
            <div className="text-[10px] uppercase tracking-[0.22em] font-bold mb-3" style={{ color: "#86efac" }}>
              {p.eyebrow}
            </div>
            <div className="text-lg font-semibold mb-3">{p.headline}</div>
            <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.6)" }}>
              {p.body}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ── Closing ───────────────────────────────────────────────────────────────

function Closing() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.45 }}
      className="rounded-2xl border p-8 flex flex-col md:flex-row md:items-center md:justify-between gap-5"
      style={{
        background:
          "linear-gradient(135deg, rgba(34,197,94,0.10) 0%, rgba(8,17,30,0.6) 70%)",
        borderColor: "rgba(74,222,128,0.22)",
      }}
    >
      <div>
        <div className="text-xl md:text-2xl font-semibold mb-1">Spin one up.</div>
        <div className="text-sm" style={{ color: "rgba(226,232,240,0.6)" }}>
          Free to create. Send on BNB Chain today; a multichain key opens the rest of the 9 EVM chains when you&apos;re ready.
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold"
          style={{ background: "#22C55E", color: "#0B1A12" }}
        >
          Create Agent Wallet →
        </Link>
        <Link
          href="/docs#claude-mcp"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium border"
          style={{
            borderColor: "rgba(226,232,240,0.18)",
            color: "rgba(226,232,240,0.85)",
            background: "rgba(226,232,240,0.02)",
          }}
        >
          Read the docs
        </Link>
      </div>
    </motion.div>
  );
}
