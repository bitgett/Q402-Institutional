"use client";

/**
 * /agents - Q402 Agent Wallet landing.
 *
 * On-system surface: navy base (#070C16 / #0B1220) + brand yellow (#F5C518)
 * with cyan (#5BC8FA) as the secondary accent. Headings use font-display
 * (Bricolage); numbers, addresses, step indices and tags use font-mono.
 * Wide editorial layout (1280px) with an asymmetric 2-col hero, a full-width
 * prompt bento, a safety trio, and a capability bento. The brand mark comes
 * from the shared Navbar/Footer; this page adds no logo of its own.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

const INSTALL_CMD = "npx @quackai/q402-mcp";

// Console lines that drip in one-by-one to make the hero feel live, then
// loop. `you` drives the cyan ("you") vs yellow/white (agent) coloring.
type ConsoleTone = "muted" | "good" | "accent";
type ConsoleMark = "none" | "check" | "dot";
const CONSOLE_LINES: { text: string; tone?: ConsoleTone; mark?: ConsoleMark; you?: boolean; pause?: number }[] = [
  { text: "q402 agent run shop.bot", tone: "muted", mark: "dot", you: true },
  { text: "agent: ordering analytics data ($3.24 USDC)", tone: "accent" },
  { text: "q402_pay(chain: 'bnb', to: 0x9c..2f4a, amount: 3.24)", tone: "muted", you: true },
  { text: "settled . gas sponsored . tx 0x4a1c..e83f", tone: "good", mark: "check" },
  { text: "agent: forwarding 0.5 USDT to data provider", tone: "accent" },
  { text: "settled . 248 ms . receipt rct_aB12cd34", tone: "good", mark: "check" },
];

// MCP clients shown as a "works with" strip (logos live in /public/logos).
const CLIENTS: { name: string; src: string; invert?: boolean }[] = [
  { name: "Claude", src: "/logos/claude.svg" },
  { name: "Codex", src: "/logos/codex.svg" },
  { name: "Cursor", src: "/logos/cursor.svg", invert: true },
  { name: "Cline", src: "/logos/cline.svg", invert: true },
];

// Shared reveal preset: fades up every time the element scrolls into view.
const reveal = {
  initial: { opacity: 0, y: 14 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { amount: 0.25 } as const,
  transition: { duration: 0.5 },
};

// Title sheen used on section headings, matching the landing's gradient-clip.
const titleSheen: React.CSSProperties = {
  background: "linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.72) 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  WebkitTextFillColor: "transparent",
  color: "transparent",
};

export default function AgentsPage() {
  return (
    <>
      <Navbar />

      <main
        className="pt-24 pb-24 relative overflow-hidden font-poppins"
        style={{
          background:
            "radial-gradient(900px 500px at 70% 0%, rgba(245,197,24,0.12), transparent 60%), radial-gradient(700px 460px at 12% 14%, rgba(91,200,250,0.10), transparent 60%), linear-gradient(180deg, #070C16 0%, #0B1220 100%)",
          color: "#E2E8F0",
        }}
      >
        <GridBacker />

        <div className="relative max-w-[1280px] mx-auto px-6 sm:px-8">
          <Hero />
          <ProofRow />
          <PromptExamplesSection />
          <SafetySection />
          <CapabilitiesSection />
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

const ICONS: Record<string, React.ReactNode> = {
  shield: (<><path d="M12 3l7 2.5v5.6c0 4.4-3 7.4-7 8.4-4-1-7-4-7-8.4V5.5z" /><path d="M9 11.6l2 2 4-4.2" /></>),
  lock: (<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>),
  seal: (<><circle cx="12" cy="12" r="8.4" /><path d="M8.4 12.1l2.3 2.3 4.9-5" /></>),
  wallets: (<><path d="M6 4.5h11a2 2 0 0 1 2 2V14" opacity=".5" /><rect x="3" y="7.5" width="14" height="11" rx="2" /><circle cx="13.4" cy="13" r="1.2" fill="currentColor" stroke="none" /></>),
  yield: (<><path d="M4 16l5-5 3 3 7-8" /><path d="M16 6h4v4" opacity=".7" /></>),
  bridge: (<><circle cx="5" cy="14" r="2" /><circle cx="19" cy="14" r="2" /><path d="M7 13.4C9 8 15 8 17 13.4" /></>),
  batch: (<><circle cx="5" cy="12" r="2" /><circle cx="19" cy="6" r="1.6" /><circle cx="19" cy="12" r="1.6" /><circle cx="19" cy="18" r="1.6" /><path d="M7 11l10-4.4M7 12h10M7 13l10 4.4" opacity=".55" /></>),
  recur: (<><path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4" /><path d="M19.8 4.2v3.6h-3.6" /><path d="M12 8.4v4l2.4 1.5" opacity=".6" /></>),
  tank: (<><rect x="3" y="3.5" width="10" height="17" rx="2" /><path d="M3 8.5h10" /><path d="M13 7h3a1.8 1.8 0 0 1 1.8 1.8v8.4a1.6 1.6 0 0 0 3.2 0V10l-2.5-2.5" /></>),
  tools: (<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>),
  agent: (<><circle cx="12" cy="9" r="3" /><path d="M5.5 19a6.5 6.5 0 0 1 13 0" /><circle cx="12" cy="12" r="9" opacity=".35" /></>),
};

function Ic({ name, className = "w-5 h-5", color = "currentColor" }: { name: string; className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

function SparkIcon({ className, color = "currentColor" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function QuoteIcon({ className, color = "currentColor" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M9.5 7.5C7 8.3 5.5 10.4 5.5 13c0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6 0-.8-.6-1.5-1.4-1.6.3-1 1.1-1.8 2.2-2.2zM17.5 7.5c-2.5.8-4 2.9-4 5.5 0 .9.7 1.6 1.6 1.6.9 0 1.6-.7 1.6-1.6 0-.8-.6-1.5-1.4-1.6.3-1 1.1-1.8 2.2-2.2z" fill={color} />
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
    <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: color, boxShadow: `0 0 8px ${color}` }} aria-hidden />
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
        maskImage: "radial-gradient(ellipse at center, black 35%, transparent 78%)",
        WebkitMaskImage: "radial-gradient(ellipse at center, black 35%, transparent 78%)",
      }}
    />
  );
}

// Section heading (left-aligned kicker + gradient title) ---------------------

function SectionHead({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) {
  return (
    <motion.div {...reveal} className="mb-8">
      <div className="text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-2.5" style={{ color: "#F5C518" }}>
        {kicker}
      </div>
      <h2 className="font-display text-3xl md:text-[2.5rem] font-semibold tracking-[-0.02em] leading-[1.05]" style={titleSheen}>
        {title}
      </h2>
      {sub && (
        <p className="text-sm md:text-base mt-3 max-w-[44rem] leading-relaxed" style={{ color: "rgba(226,232,240,0.62)" }}>
          {sub}
        </p>
      )}
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
      <span className="inline-block transition-transform group-hover:translate-x-1" aria-hidden>&rarr;</span>
    </Link>
  );
}

function SecondaryCta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium font-display border transition-all hover:-translate-y-0.5"
      style={{ borderColor: "rgba(91,200,250,0.28)", color: "rgba(226,232,240,0.9)", background: "rgba(91,200,250,0.05)" }}
    >
      {children}
    </Link>
  );
}

// "Works with" client logo strip (white chips; light marks inverted). --------

function WorksWith() {
  return (
    <div className="mt-9 flex items-center gap-3 flex-wrap">
      <span className="text-[10px] uppercase tracking-[0.2em] font-mono" style={{ color: "rgba(226,232,240,0.45)" }}>
        Works with
      </span>
      <div className="flex items-center gap-2">
        {CLIENTS.map((c) => (
          <span key={c.name} className="w-7 h-7 rounded-md bg-white p-1 flex items-center justify-center" title={c.name}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.src} alt={c.name} className={`w-full h-full object-contain ${c.invert ? "invert" : ""}`} />
          </span>
        ))}
      </div>
    </div>
  );
}

// Hero - asymmetric 2-col: copy left, live console right ----------------------

function Hero() {
  return (
    <section className="grid lg:grid-cols-[1.05fr_0.92fr] gap-10 lg:gap-14 items-center mb-20 lg:mb-24">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-6"
          style={{ background: "rgba(245,197,24,0.10)", color: "#F5C518", border: "1px solid rgba(245,197,24,0.22)" }}
        >
          <SparkIcon className="w-3 h-3" color="#F5C518" />
          Agent Wallet
        </div>
        <h1 className="font-display text-5xl md:text-6xl lg:text-[4.2rem] font-semibold tracking-[-0.03em] mb-5 leading-[1.02]">
          <span
            style={{
              background: "linear-gradient(100deg, #ffffff 0%, #F5C518 52%, #5BC8FA 100%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
              color: "transparent",
            }}
          >
            Give your AI a wallet it can actually use.
          </span>
        </h1>
        <p className="text-base md:text-lg leading-relaxed max-w-[34rem]" style={{ color: "rgba(226,232,240,0.75)" }}>
          A wallet your AI signs through. Your MetaMask is untouched. Per-tx and per-day caps, up to 10 wallets per owner, 10 EVM chains, keys exportable anytime.
        </p>
        <div className="flex flex-wrap gap-3 mt-7">
          <PrimaryCta href="/dashboard">Open dashboard</PrimaryCta>
          <SecondaryCta href="/claude">Use from any MCP client</SecondaryCta>
        </div>
        <WorksWith />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.1 }}>
        <ConsoleMockup />
      </motion.div>
    </section>
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
    return "rgba(226,232,240,0.45)";
  };

  return (
    <div
      className="rounded-2xl border p-5 font-mono text-[13px] leading-relaxed relative"
      style={{
        background: "rgba(7,12,22,0.92)",
        borderColor: "rgba(245,197,24,0.22)",
        boxShadow: "0 0 0 1px rgba(245,197,24,0.05), 0 30px 80px rgba(0,0,0,0.4)",
      }}
    >
      {/* Top accent hairline (yellow -> cyan), like the landing terminal. */}
      <div
        aria-hidden
        className="absolute top-0 left-0 right-0 h-px rounded-t-2xl"
        style={{ background: "linear-gradient(90deg, transparent, rgba(245,197,24,0.6), rgba(91,200,250,0.6), transparent)" }}
      />
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 mb-4">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(239,68,68,0.55)" }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: "rgba(245,197,24,0.55)" }} />
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
    </div>
  );
}

