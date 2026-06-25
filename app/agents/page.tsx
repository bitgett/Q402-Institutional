"use client";

/**
 * /agents - Q402 Agent Wallet product page.
 *
 * Identity: a flat technical "datasheet" with editorial big-type, deliberately
 * NOT the marketing landing. The landing's signature motifs are all avoided here
 * on purpose: no radial corner glows, no grid overlay, no yellow->cyan glow
 * terminal, no glowing rounded bento cards with yellow icon chips, no hover-lift
 * everywhere, no gradient-clip "sheen" titles, no gradient CTA band. Instead:
 * a flat navy base, a sticky left index gutter, hairline section rules, sharp
 * 4px-radius bordered blocks with no shadow, solid-ink Space Grotesk headlines,
 * monospace tool tags, and restrained color (yellow for one accent word + the
 * primary CTA, cyan for signatures/tool tags). Palette stays navy + #F5C518 +
 * #5BC8FA. Brand mark comes from the shared Navbar / Footer.
 *
 * Every number/limit below is grounded in the real product (mcp-server tool
 * surface, app/lib/agentic-wallet*, contracts.manifest.json) as of 2026-06.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";
import { MCP_CLIENTS as CLIENTS } from "@/app/lib/mcp-clients";

const INK = "#E6EAF2";
const MUT = "rgba(230,234,242,0.60)";
const MUT2 = "rgba(230,234,242,0.40)";
const LINE = "rgba(255,255,255,0.11)";
const HAIR = "rgba(255,255,255,0.07)";
const YELLOW = "#F5C518";
const CYAN = "#5BC8FA";

const INSTALL_CMD = "npx -y @quackai/q402-mcp";

// Hero key facts - the one place these headline numbers live.
const HERO_FACTS = [
  { v: "30", label: "MCP tools" },
  { v: "11", label: "EVM chains" },
  { v: "$0", label: "gas per send" },
  { v: "10", label: "wallets / owner" },
];


// 01 - the safety model. The product's central differentiator, stated as spec.
const SAFETY = [
  {
    term: "Intent-bound signatures",
    body: "Every spend carries a fresh owner signature over the exact chain, token, recipient and amount. A signature for one action can not be replayed as another, or against another wallet.",
  },
  {
    term: "Per-transaction and daily caps",
    body: "Defaults of $200 per transaction and $500 per day, set per wallet, enforced server-side on every send and on every row of a batch. A runaway agent stays bounded.",
  },
  {
    term: "Keys you actually hold",
    body: "Wallet keys are AES-GCM encrypted and bound to your account, exportable anytime with an audit log. Delete a wallet and it stays recoverable for 7 days.",
  },
  {
    term: "Funds the server can not touch",
    body: "Gas deposits, revenue and the relayer hot wallet are three separate addresses. A server compromise can drain the operational gas float, never your deposits.",
  },
  {
    term: "Idempotent settlement",
    body: "Single sends and batch payouts settle behind a per-wallet, per-chain lock against a one-time challenge, so a retried or duplicated call never moves funds twice.",
  },
  {
    term: "Receipts you verify offline",
    body: "Every transfer returns a Trust Receipt. Recover the relayer signature from on-chain state to verify it yourself, with no Q402 API call in the loop.",
  },
];

// 02 - one run: the request log (typed in) and the resulting receipt fields.
const RUN_LOG: { text: string; kind?: "you" | "ok" | "out" }[] = [
  { text: "agent: pay data provider 3.24 USDC", kind: "you" },
  { text: 'q402_pay(chain:"bnb", token:"USDC", to:"0x9c..2f4a", amount:"3.24")', kind: "out" },
  { text: "signing intent ......... ok", kind: "ok" },
  { text: "relayer sponsors gas ... ok", kind: "ok" },
  { text: "settled in one transaction", kind: "ok" },
  { text: "receipt rct_aB12cd34", kind: "ok" },
];
const RECEIPT_FIELDS: { k: string; v: string; check?: boolean }[] = [
  { k: "receiptId", v: "rct_aB12cd34" },
  { k: "chain", v: "bnb" },
  { k: "token", v: "USDC" },
  { k: "amount", v: "3.24" },
  { k: "method", v: "eip7702" },
  { k: "recipient", v: "0x9c..2f4a" },
  { k: "signature", v: "verified offline", check: true },
];

// 03 - capabilities, each with the real numbers and the tools behind it.
const CAPS = [
  {
    title: "Single and batch pay",
    body: "One recipient, or up to 20 in a single signed call (5 on the free trial). Same chain and token across the batch, with per-row results returned.",
    tools: ["q402_pay", "q402_batch_pay"],
  },
  {
    title: "Recurring spend",
    body: "Hourly, daily, weekly or monthly rules with a cancel window of up to 14 days. Pause, resume, skip one fire, or cancel. Each rule tracks its own running total.",
    tools: ["q402_recurring_*"],
  },
  {
    title: "Aave V3 yield",
    body: "Park idle USDC or USDT into Aave V3 straight from a prompt, then withdraw on demand. Live on BNB Chain to start.",
    tools: ["q402_yield_*"],
  },
  {
    title: "CCIP cross-chain bridge",
    body: "Move USDC across the Ethereum, Avalanche and Arbitrum triangle at Chainlink's price, with zero Q402 markup. Fee in LINK or native.",
    tools: ["q402_bridge_*"],
  },
  {
    title: "Gas Tank",
    body: "Fund gas once. Q402 sponsors settlement across all 11 chains and auto-funds bridge fees per chain. The server never receives your deposit.",
    tools: ["q402_bridge_gas_tank"],
  },
  {
    title: "ERC-8004 graduation",
    body: "Register an Agent Wallet on-chain as an ERC-8004 agent and earn a weekly reputation write that summarizes its settlement activity. On BNB Chain today.",
    tools: ["q402_agentic_info"],
  },
];

// 04 - the full 30-tool surface, grouped like an API reference (5+2+1+7+4+2+4+1+3).
const TOOL_GROUPS = [
  { label: "Setup and read", tools: ["q402_doctor", "q402_quote", "q402_balance", "q402_agentic_info", "q402_wallet_status"] },
  { label: "Pay", tools: ["q402_pay", "q402_batch_pay"] },
  { label: "Receipts", tools: ["q402_receipt"] },
  { label: "Recurring", tools: ["q402_recurring_list", "q402_recurring_create", "q402_recurring_fires", "q402_recurring_pause", "q402_recurring_resume", "q402_recurring_skip_next", "q402_recurring_cancel"] },
  { label: "Yield", tools: ["q402_yield_reserves", "q402_yield_positions", "q402_yield_deposit", "q402_yield_withdraw"] },
  { label: "Staking", tools: ["q402_stake", "q402_unstake"] },
  { label: "Bridge", tools: ["q402_bridge_quote", "q402_bridge_send", "q402_bridge_history", "q402_bridge_gas_tank"] },
  { label: "Delegation", tools: ["q402_clear_delegation"] },
  { label: "Requests", tools: ["q402_request_create", "q402_request_status", "q402_request_pay"] },
];

const CHAINS = ["BNB", "Ethereum", "Arbitrum", "Avalanche", "Mantle", "X Layer", "Monad", "Scroll", "Injective", "Stable", "Base"];

// Distinct, restrained motion: a short rise with a different easing than the
// landing's fadeUp signature, and it does not repeat on every tiny element.
const rise = {
  initial: { opacity: 0, y: 10 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { amount: 0.2, once: true } as const,
  transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
};

export default function AgentsPage() {
  return (
    <>
      <Navbar />
      <main className="font-poppins" style={{ background: "linear-gradient(180deg, #070B14 0%, #0A0F1C 100%)", color: INK }}>
        <div className="max-w-[1240px] mx-auto px-6 sm:px-8">
          <Hero />
          <Section index="01" label="Control" title={<>Autonomy with a leash <span style={{ color: YELLOW }}>you hold.</span></>} sub="An Agent Wallet your AI signs through, not your MetaMask. Six guarantees keep a self-driving agent bounded.">
            <SafetySpec />
          </Section>
          <Section index="02" label="Proof" title="One tool call. Settled, gas sponsored." accent={CYAN} sub="A real pay flow and the Trust Receipt it returns. The receipt verifies offline against on-chain state.">
            <RunBlock />
          </Section>
          <Section index="03" label="Capabilities" title="Well past a single payment.">
            <CapabilityGrid />
          </Section>
          <Section index="04" label="30 tools" title="The whole surface, one package.">
            <InstallBlock />
            <ToolIndex />
            <ChainStrip />
          </Section>
        </div>
      </main>
      <Footer />
    </>
  );
}

// Small inline checkmark (functional SVG, not an emoji glyph). ----------------

function Check({ color = CYAN }: { color?: string }) {
  return (
    <svg viewBox="0 0 16 16" className="inline-block w-3.5 h-3.5 ml-1.5 -translate-y-px" fill="none" aria-hidden>
      <path d="M3 8.5l3 3 7-7.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Monospace tool tag - flat bordered, no fill, no glow (reads like inline code).

function Tool({ name }: { name: string }) {
  return (
    <span
      className="font-mono text-[11px] leading-none px-1.5 py-1 rounded-[3px] border whitespace-nowrap"
      style={{ borderColor: "rgba(91,200,250,0.26)", color: "rgba(91,200,250,0.92)" }}
    >
      {name}
    </span>
  );
}

// Section frame: sticky left index gutter + hairline top rule + content. ------

function Section({
  index,
  label,
  title,
  sub,
  accent = YELLOW,
  children,
}: {
  index: string;
  label: string;
  title: React.ReactNode;
  sub?: string;
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t py-16 lg:py-24" style={{ borderColor: HAIR }}>
      <div className="grid lg:grid-cols-[92px_1fr] gap-7 lg:gap-12">
        <div className="hidden lg:block">
          <div className="sticky top-28 font-grotesk font-semibold text-2xl" style={{ color: "rgba(255,255,255,0.18)" }}>
            {index}
          </div>
        </div>
        <div>
          <motion.div {...rise} className="mb-9">
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] mb-5" style={{ color: accent }}>
              [ {label} ]
            </div>
            <h2 className="font-grotesk font-semibold tracking-[-0.03em] leading-[1.05] text-[clamp(1.85rem,3.8vw,2.8rem)] max-w-[22ch]" style={{ color: INK }}>
              {title}
            </h2>
            {sub && (
              <p className="text-[15px] mt-4 max-w-[44rem] leading-relaxed" style={{ color: MUT }}>
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

// CTAs - pill buttons (a brand element, kept consistent across the site). ------

function PrimaryCta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold font-grotesk text-navy bg-yellow hover:bg-yellow-hover transition-colors"
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
      className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium font-grotesk border transition-colors hover:border-white/30"
      style={{ borderColor: LINE, color: "rgba(230,234,242,0.9)" }}
    >
      {children}
    </Link>
  );
}

// Hero - type-forward, flat. No glows, no grid, no animated terminal. ---------

function Hero() {
  return (
    <section className="pt-28 lg:pt-32 pb-14 lg:pb-20">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
        <div className="font-mono text-[11px] uppercase tracking-[0.34em] mb-7" style={{ color: MUT2 }}>
          [ Q402 / Agent Wallet ]
        </div>
        <h1 className="font-grotesk font-semibold tracking-[-0.035em] leading-[0.98] text-[clamp(2.6rem,7vw,5.2rem)] max-w-[17ch]" style={{ color: INK }}>
          Let your agent hold a wallet,{" "}
          <span style={{ color: YELLOW }}>not your keys.</span>
        </h1>
        <p className="text-lg leading-relaxed mt-7 max-w-[40rem]" style={{ color: MUT }}>
          Q402 Agent Wallets sign and settle on their own across 11 EVM chains, gasless, inside the
          per-transaction and daily caps you set. Export the keys or delete the wallet anytime.
        </p>
        <div className="flex flex-wrap gap-3 mt-9">
          <PrimaryCta href="/dashboard">Open dashboard</PrimaryCta>
          <SecondaryCta href="/claude">Install the MCP</SecondaryCta>
        </div>
      </motion.div>

      {/* Flat facts row + works-with, separated by a single hairline. */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.15 }}
        className="mt-14 pt-9 border-t flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8"
        style={{ borderColor: HAIR }}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-10 gap-y-6">
          {HERO_FACTS.map((f) => (
            <div key={f.label}>
              <div className="font-mono font-medium leading-none text-[clamp(1.7rem,2.6vw,2.1rem)]" style={{ color: INK }}>
                {f.v}
              </div>
              <div className="text-[11px] uppercase tracking-[0.16em] font-mono mt-2" style={{ color: MUT2 }}>
                {f.label}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[10px] uppercase tracking-[0.24em] font-mono" style={{ color: MUT2 }}>
            Works with
          </span>
          <div className="flex items-center gap-2">
            {CLIENTS.map((c) => (
              <span key={c.name} className="w-7 h-7 rounded-[5px] bg-white p-1 flex items-center justify-center" title={c.name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.src} alt={c.name} className={`w-full h-full object-contain ${c.invert ? "invert" : ""}`} />
              </span>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

// 01 - safety spec: full-width numbered rows, big index, hairline dividers. ----

function SafetySpec() {
  return (
    <div>
      {SAFETY.map((s, i) => (
        <motion.div
          key={s.term}
          {...rise}
          className="grid md:grid-cols-[60px_minmax(0,17rem)_1fr] gap-4 md:gap-8 py-7 border-t items-start"
          style={{ borderColor: HAIR }}
        >
          <div className="font-grotesk font-semibold leading-none text-3xl md:text-4xl" style={{ color: "rgba(255,255,255,0.16)" }}>
            {String(i + 1).padStart(2, "0")}
          </div>
          <div className="font-grotesk text-lg md:text-xl font-semibold tracking-[-0.01em]" style={{ color: INK }}>
            {s.term}
          </div>
          <p className="text-[15px] leading-relaxed md:pt-0.5" style={{ color: MUT }}>
            {s.body}
          </p>
        </motion.div>
      ))}
    </div>
  );
}

// 02 - run block: flat log (typed) + flat receipt fields, no glow terminal. ----

function RunBlock() {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (visible >= RUN_LOG.length) {
      const hold = setTimeout(() => setVisible(0), 2800);
      return () => clearTimeout(hold);
    }
    const t = setTimeout(() => setVisible((v) => v + 1), 560);
    return () => clearTimeout(t);
  }, [visible]);

  const logColor = (kind?: "you" | "ok" | "out") => {
    if (kind === "you") return CYAN;
    if (kind === "ok") return YELLOW;
    if (kind === "out") return INK;
    return MUT;
  };

  return (
    <motion.div {...rise} className="grid lg:grid-cols-2 gap-4">
      {/* Request log - flat, single thin top rule (not a yellow->cyan gradient). */}
      <div className="border rounded-[4px] p-5 md:p-6 font-mono text-[13px] leading-relaxed" style={{ borderColor: LINE, background: "rgba(255,255,255,0.015)" }}>
        <div className="h-px -mx-5 md:-mx-6 -mt-5 md:-mt-6 mb-5" style={{ background: "rgba(91,200,250,0.4)" }} />
        <div className="text-[10px] uppercase tracking-[0.24em] mb-4" style={{ color: MUT2 }}>
          mcp . q402_pay . request
        </div>
        <div className="space-y-1.5 min-h-[170px]">
          {RUN_LOG.slice(0, visible).map((l, i) => (
            <div key={i} style={{ color: logColor(l.kind) }}>
              {l.kind === "you" && <span style={{ color: CYAN }}>$ </span>}
              {l.kind === "out" && <span style={{ color: MUT2 }}>&gt; </span>}
              {l.text}
            </div>
          ))}
          {visible < RUN_LOG.length && <span className="inline-block w-2 h-4 align-middle" style={{ background: YELLOW }} />}
        </div>
      </div>

      {/* Trust Receipt - flat field list, square corners. */}
      <div className="border rounded-[4px] p-5 md:p-6 font-mono text-[13px]" style={{ borderColor: LINE, background: "rgba(255,255,255,0.015)" }}>
        <div className="h-px -mx-5 md:-mx-6 -mt-5 md:-mt-6 mb-5" style={{ background: "rgba(245,197,24,0.4)" }} />
        <div className="text-[10px] uppercase tracking-[0.24em] mb-4" style={{ color: MUT2 }}>
          trust receipt . response
        </div>
        <div className="divide-y" style={{ borderColor: HAIR }}>
          {RECEIPT_FIELDS.map((f) => (
            <div key={f.k} className="flex items-center justify-between py-2.5" style={{ borderColor: HAIR }}>
              <span style={{ color: MUT2 }}>{f.k}</span>
              <span style={{ color: f.check ? CYAN : INK }}>
                {f.v}
                {f.check && <Check />}
              </span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// 03 - capabilities: flat bordered blocks, no icon chips, no hover-lift. -------

function CapabilityGrid() {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {CAPS.map((c) => (
        <motion.div
          key={c.title}
          {...rise}
          className="border rounded-[4px] p-6 flex flex-col gap-4"
          style={{ borderColor: LINE, background: "rgba(255,255,255,0.012)" }}
        >
          <h3 className="font-grotesk text-lg md:text-xl font-semibold tracking-[-0.01em]" style={{ color: INK }}>
            {c.title}
          </h3>
          <p className="text-[14.5px] leading-relaxed" style={{ color: MUT }}>
            {c.body}
          </p>
          <div className="flex flex-wrap gap-2 mt-auto pt-1">
            {c.tools.map((t) => <Tool key={t} name={t} />)}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// 04 - install: one command, every client. Flat block with a copy affordance.

function InstallBlock() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(INSTALL_CMD).then(() => setCopied(true)).catch(() => {});
  };

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <motion.div
      {...rise}
      className="border rounded-[4px] p-6 md:p-7 mb-12 flex flex-col md:flex-row md:items-center md:justify-between gap-6"
      style={{ borderColor: LINE, background: "rgba(255,255,255,0.015)" }}
    >
      <div>
        <div className="flex items-center gap-3 mb-2">
          <span className="font-mono text-[11px]" style={{ color: MUT2 }}>01</span>
          <h3 className="font-grotesk text-lg md:text-xl font-semibold tracking-[-0.01em]" style={{ color: INK }}>
            Install Q402 MCP
          </h3>
        </div>
        <p className="text-[14.5px] leading-relaxed max-w-[36rem]" style={{ color: MUT }}>
          One package, every MCP client. Same surface in Claude, Codex, Cursor, Cline.
        </p>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        <code
          className="font-mono text-[13.5px] px-4 py-3 rounded-[4px] border"
          style={{ borderColor: LINE, background: "rgba(7,11,20,0.6)", color: INK }}
        >
          <span style={{ color: MUT2 }}>$ </span>
          {INSTALL_CMD}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy install command"
          className="font-mono text-[11px] uppercase tracking-[0.14em] px-3 py-3 rounded-[4px] border transition-colors hover:border-white/30"
          style={{ borderColor: LINE, color: copied ? CYAN : MUT }}
        >
          {copied ? "copied" : "copy"}
          {copied && <Check />}
        </button>
      </div>
    </motion.div>
  );
}

// 04 - tool index: grouped mono columns, like an API reference. ---------------

function ToolIndex() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-9">
      {TOOL_GROUPS.map((g) => (
        <motion.div key={g.label} {...rise}>
          <div className="flex items-baseline justify-between mb-3 pb-2 border-b" style={{ borderColor: HAIR }}>
            <span className="font-mono text-[11px] uppercase tracking-[0.2em]" style={{ color: YELLOW }}>{g.label}</span>
            <span className="font-mono text-[11px]" style={{ color: MUT2 }}>{g.tools.length}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {g.tools.map((t) => (
              <span key={t} className="font-mono text-[12.5px]" style={{ color: MUT }}>{t}</span>
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// Chains + tokens support strip (flat, mono). --------------------------------

function ChainStrip() {
  return (
    <motion.div {...rise} className="mt-12 pt-8 border-t" style={{ borderColor: HAIR }}>
      <div className="font-mono text-[11px] uppercase tracking-[0.24em] mb-4" style={{ color: MUT2 }}>
        11 chains . USDC and USDT everywhere . RLUSD on Ethereum
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-2">
        {CHAINS.map((c) => (
          <span key={c} className="font-mono text-[13px] px-2.5 py-1 rounded-[3px] border" style={{ borderColor: LINE, color: MUT }}>
            {c}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

