"use client";

/**
 * /grant - Q402 grant program application.
 *
 * Shares the /agents + /claude design language (flat technical datasheet,
 * Space Grotesk, sticky numbered index gutter, hairline section rules, navy +
 * #F5C518 + #5BC8FA only) so the product pages read as one family. Its own
 * composition fits the job: tiers, why-build-on-Q402, and an application form
 * that POSTs to /api/grant. No marketing-landing motifs (corner glows, gradient
 * sheen titles), and only the house accent colors.
 */

import Link from "next/link";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

const INK = "#E6EAF2";
const MUT = "rgba(230,234,242,0.60)";
const MUT2 = "rgba(230,234,242,0.40)";
const LINE = "rgba(255,255,255,0.11)";
const HAIR = "rgba(255,255,255,0.07)";
const YELLOW = "#F5C518";
const CYAN = "#5BC8FA";

const TIERS = [
  {
    name: "Seed",
    credit: "$500",
    txs: "Up to 10,000 txs",
    accent: YELLOW,
    desc: "Early-stage projects exploring gasless and agentic UX.",
    perks: ["$500 relay credit", "Priority support", "Q402 partner badge"],
  },
  {
    name: "Builder",
    credit: "$2,000",
    txs: "Up to 50,000 txs",
    accent: YELLOW,
    desc: "Live products scaling gasless and agent payments.",
    perks: ["$2,000 relay credit", "Co-marketing opportunity", "Direct Telegram line", "Custom chain config"],
    featured: true,
  },
  {
    name: "Ecosystem",
    credit: "Custom",
    txs: "Unlimited",
    accent: CYAN,
    desc: "Strategic partners and infrastructure builders.",
    perks: ["Custom credit pool", "Revenue share model", "Joint press release", "Board advisory access"],
  },
];

const WHY = [
  {
    title: "11 chains. One integration. No migration.",
    body: "Native operations on BNB Chain, Ethereum, Mantle, Avalanche, Injective, X Layer, Stable, Monad, Scroll, Arbitrum and Base through a single unified API. Not wrapped, not bridged. The multichain coverage that used to take months now takes an afternoon.",
  },
  {
    title: "Gasless for your users. And for their agents.",
    body: "EIP-712 and EIP-7702 mean no native-token prompts, no gas screens, no rejected transactions from empty wallets. The same rails run through a 29-tool MCP server, so an AI agent can pay on its own, inside the per-transaction and daily caps you set.",
  },
  {
    title: "We grow with what you ship.",
    body: "Recipients get co-marketing, joint launch announcements, a direct line to the core team and early access to every new chain we ship. Your transaction volume is the metric we track.",
  },
];

const CATEGORIES = ["DeFi", "GameFi", "NFT / Creator", "AI Agent", "DAO / Governance", "Infrastructure", "Social / Community", "Other"];
const CHAINS = ["BNB Chain", "Ethereum", "Avalanche", "Mantle", "Injective", "X Layer", "Stable", "Monad", "Scroll", "Arbitrum", "Multi-chain"];
const CREDITS = ["$500 (Seed)", "$2,000 (Builder)", "$5,000+", "Custom / discuss"];
const TX_RANGES = ["< 1,000 / mo", "1,000 - 10,000 / mo", "10,000 - 100,000 / mo", "100,000+ / mo"];

const rise = {
  initial: { opacity: 0, y: 10 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { amount: 0.2, once: true } as const,
  transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
};

// Section frame: sticky left index gutter + hairline top rule + content. ------
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
    <section id={id} className="border-t py-14 lg:py-20 scroll-mt-20" style={{ borderColor: HAIR }}>
      <div className="grid lg:grid-cols-[92px_1fr] gap-7 lg:gap-12">
        <div className="hidden lg:block">
          <div className="sticky top-24 font-grotesk font-semibold text-2xl" style={{ color: "rgba(255,255,255,0.18)" }}>
            {index}
          </div>
        </div>
        <div>
          <motion.div {...rise} className="mb-8">
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] mb-5" style={{ color: accent }}>
              [ {label} ]
            </div>
            <h2 className="font-grotesk font-semibold tracking-[-0.03em] leading-[1.05] text-[clamp(1.85rem,3.8vw,2.8rem)] max-w-[34ch]" style={{ color: INK }}>
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke={YELLOW} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9.5" stroke="rgba(245,197,24,0.4)" />
      <path d="M7.5 12.3l3 3 6-6.4" />
    </svg>
  );
}