// Proof row ------------------------------------------------------------------

function ProofRow() {
  const rows: { label: string; value: string; foot: string }[] = [
    { label: "Chains live", value: "10 EVM", foot: "BNB . ETH . AVAX . X Layer . Stable . Mantle . Injective . Monad . Scroll . Arbitrum" },
    { label: "Wallet popups", value: "Zero", foot: "Your agent signs through Q402. Your MetaMask is never touched." },
    { label: "Spend controls", value: "Per-tx . daily", foot: "Caps enforced at the relay on every send and batch row." },
    { label: "Settle time", value: "< 0.9 s", foot: "Median inclusion, single recipient, sender pays $0 gas." },
  ];
  return (
    <motion.div {...reveal} className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-24">
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
          <div className="text-xl font-semibold font-mono mb-1" style={{ color: "#F5C518" }}>{r.value}</div>
          <div className="text-[11px] leading-snug" style={{ color: "rgba(226,232,240,0.55)" }}>{r.foot}</div>
        </motion.div>
      ))}
    </motion.div>
  );
}

// Prompt examples - full-width 3-up bento ------------------------------------

function PromptExamplesSection() {
  const prompts: { quote: string; lane: "recurring" | "routing" | "policy" }[] = [
    { quote: "Every Friday, send 25 USDT to these 8 contributors.", lane: "recurring" },
    { quote: "If Scroll gas is cheaper than Ethereum, use Scroll.", lane: "routing" },
    { quote: "Never spend more than $200 per transaction or $500 per day.", lane: "policy" },
  ];
  const laneLabel: Record<string, string> = { recurring: "recurring payout", routing: "chain routing", policy: "spending policy" };

  return (
    <div className="mb-24">
      <SectionHead
        kicker="Try saying this"
        title="Plain English. Real settlement."
        sub="Claude, Codex, Cursor, Cline. One MCP tool, one Agent Wallet. Your agent only ever spends what you let it, with caps enforced server-side on every send."
      />
      <div className="grid md:grid-cols-3 gap-4">
        {prompts.map((p, i) => {
          const isCyan = p.lane === "routing";
          return (
            <motion.div
              key={p.quote}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ amount: 0.35 }}
              transition={{ duration: 0.45, delay: i * 0.08 }}
              whileHover={{ y: -4 }}
              className="rounded-2xl border p-6 flex flex-col gap-5"
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
              <div className="text-[18px] md:text-[19px] font-medium leading-snug" style={{ color: "#E2E8F0" }}>
                {p.quote}
              </div>
              <div className="text-[10.5px] uppercase tracking-[0.18em] font-mono mt-auto" style={{ color: isCyan ? "#5BC8FA" : "rgba(226,232,240,0.55)" }}>
                {laneLabel[p.lane]}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// Safety trio - the real Agent-Wallet differentiators ------------------------

function SafetySection() {
  const items = [
    { ic: "shield", tag: "Intent-bound", title: "Every spend is signed for exactly what it does.", body: "Each transfer needs a fresh owner signature that embeds the chain, token, recipient and amount. A signature for one action can never be replayed for another." },
    { ic: "lock", tag: "Idempotent", title: "A replayed request can not double-spend.", body: "Single sends and batch payouts settle against a one-time action challenge, so a retried or duplicated call never moves funds twice." },
    { ic: "seal", tag: "Trust Receipt", title: "Proof you can verify yourself.", body: "Every transfer returns a tamper-evident Trust Receipt. The signature is recovered from on-chain state, with no Q402 API call needed." },
  ];
  return (
    <div className="mb-24">
      <SectionHead kicker="Why it is safe" title="Autonomy, without handing over the keys." />
      <div className="grid md:grid-cols-3 gap-4">
        {items.map((it, i) => (
          <motion.div
            key={it.tag}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ amount: 0.35 }}
            transition={{ duration: 0.45, delay: i * 0.08 }}
            whileHover={{ y: -4 }}
            className="rounded-2xl border p-6"
            style={{ background: "rgba(91,200,250,0.035)", borderColor: "rgba(91,200,250,0.2)" }}
          >
            <div className="flex items-center gap-3 mb-4">
              <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "rgba(91,200,250,0.1)", border: "1px solid rgba(91,200,250,0.25)", color: "#5BC8FA" }}>
                <Ic name={it.ic} className="w-5 h-5" />
              </span>
              <span className="text-[10px] uppercase tracking-[0.2em] font-mono" style={{ color: "#5BC8FA" }}>{it.tag}</span>
            </div>
            <div className="text-lg font-semibold font-display mb-2 leading-snug">{it.title}</div>
            <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.62)" }}>{it.body}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// Capabilities bento - the current product surface --------------------------

function CapCard({ ic, tag, title, body, feature: isFeature }: { ic: string; tag: string; title: string; body: string; feature?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ amount: 0.3 }}
      transition={{ duration: 0.4 }}
      whileHover={{ y: -4 }}
      className={`rounded-2xl border p-6 ${isFeature ? "md:col-span-2" : ""}`}
      style={
        isFeature
          ? { background: "linear-gradient(150deg, rgba(245,197,24,0.1), rgba(245,197,24,0.02))", borderColor: "rgba(245,197,24,0.3)" }
          : { background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.08)" }
      }
    >
      <div className="flex items-center gap-3 mb-4">
        <span
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: "rgba(245,197,24,0.1)", border: "1px solid rgba(245,197,24,0.22)", color: "#F5C518" }}
        >
          <Ic name={ic} className="w-5 h-5" />
        </span>
        <span className="text-[10px] uppercase tracking-[0.2em] font-mono" style={{ color: "rgba(226,232,240,0.5)" }}>{tag}</span>
      </div>
      <div className={`font-semibold font-display mb-2 leading-snug ${isFeature ? "text-2xl" : "text-lg"}`}>{title}</div>
      <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.62)" }}>{body}</div>
    </motion.div>
  );
}

