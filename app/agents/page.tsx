"use client";

/**
 * /agents - Q402 Agent Wallet landing.
 *
 * On-system surface: navy base (#070C16 / #0B1220) + brand yellow (#F5C518)
 * with cyan (#5BC8FA) as the secondary accent. Headings use font-display
 * (Bricolage); numbers, addresses, step indices and tags use font-mono.
 *
 * No pricing tier on this page; the trial promise (2,000 sponsored TX on
 * BNB Chain) appears in the proof row, and the page funnels into the
 * dashboard's Wallets view.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

const INSTALL_CMD = "npx @quackai/q402-mcp";

// Console lines that drip in one-by-one to make the hero feel live, then
// loop. `who` drives the cyan ("you") vs yellow/white (agent) coloring.
type ConsoleTone = "muted" | "good" | "accent" | "warn";
type ConsoleMark = "none" | "check" | "dot";
const CONSOLE_LINES: { text: string; tone?: ConsoleTone; mark?: ConsoleMark; you?: boolean; pause?: number }[] = [
  { text: "q402 agent run shop.bot", tone: "muted", mark: "dot", you: true },
  { text: "agent: ordering analytics data ($3.24 USDC)", tone: "accent" },
  { text: "q402_pay(chain: 'bnb', to: 0x9c..2f4a, amount: 3.24)", tone: "muted", you: true },
  { text: "settled . gas sponsored . tx 0x4a1c..e83f", tone: "good", mark: "check" },
  { text: "agent: forwarding 0.5 USDT to data provider", tone: "accent" },
  { text: "settled . 248 ms . receipt rct_aB12cd34", tone: "good", mark: "check" },
];

// Shared reveal preset: fades up every time the element scrolls into view
// (no `once`), so the page keeps re-animating as the user moves around.
const reveal = {
  initial: { opacity: 0, y: 14 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { amount: 0.3 } as const,
  transition: { duration: 0.5 },
};

export default function AgentsPage() {
  return (
    <>
      <Navbar />

      <main
        className="pt-24 pb-24 px-6 relative overflow-hidden font-poppins"
        style={{
          background:
            "radial-gradient(900px 500px at 70% 0%, rgba(245,197,24,0.12), transparent 60%), radial-gradient(700px 460px at 12% 14%, rgba(91,200,250,0.10), transparent 60%), linear-gradient(180deg, #070C16 0%, #0B1220 100%)",
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

// Inline SVG line-icons (no emoji glyphs). ----------------------------------

function SparkIcon({ className, color = "currentColor" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M12 3v6M12 15v6M3 12h6M15 12h6M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function QuoteIcon({ className, color = "currentColor" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path
        d="M9.5 7.5C7 8.3 5.5 10.4 5.5 13c0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6 0-.8-.6-1.5-1.4-1.6.3-1 1.1-1.8 2.2-2.2zM17.5 7.5c-2.5.8-4 2.9-4 5.5 0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6 0-.8-.6-1.5-1.4-1.6.3-1 1.1-1.8 2.2-2.2z"
        fill={color}
      />
    </svg>
  );
}

function CheckMark({ color = "#5BC8FA" }: { color?: string }) {
  return (
    <svg viewBox="0 0 16 16" className="inline-block w-3.5 h-3.5 mr-1.5 -translate-y-px" fill="none" aria-hidden>
      <path d="M3 8.5l3 3 7-7.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusDot({ color = "#5BC8FA" }: { color?: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
      style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      aria-hidden
    />
  );
}

// Background grid ------------------------------------------------------------

function GridBacker() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none opacity-[0.06]"
      style={{
        backgroundImage:
          "linear-gradient(rgba(245,197,24,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(245,197,24,0.6) 1px, transparent 1px)",
        backgroundSize: "60px 60px",
        maskImage: "radial-gradient(ellipse at center, black 35%, transparent 75%)",
        WebkitMaskImage: "radial-gradient(ellipse at center, black 35%, transparent 75%)",
      }}
    />
  );
}

// Hero -----------------------------------------------------------------------

function Hero() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="max-w-3xl mx-auto text-center mb-16"
    >
      <div
        className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-6"
        style={{ background: "rgba(245,197,24,0.10)", color: "#F5C518", border: "1px solid rgba(245,197,24,0.22)" }}
      >
        <SparkIcon className="w-3 h-3" color="#F5C518" />
        Agent Wallet
      </div>
      <h1 className="font-display text-5xl md:text-6xl font-semibold tracking-tight mb-5 leading-[1.05]">
        <span
          style={{
            background: "linear-gradient(100deg, #ffffff 0%, #F5C518 48%, #5BC8FA 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent",
          }}
        >
          Give your AI a wallet it can actually use.
        </span>
      </h1>
      <p className="text-base md:text-lg leading-relaxed max-w-2xl mx-auto" style={{ color: "rgba(226,232,240,0.75)" }}>
        A wallet your AI signs through. Your MetaMask is untouched. Per-tx and per-day caps, 10 EVM chains, keys exportable anytime.
      </p>
      <div className="flex flex-wrap justify-center gap-3 mt-7">
        <PrimaryCta href="/dashboard">Open dashboard</PrimaryCta>
        <SecondaryCta href="/claude">Use from Claude . Codex . Cursor . Cline</SecondaryCta>
      </div>
    </motion.div>
  );
}

// CTAs - yellow pill (navy text, hover lift + arrow nudge) and outline pill.

function PrimaryCta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold font-display text-navy bg-yellow hover:bg-yellow-hover transition-all hover:-translate-y-0.5 shadow-lg shadow-yellow/20 hover:shadow-yellow/35"
    >
      {children}
      <span className="inline-block transition-transform group-hover:translate-x-1" aria-hidden>
        &rarr;
      </span>
    </Link>
  );
}

function SecondaryCta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium font-display border transition-all hover:-translate-y-0.5"
      style={{
        borderColor: "rgba(91,200,250,0.28)",
        color: "rgba(226,232,240,0.9)",
        background: "rgba(91,200,250,0.05)",
      }}
    >
      {children}
    </Link>
  );
}

// Prompt examples - "Try saying this" block ----------------------------------
//
// Lifted out of the abstract feature list so the user immediately sees what
// kind of thing they could ask their AI to do once the wallet exists.
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
  // The routing lane gets the cyan accent so the trio is not all-yellow.
  const laneColor: Record<"recurring" | "routing" | "policy", string> = {
    recurring: "rgba(226,232,240,0.55)",
    routing: "#5BC8FA",
    policy: "rgba(226,232,240,0.55)",
  };
  return (
    <div className="mb-20 max-w-3xl mx-auto">
      <motion.div {...reveal} className="text-center mb-7">
        <div className="text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-2" style={{ color: "#F5C518" }}>
          Try saying this
        </div>
        <div className="text-2xl md:text-3xl font-semibold font-display tracking-tight mb-2">
          Plain English. Real settlement.
        </div>
        <div className="text-sm" style={{ color: "rgba(226,232,240,0.65)" }}>
          Claude . Codex . Cursor . Cline. One MCP tool, one Agent Wallet.
        </div>
      </motion.div>

      <div className="space-y-3">
        {prompts.map((p, i) => {
          const accent = laneColor[p.lane];
          const isCyan = p.lane === "routing";
          return (
            <motion.div
              key={p.quote}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ amount: 0.4 }}
              transition={{ duration: 0.45, delay: i * 0.08 }}
              whileHover={{ y: -3 }}
              className="rounded-2xl border p-5 flex items-start gap-4"
              style={{
                background: "rgba(226,232,240,0.025)",
                borderColor: isCyan ? "rgba(91,200,250,0.28)" : "rgba(245,197,24,0.18)",
              }}
            >
              <div
                className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
                style={{
                  background: isCyan ? "rgba(91,200,250,0.12)" : "rgba(245,197,24,0.10)",
                  border: `1px solid ${isCyan ? "rgba(91,200,250,0.30)" : "rgba(245,197,24,0.25)"}`,
                }}
                aria-hidden
              >
                <QuoteIcon className="w-4 h-4" color={isCyan ? "#5BC8FA" : "#F5C518"} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[18px] md:text-[19px] font-medium leading-snug" style={{ color: "#E2E8F0" }}>
                  {p.quote}
                </div>
                <div className="text-[10.5px] uppercase tracking-[0.18em] font-mono mt-1.5" style={{ color: accent }}>
                  {laneLabel[p.lane]}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="mt-5 text-center text-[11px]" style={{ color: "rgba(226,232,240,0.55)" }}>
        Your agent only ever spends what you let it. Caps are enforced server-side
        on every send.
      </div>
    </div>
  );
}

// Console mockup - its own section between proof + flow ----------------------

function ConsoleMockupSection() {
  return (
    <div className="mb-20 max-w-2xl mx-auto">
      <motion.div {...reveal} className="text-center mb-6">
        <div className="text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-2" style={{ color: "#F5C518" }}>
          What an agent run looks like
        </div>
        <div className="text-2xl font-semibold font-display tracking-tight">
          Two payments, no popups.
        </div>
      </motion.div>
      <ConsoleMockup />
    </div>
  );
}

// Console mockup (animated, looping) -----------------------------------------

function ConsoleMockup() {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    // Drip lines in, hold the full run, then reset and replay forever.
    if (visible >= CONSOLE_LINES.length) {
      const hold = setTimeout(() => setVisible(0), 2600);
      return () => clearTimeout(hold);
    }
    const delay = 600 + (CONSOLE_LINES[visible].pause ?? 0);
    const t = setTimeout(() => setVisible((v) => v + 1), delay);
    return () => clearTimeout(t);
  }, [visible]);

  // "you" lines render cyan; agent output renders yellow/white/muted.
  const colorFor = (tone?: ConsoleTone, you?: boolean) => {
    if (you) return "#5BC8FA";
    if (tone === "good") return "#F5C518";
    if (tone === "accent") return "#E2E8F0";
    if (tone === "warn") return "#FCD34D";
    return "rgba(226,232,240,0.45)";
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ amount: 0.3 }}
      transition={{ duration: 0.55 }}
      className="rounded-2xl border p-5 font-mono text-[13px] leading-relaxed relative"
      style={{
        background: "rgba(7,12,22,0.9)",
        borderColor: "rgba(245,197,24,0.22)",
        boxShadow: "0 0 0 1px rgba(245,197,24,0.05), 0 30px 80px rgba(0,0,0,0.35)",
      }}
    >
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 mb-4">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(239,68,68,0.55)" }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(234,179,8,0.55)" }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(91,200,250,0.55)" }} />
        <span className="ml-3 text-[10px] uppercase tracking-[0.22em]" style={{ color: "rgba(226,232,240,0.35)" }}>
          mcp . q402_pay . live
        </span>
      </div>

      <div className="space-y-1.5 min-h-[180px]">
        {CONSOLE_LINES.slice(0, visible).map((line, i) => (
          <div key={i} style={{ color: colorFor(line.tone, line.you) }}>
            {line.you && <span style={{ color: "#5BC8FA" }}>$ </span>}
            {line.mark === "check" && <CheckMark color="#F5C518" />}
            {line.mark === "dot" && <StatusDot color="#5BC8FA" />}
            {line.text}
          </div>
        ))}
        {visible < CONSOLE_LINES.length && (
          <div className="inline-block w-2 h-4 align-middle" style={{ background: "#F5C518" }} />
        )}
      </div>

      <div
        className="mt-5 pt-3 border-t flex items-center justify-between text-[11px]"
        style={{ borderColor: "rgba(226,232,240,0.06)", color: "rgba(226,232,240,0.55)" }}
      >
        <span>Real flow . sandboxed in this mockup</span>
        <span className="inline-flex items-center" style={{ color: "#5BC8FA" }}>
          <StatusDot color="#5BC8FA" />
          connected
        </span>
      </div>
    </motion.div>
  );
}

// Proof row ------------------------------------------------------------------

function ProofRow() {
  const rows: { label: string; value: string; foot: string }[] = [
    { label: "Chains live",   value: "10 EVM chains",  foot: "BNB . ETH . AVAX . X Layer . Stable . Mantle . Injective . Monad . Scroll . Arbitrum" },
    { label: "Wallet popups", value: "Zero",           foot: "Your agent signs through Q402. Your MetaMask never touched." },
    { label: "Spend controls", value: "Per-tx . daily", foot: "Caps enforced at the relay on every send + batch row" },
    { label: "Settle time",   value: "~1-3 s",         foot: "Median, single-recipient, sender pays $0 gas" },
  ];
  return (
    <motion.div {...reveal} className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-20">
      {rows.map((r, i) => (
        <motion.div
          key={r.label}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ amount: 0.4 }}
          transition={{ duration: 0.4, delay: i * 0.06 }}
          whileHover={{ y: -3 }}
          className="rounded-2xl border p-4"
          style={{ background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.08)" }}
        >
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold font-display mb-2" style={{ color: "rgba(226,232,240,0.55)" }}>
            {r.label}
          </div>
          <div className="text-xl font-semibold font-mono mb-1" style={{ color: "#F5C518" }}>
            {r.value}
          </div>
          <div className="text-[11px] leading-snug" style={{ color: "rgba(226,232,240,0.5)" }}>
            {r.foot}
          </div>
        </motion.div>
      ))}
      {/* Lightweight capability mention: Agent Wallets can graduate onto
          the ERC-8004 on-chain identity layer. Kept as a single inline
          line rather than a prominent badge. This is a feature surface,
          not a marketing claim. */}
      <div className="col-span-2 md:col-span-4 text-[11.5px] text-center mt-1" style={{ color: "rgba(226,232,240,0.45)" }}>
        Optional: graduate your Agent Wallet onto ERC-8004 for an on-chain identity badge.
      </div>
    </motion.div>
  );
}