export default function GrantPage() {
  const [form, setForm] = useState({
    projectName: "", website: "", email: "", telegram: "", twitter: "",
    category: "", targetChain: "", requestedCredit: "", expectedMonthlyTx: "",
    useCase: "", description: "",
  });
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    try {
      const res = await fetch("/api/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatus("success");
      } else {
        setErrorMsg(data.error ?? "Submission failed");
        setStatus("error");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }

  const inputCls = "w-full bg-white/[0.02] border border-white/10 rounded-[4px] px-4 py-3 text-sm text-white placeholder-white/25 outline-none focus:border-yellow/50 focus:bg-white/[0.04] transition-colors";
  const selectCls = `${inputCls} cursor-pointer appearance-none`;
  const labelCls = "block font-mono text-[10px] text-white/40 uppercase tracking-[0.16em] mb-2";

  return (
    <>
      <Navbar />
      <main className="font-poppins" style={{ background: "linear-gradient(180deg, #070B14 0%, #0A0F1C 100%)", color: INK }}>
        <div className="max-w-[1240px] mx-auto px-6 sm:px-8">

          {/* ── HERO ─────────────────────────────────────────────────────── */}
          <section className="pt-24 lg:pt-28 pb-6 lg:pb-8">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
              <div className="font-mono text-[11px] uppercase tracking-[0.34em] mb-7" style={{ color: MUT2 }}>
                [ Grant program / 2026 ]
              </div>
              <h1 className="font-grotesk font-semibold tracking-[-0.035em] leading-[1.0] text-[clamp(2rem,5vw,3.7rem)]" style={{ color: INK }}>
                Build on Q402. <span style={{ color: YELLOW }}>The gas is on us.</span>
              </h1>
              <p className="text-lg leading-relaxed mt-7 max-w-[42rem]" style={{ color: MUT }}>
                Relay credits, hands-on support and long-term partnership for teams shipping gasless
                and agentic stablecoin payments across 11 EVM chains.
              </p>
              <div className="flex flex-wrap gap-3 mt-9">
                <Link
                  href="#apply"
                  className="group inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold font-grotesk text-navy bg-yellow hover:bg-yellow-hover transition-colors"
                >
                  Apply for a grant
                  <span className="inline-block transition-transform group-hover:translate-y-0.5" aria-hidden>&darr;</span>
                </Link>
                <Link
                  href="/docs"
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium font-grotesk border transition-colors hover:border-white/30"
                  style={{ borderColor: LINE, color: "rgba(230,234,242,0.9)" }}
                >
                  Read the docs
                </Link>
              </div>
            </motion.div>
          </section>

          {/* ── 01 TIERS ─────────────────────────────────────────────────── */}
          <Section index="01" label="Tiers" title="Three ways in. Pick yours.">
            <div className="grid md:grid-cols-3 gap-4">
              {TIERS.map((tier) => (
                <motion.div
                  key={tier.name}
                  {...rise}
                  className="relative border rounded-[6px] p-6 flex flex-col overflow-hidden"
                  style={
                    tier.featured
                      ? { background: "linear-gradient(150deg, rgba(245,197,24,0.08), rgba(245,197,24,0.015))", borderColor: "rgba(245,197,24,0.3)" }
                      : { background: "rgba(255,255,255,0.015)", borderColor: LINE }
                  }
                >
                  <span aria-hidden className="absolute top-0 left-0 right-0 h-px" style={{ background: tier.accent, opacity: 0.55 }} />
                  {tier.featured && (
                    <div className="absolute top-4 right-4 font-mono text-[9px] uppercase tracking-[0.14em] font-bold px-2 py-0.5 rounded-full" style={{ background: YELLOW, color: "#0A0F1C" }}>
                      Most popular
                    </div>
                  )}
                  <div className="mb-4">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] mb-2" style={{ color: tier.accent }}>{tier.name}</div>
                    <div className="font-grotesk text-3xl font-semibold tracking-[-0.02em]" style={{ color: INK }}>{tier.credit}</div>
                    <div className="font-mono text-[11px] mt-1" style={{ color: MUT2 }}>{tier.txs}</div>
                  </div>
                  <p className="text-sm mb-5 leading-relaxed" style={{ color: MUT }}>{tier.desc}</p>
                  <ul className="space-y-2 mt-auto">
                    {tier.perks.map((p) => (
                      <li key={p} className="flex items-center gap-2.5 text-[13px]" style={{ color: "rgba(230,234,242,0.7)" }}>
                        <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: tier.accent }} />
                        {p}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ))}
            </div>
          </Section>

          {/* ── 02 WHY ───────────────────────────────────────────────────── */}
          <Section
            index="02"
            label="Why build on Q402"
            title="Gas abstraction, actually solved."
            accent={CYAN}
            sub="On paper it is a solved problem. In production, most solutions break under edge cases, force users to acquire obscure tokens, or crumble the moment you go multichain. Q402 does not abstract the problem, it removes it."
          >
            <div className="mt-2">
              {WHY.map((w, i) => (
                <motion.div
                  key={w.title}
                  {...rise}
                  className="grid md:grid-cols-[60px_minmax(0,22rem)_1fr] gap-4 md:gap-8 py-8 border-t items-start"
                  style={{ borderColor: HAIR }}
                >
                  <div className="font-grotesk font-semibold leading-none text-3xl md:text-4xl" style={{ color: "rgba(91,200,250,0.3)" }}>
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div className="font-grotesk text-lg md:text-xl font-semibold tracking-[-0.01em] leading-snug" style={{ color: INK }}>
                    {w.title}
                  </div>
                  <p className="text-[14.5px] leading-relaxed md:pt-0.5" style={{ color: MUT }}>
                    {w.body}
                  </p>
                </motion.div>
              ))}
            </div>
          </Section>

          {/* ── 03 APPLY ─────────────────────────────────────────────────── */}
          <Section
            id="apply"
            index="03"
            label="Apply"
            title="Tell us what you are building."
            sub="We review every application within 3 to 5 business days and reach out by email or Telegram."
          >
            <div className="border rounded-[6px] overflow-hidden" style={{ background: "rgba(255,255,255,0.012)", borderColor: LINE }}>
              <AnimatePresence mode="wait">
                {status === "success" ? (
                  <motion.div key="success" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-8 py-16 flex flex-col items-center text-center gap-4">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "rgba(245,197,24,0.08)", border: "1px solid rgba(245,197,24,0.3)" }}>
                      <CheckIcon />
                    </div>
                    <h3 className="font-grotesk text-xl font-semibold" style={{ color: YELLOW }}>Application received</h3>
                    <p className="text-sm max-w-md leading-relaxed" style={{ color: MUT }}>
                      Thanks. We will review your application and reach out within 3 to 5 business days by email or Telegram.
                    </p>
                    <Link href="/" className="mt-2 font-mono text-xs transition-colors hover:text-white" style={{ color: MUT2 }}>&larr; Back to home</Link>
                  </motion.div>
                ) : (
                  <motion.form key="form" onSubmit={handleSubmit} className="px-6 md:px-8 py-8 space-y-6">
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <label className={labelCls}>Project name *</label>
                        <input className={inputCls} placeholder="My gasless app" value={form.projectName} onChange={(e) => set("projectName", e.target.value)} required />
                      </div>
                      <div>
                        <label className={labelCls}>Website / GitHub</label>
                        <input className={inputCls} placeholder="https://..." value={form.website} onChange={(e) => set("website", e.target.value)} />
                      </div>
                    </div>

                    <div className="grid sm:grid-cols-3 gap-4">
                      <div>
                        <label className={labelCls}>Email *</label>
                        <input type="email" className={inputCls} placeholder="you@project.xyz" value={form.email} onChange={(e) => set("email", e.target.value)} required />
                      </div>
                      <div>
                        <label className={labelCls}>Telegram</label>
                        <input className={inputCls} placeholder="@handle" value={form.telegram} onChange={(e) => set("telegram", e.target.value)} />
                      </div>
                      <div>
                        <label className={labelCls}>Twitter / X</label>
                        <input className={inputCls} placeholder="@handle" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} />
                      </div>
                    </div>

                    <div className="grid sm:grid-cols-3 gap-4">
                      <div>
                        <label className={labelCls}>Category *</label>
                        <div className="relative">
                          <select className={selectCls} value={form.category} onChange={(e) => set("category", e.target.value)} required style={{ background: "#0d1422" }}>
                            <option value="">Select...</option>
                            {CATEGORIES.map((c) => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                          </select>
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">&#9662;</span>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Target chain *</label>
                        <div className="relative">
                          <select className={selectCls} value={form.targetChain} onChange={(e) => set("targetChain", e.target.value)} required style={{ background: "#0d1422" }}>
                            <option value="">Select...</option>
                            {CHAINS.map((c) => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                          </select>
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">&#9662;</span>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Credit requested *</label>
                        <div className="relative">
                          <select className={selectCls} value={form.requestedCredit} onChange={(e) => set("requestedCredit", e.target.value)} required style={{ background: "#0d1422" }}>
                            <option value="">Select...</option>
                            {CREDITS.map((c) => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                          </select>
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">&#9662;</span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className={labelCls}>Expected monthly transactions *</label>
                      <div className="relative">
                        <select className={selectCls} value={form.expectedMonthlyTx} onChange={(e) => set("expectedMonthlyTx", e.target.value)} required style={{ background: "#0d1422" }}>
                          <option value="">Select...</option>
                          {TX_RANGES.map((r) => <option key={r} value={r} style={{ background: "#0d1422" }}>{r}</option>)}
                        </select>
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">&#9662;</span>
                      </div>
                    </div>

                    <div>
                      <label className={labelCls}>How will you use gasless payments? *</label>
                      <input className={inputCls} placeholder="e.g. let users mint NFTs without holding BNB" value={form.useCase} onChange={(e) => set("useCase", e.target.value)} required />
                    </div>

                    <div>
                      <label className={labelCls}>Tell us about your project *</label>
                      <textarea className={`${inputCls} resize-none`} rows={4} placeholder="What are you building, who uses it, current traction..." value={form.description} onChange={(e) => set("description", e.target.value)} required />
                    </div>

                    {status === "error" && (
                      <div className="rounded-[4px] px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)", color: "#f87171" }}>{errorMsg}</div>
                    )}

                    <button
                      type="submit"
                      disabled={status === "submitting"}
                      className="w-full py-4 rounded-full font-semibold text-sm font-grotesk bg-yellow text-navy hover:bg-yellow-hover transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                    >
                      {status === "submitting" ? (
                        <>
                          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                          </svg>
                          Submitting...
                        </>
                      ) : (
                        <>
                          Submit application
                          <span aria-hidden>&rarr;</span>
                        </>
                      )}
                    </button>

                    <p className="text-center text-xs" style={{ color: MUT2 }}>
                      Questions? Reach out at{" "}
                      <a href="mailto:business@quackai.ai" className="transition-colors hover:text-white" style={{ color: MUT }}>business@quackai.ai</a>
                    </p>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          </Section>

        </div>
      </main>
      <Footer />
    </>
  );
}