const CAP_FEATURE = {
  ic: "wallets",
  tag: "Agentic Wallets",
  title: "Up to 10 wallets per owner, each with its own caps.",
  body: "Spin up a separate Agent Wallet per project or per agent. Every wallet carries its own per-transaction and per-day USD limits, enforced server-side at the relay so a runaway agent stays bounded.",
};
const CAP_TILES = [
  { ic: "yield", tag: "Yield", title: "Aave V3 routing", body: "Park idle USDC or USDT into Aave V3 from a prompt. Live on BNB to start." },
  { ic: "bridge", tag: "Bridge", title: "CCIP cross-chain", body: "Move USDC across Ethereum, Avalanche and Arbitrum via Chainlink CCIP." },
  { ic: "batch", tag: "Batch", title: "Payouts up to 20", body: "Up to 20 recipients in one signed call, with per-row results back." },
  { ic: "recur", tag: "Recurring", title: "Scheduled spend", body: "Schedule payouts with a cancel-window before each run. Pause, resume, skip or cancel." },
  { ic: "tank", tag: "Gas Tank", title: "One tank, 10 chains", body: "One pre-funded tank sponsors gas across all 10 chains. Top up once." },
  { ic: "tools", tag: "MCP", title: "24 tools, one package", body: "npx @quackai/q402-mcp wires the full tool surface into Claude, Codex, Cursor and Cline." },
  { ic: "agent", tag: "ERC-8004", title: "Graduate on-chain", body: "Register an Agent Wallet as an on-chain ERC-8004 agent and earn weekly on-chain reputation feedback." },
];