// Flow -----------------------------------------------------------------------

function FlowSection() {
  const steps = [
    {
      n: "01",
      title: "Install Q402 MCP",
      body: "One package, every MCP client. Same surface in Claude, Codex, Cursor, Cline.",
      code: INSTALL_CMD,
    },
    {
      n: "02",
      title: "Mint the wallet",
      body: "One signature on the dashboard. Key exportable anytime.",
      code: 'POST /api/wallet/agentic\n  -> { address: "0xD2..ff64", createdAt: 1717... }',
    },
    {
      n: "03",
      title: "Let the agent run",
      body: "One tool call. Server signs, relayer pays gas, every transfer returns a Trust Receipt.",
      code: 'agent.pay({\n  chain: "bnb",\n  token: "USDC",\n  to:   "0x9c..2f4a",\n  amount: "3.24"\n})',
    },
  ];
  return (
    <div className="mb-20">
      <motion.h2 {...reveal} className="text-3xl font-semibold font-display tracking-tight mb-2">
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
            viewport={{ amount: 0.4 }}
            transition={{ duration: 0.45, delay: i * 0.08 }}
            className="grid md:grid-cols-[120px_1fr_1.05fr] gap-5 items-start rounded-2xl border p-5 relative"
            style={{ background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.07)" }}
          >
            {/* Step index + cyan connector down to the next step. */}
            <div className="relative">
              <div className="text-2xl font-mono font-semibold" style={{ color: "#F5C518" }}>{s.n}</div>
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className="hidden md:block absolute left-3 top-9 w-px h-[calc(100%+1rem)]"
                  style={{ background: "linear-gradient(180deg, rgba(91,200,250,0.55), rgba(91,200,250,0))" }}
                />
              )}
            </div>
            <div>
              <div className="text-lg font-semibold font-display mb-2">{s.title}</div>
              <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.6)" }}>
                {s.body}
              </div>
            </div>
            <pre
              className="rounded-2xl p-4 text-[12px] font-mono leading-relaxed whitespace-pre overflow-x-auto"
              style={{
                background: "rgba(7,12,22,0.75)",
                color: "#cbd5e1",
                border: "1px solid rgba(245,197,24,0.16)",
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

// Patterns / use-case strip --------------------------------------------------

function PatternsSection() {
  const patterns = [
    {
      eyebrow: "Streaming spend",
      headline: "Pay per row, not per call.",
      body: "Crawlers and RAG pipelines fan out micro-payments to data providers in real time. Limits cap the worst case.",
    },
    {
      eyebrow: "Batch payouts",
      headline: "20 recipients, one call.",
      body: "Reward distribution, ambassador stipends, vendor invoices. Submit up to 20 transfers in a single batch and get per-row results back.",
    },
    {
      eyebrow: "Recurring API spend",
      headline: "Keep the lights on, automatically.",
      body: "Top up worker bots and partner services on cron. Reverse-direction sweep keeps the agent wallet itself funded.",
    },
  ];
  return (
    <div className="mb-20">
      <motion.h2 {...reveal} className="text-3xl font-semibold font-display tracking-tight mb-9">
        Patterns this unlocks.
      </motion.h2>

      <div className="grid md:grid-cols-3 gap-4">
        {patterns.map((p, i) => {
          // Middle card carries the cyan accent so the row is not all-yellow.
          const isCyan = i === 1;
          return (
            <motion.div
              key={p.eyebrow}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ amount: 0.4 }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              whileHover={{ y: -5 }}
              className="rounded-2xl border p-6 transition-shadow hover:shadow-xl hover:shadow-black/30"
              style={{
                background: "rgba(226,232,240,0.02)",
                borderColor: isCyan ? "rgba(91,200,250,0.22)" : "rgba(226,232,240,0.07)",
              }}
            >
              <div
                className="text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-3"
                style={{ color: isCyan ? "#5BC8FA" : "#F5C518" }}
              >
                {p.eyebrow}
              </div>
              <div className="text-lg font-semibold font-display mb-3">{p.headline}</div>
              <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.6)" }}>
                {p.body}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// Closing --------------------------------------------------------------------

function Closing() {
  return (
    <motion.div
      {...reveal}
      className="rounded-2xl border p-8 flex flex-col md:flex-row md:items-center md:justify-between gap-5"
      style={{
        background:
          "linear-gradient(135deg, rgba(245,197,24,0.10) 0%, rgba(91,200,250,0.06) 55%, rgba(7,12,22,0.6) 100%)",
        borderColor: "rgba(245,197,24,0.22)",
      }}
    >
      <div>
        <div className="text-xl md:text-2xl font-semibold font-display mb-1">Spin one up.</div>
        <div className="text-sm" style={{ color: "rgba(226,232,240,0.6)" }}>
          Free to create. Send on BNB Chain today; a multichain key opens the rest of the 10 EVM chains when you&apos;re ready.
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <PrimaryCta href="/dashboard">Create Agent Wallet</PrimaryCta>
        <SecondaryCta href="/docs#claude-mcp">Read the docs</SecondaryCta>
      </div>
    </motion.div>
  );
}