function CapabilitiesSection() {
  return (
    <div className="mb-24">
      <SectionHead
        kicker="Beyond a single send"
        title="Everything an autonomous agent needs to spend."
        sub="The SDK and the 24-tool MCP server go well past one-shot payments."
      />
      <div className="grid md:grid-cols-3 gap-4">
        <CapCard {...CAP_FEATURE} feature />
        {CAP_TILES.map((t) => <CapCard key={t.tag} {...t} />)}
      </div>
    </div>
  );
}

// Flow -----------------------------------------------------------------------

function FlowSection() {
  const steps = [
    { n: "01", title: "Install Q402 MCP", body: "One package, every MCP client. The same tool surface in Claude, Codex, Cursor and Cline.", code: INSTALL_CMD },
    { n: "02", title: "Create the wallet", body: "One signature on the dashboard. Set per-tx and daily caps. Keys exportable anytime.", code: 'POST /api/wallet/agentic\n  -> { address: "0xD2..ff64", createdAt: 1717... }' },
    { n: "03", title: "Let the agent run", body: "One tool call. Server signs, the relayer pays gas, every transfer returns a Trust Receipt.", code: 'agent.pay({\n  chain: "bnb",\n  token: "USDC",\n  to:   "0x9c..2f4a",\n  amount: "3.24"\n})' },
  ];
  return (
    <div className="mb-24">
      <SectionHead kicker="How it works" title="Three steps to autonomous spend." sub="Bounded by limits you set. Trust-receipted on every transfer." />
      <div className="space-y-4">
        {steps.map((s, i) => (
          <motion.div
            key={s.n}
            initial={{ opacity: 0, x: -8 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ amount: 0.4 }}
            transition={{ duration: 0.45, delay: i * 0.08 }}
            className="grid md:grid-cols-[120px_1fr_1.1fr] gap-5 items-start rounded-2xl border p-5 relative"
            style={{ background: "rgba(226,232,240,0.02)", borderColor: "rgba(226,232,240,0.07)" }}
          >
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
              <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.6)" }}>{s.body}</div>
            </div>
            <pre
              className="rounded-2xl p-4 text-[12px] font-mono leading-relaxed whitespace-pre overflow-x-auto"
              style={{ background: "rgba(7,12,22,0.75)", color: "#cbd5e1", border: "1px solid rgba(245,197,24,0.16)" }}
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
    { eyebrow: "Streaming spend", headline: "Pay per row, not per call.", body: "Crawlers and RAG pipelines fan out micro-payments to data providers in real time. Limits cap the worst case." },
    { eyebrow: "Batch payouts", headline: "20 recipients, one call.", body: "Reward distribution, ambassador stipends, vendor invoices. Submit up to 20 transfers in a single batch and get per-row results back." },
    { eyebrow: "Recurring API spend", headline: "Keep the lights on, automatically.", body: "Top up worker bots and partner services on a schedule. A reverse-direction sweep keeps the agent wallet itself funded." },
  ];
  return (
    <div className="mb-24">
      <SectionHead kicker="Patterns" title="What this unlocks." />
      <div className="grid md:grid-cols-3 gap-4">
        {patterns.map((p, i) => {
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
              style={{ background: "rgba(226,232,240,0.02)", borderColor: isCyan ? "rgba(91,200,250,0.22)" : "rgba(226,232,240,0.07)" }}
            >
              <div className="text-[10px] uppercase tracking-[0.22em] font-bold font-display mb-3" style={{ color: isCyan ? "#5BC8FA" : "#F5C518" }}>
                {p.eyebrow}
              </div>
              <div className="text-lg font-semibold font-display mb-3">{p.headline}</div>
              <div className="text-sm leading-relaxed" style={{ color: "rgba(226,232,240,0.6)" }}>{p.body}</div>
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
      className="rounded-2xl border p-8 md:p-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6"
      style={{
        background: "linear-gradient(135deg, rgba(245,197,24,0.1) 0%, rgba(91,200,250,0.06) 55%, rgba(7,12,22,0.6) 100%)",
        borderColor: "rgba(245,197,24,0.22)",
      }}
    >
      <div>
        <div className="text-2xl md:text-3xl font-semibold font-display mb-1.5" style={titleSheen}>Spin one up.</div>
        <div className="text-sm md:text-base max-w-[46rem]" style={{ color: "rgba(226,232,240,0.62)" }}>
          Free to create. Send on BNB Chain today; a multichain key opens the rest of the 10 EVM chains when you are ready.
        </div>
      </div>
      <div className="flex flex-wrap gap-3 shrink-0">
        <PrimaryCta href="/dashboard">Create Agent Wallet</PrimaryCta>
        <SecondaryCta href="/docs#claude-mcp">Read the docs</SecondaryCta>
      </div>
    </motion.div>
  );
}
