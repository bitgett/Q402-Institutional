"use client";

import Link from "next/link";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

const TIERS = [
  {
    name: "Seed",
    credit: "$500",
    txs: "Up to 10,000 txs",
    color: "#F5C518",
    desc: "Early-stage projects exploring gasless UX",
    perks: ["$500 relay credit", "Priority support", "Q402 partner badge"],
  },
  {
    name: "Builder",
    credit: "$2,000",
    txs: "Up to 50,000 txs",
    color: "#F5C518",
    desc: "Live products scaling gasless payments",
    perks: ["$2,000 relay credit", "Co-marketing opportunity", "Direct Telegram line", "Custom chain config"],
    featured: true,
  },
  {
    name: "Ecosystem",
    credit: "Custom",
    txs: "Unlimited",
    color: "#5BC8FA",
    desc: "Strategic partners & infrastructure builders",
    perks: ["Custom credit pool", "Revenue share model", "Joint press release", "Board advisory access"],
  },
];

const CATEGORIES = ["DeFi", "GameFi", "NFT / Creator", "AI Agent", "DAO / Governance", "Infrastructure", "Social / Community", "Other"];
const CHAINS     = ["BNB Chain", "Ethereum", "Avalanche", "Mantle", "Injective", "X Layer", "Stable", "Monad", "Scroll", "Arbitrum", "Multi-chain"];
const CREDITS    = ["$500 (Seed)", "$2,000 (Builder)", "$5,000+", "Custom / discuss"];
const TX_RANGES  = ["< 1,000 / mo", "1,000 to 10,000 / mo", "10,000 to 100,000 / mo", "100,000+ / mo"];

// Inline chevron for custom <select> triggers (replaces the textual glyph).
function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/35"
      width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden
    >
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Reveal-on-scroll wrapper. No `once` so sections re-animate as they
// move in and out of view, keeping the page feeling alive.
function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ margin: "0px 0px -10% 0px" }}
      transition={{ duration: 0.6, delay }}
      className={className}
    >
      {children}
    </motion.div>
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

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

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

  const inputCls = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-yellow/40 focus:bg-white/[0.07] transition-all";
  const selectCls = `${inputCls} cursor-pointer appearance-none`;
  const labelCls = "block font-display text-xs text-white/55 uppercase tracking-widest mb-2 font-semibold";

  // Pill kicker + gradient (yellow -> cyan) section title, mirrored from the
  // main landing's Shead so subpages read on-system.
  const titleGradient = { background: "linear-gradient(90deg, #F5C518, #5BC8FA)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" } as const;

  return (
    <div className="min-h-screen" style={{ background: "linear-gradient(160deg, #070C16 0%, #0B1220 60%, #0D1628 100%)" }}>
      {/* Background glows, looping so the page breathes instead of sitting static. */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div
          className="absolute top-1/4 left-1/3 w-[700px] h-[700px] rounded-full blur-[180px]"
          style={{ background: "rgba(245,197,24,0.05)" }}
          animate={{ opacity: [0.5, 0.85, 0.5], scale: [1, 1.08, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-1/3 right-1/4 w-[520px] h-[520px] rounded-full blur-[150px]"
          style={{ background: "rgba(91,200,250,0.06)" }}
          animate={{ opacity: [0.35, 0.6, 0.35], scale: [1, 1.06, 1] }}
          transition={{ duration: 12, repeat: Infinity, ease: "easeInOut", delay: 1.5 }}
        />
      </div>

      <Navbar />

      {/* Top padding clears the 72px fixed bar. */}
      <main className="relative z-10 max-w-5xl mx-auto px-6 pt-32 pb-24">

        {/* Hero */}
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}
          className="text-center mb-20">
          <div className="inline-flex items-center gap-2 bg-yellow/[0.08] border border-yellow/20 rounded-full px-4 py-1.5 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
            <span className="font-display text-yellow text-xs font-semibold tracking-wide uppercase">Q402 Grant Program · 2026</span>
          </div>
          <h1 className="font-display text-5xl md:text-6xl font-extrabold tracking-tight mb-5 leading-[1.05]">
            Build the Future of<br />
            <span style={{ background: "linear-gradient(90deg, #F5C518, #5BC8FA)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
              Web3 Payments.
            </span>
          </h1>
          <p className="text-white/60 text-lg max-w-2xl mx-auto leading-relaxed">
            We believe gasless UX is the missing layer between crypto and mainstream adoption.
            Q402 backs the builders who share that vision, with relay credits, hands-on support, and long-term partnership.
          </p>
        </motion.div>

        {/* Tiers */}
        <Reveal delay={0.05} className="grid md:grid-cols-3 gap-5 mb-20">
          {TIERS.map((tier) => (
            <motion.div key={tier.name}
              whileHover={{ y: -6 }}
              transition={{ type: "spring", stiffness: 300, damping: 24 }}
              className="relative rounded-2xl p-6 border flex flex-col"
              style={{
                background: tier.featured
                  ? "linear-gradient(180deg, rgba(245,197,24,0.10), rgba(245,197,24,0.02))"
                  : "linear-gradient(145deg, #0F1929, #0B1220)",
                borderColor: tier.featured ? "rgba(245,197,24,0.45)" : "rgba(255,255,255,0.08)",
                boxShadow: tier.featured ? "inset 0 1px 0 rgba(255,255,255,0.08), 0 30px 60px -28px rgba(245,197,24,0.42)" : undefined,
              }}>
              {tier.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow text-navy font-display text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                  Most Popular
                </div>
              )}
              {/* Top accent */}
              <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-2xl" style={{ background: tier.color, opacity: 0.6 }} />

              <div className="mb-4">
                <div className="font-display text-xs font-bold uppercase tracking-widest mb-1" style={{ color: tier.color }}>{tier.name}</div>
                <div className="font-mono text-3xl font-extrabold mb-0.5">{tier.credit}</div>
                <div className="text-white/60 text-xs">{tier.txs}</div>
              </div>
              <p className="text-white/60 text-sm mb-5 leading-relaxed">{tier.desc}</p>
              <ul className="space-y-2 mt-auto">
                {tier.perks.map(p => (
                  <li key={p} className="flex items-center gap-2 text-xs text-white/60">
                    <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: tier.color }} />
                    {p}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </Reveal>

        {/* Why Q402 */}
        <Reveal delay={0.05} className="mb-20">
          <div className="rounded-2xl border p-8" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.07)" }}>
            <div className="inline-flex items-center gap-2 font-display text-[11px] font-semibold uppercase tracking-[0.2em] text-white/55 border border-white/10 rounded-full px-3.5 py-1.5 mb-5"
              style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01))" }}>
              <span className="font-mono text-yellow">·</span>
              Why Q402
            </div>
            <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight mb-3" style={titleGradient}>Why build with Q402?</h2>
            <p className="text-white/60 text-sm mb-8 leading-relaxed max-w-3xl">
              Gas abstraction is a solved problem on paper. In production, most solutions break under edge cases,
              require users to acquire obscure tokens, or crumble the moment you try to go multi-chain.
              Q402 doesn{"'"}t abstract the problem. It eliminates it.
            </p>
            <div className="grid sm:grid-cols-3 gap-8">
              {[
                {
                  num: "01",
                  title: "10 chains. One integration. No migration.",
                  body: "BNB Chain, Ethereum, Mantle, Avalanche, Injective, X Layer, Stable, Monad, Scroll, Arbitrum. Not wrapped, not bridged. Native operations on each, through a single unified API. The multi-chain coverage that used to take months now takes an afternoon. And when the next chain matters, you're already there.",
                },
                {
                  num: "02",
                  title: "Your users forget gas exists. Entirely.",
                  body: "EIP-712 off-chain signatures mean no native token prompts, no gas estimation screens, no two-step approve flows, no rejected transactions from empty wallets. Q402 sponsors gas atomically and invisibly. Users experience web-like simplicity, trustlessly on-chain.",
                },
                {
                  num: "03",
                  title: "We track your growth like it's ours.",
                  body: "Grant recipients aren't just given credit and sent off. You get co-marketing, joint launch announcements, dedicated Telegram access to the core team, and early access to every new chain we ship. Your transaction volume is the metric we care about.",
                },
              ].map(item => (
                <div key={item.num} className="border-t border-white/[0.08] pt-6">
                  <div className="font-mono text-xs font-bold text-yellow mb-4">{item.num}</div>
                  <div className="font-display font-semibold text-sm mb-3 leading-snug">{item.title}</div>
                  <div className="text-white/60 text-xs leading-relaxed">{item.body}</div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Application Form */}
        <Reveal delay={0.05}>
          <div className="rounded-2xl border overflow-hidden" style={{ background: "linear-gradient(145deg, #0F1929, #0B1220)", borderColor: "rgba(245,197,24,0.15)" }}>
            <div className="px-8 py-6 border-b" style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(245,197,24,0.03)" }}>
              <div className="inline-flex items-center gap-2 font-display text-[11px] font-semibold uppercase tracking-[0.2em] text-white/55 border border-white/10 rounded-full px-3.5 py-1.5 mb-4"
                style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01))" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                Applications open
              </div>
              <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight" style={titleGradient}>Apply for a Grant</h2>
              <p className="text-white/55 text-sm mt-2">We review all applications within 3 to 5 business days.</p>
            </div>

            <AnimatePresence mode="wait">
              {status === "success" ? (
                <motion.div key="success" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                  className="px-8 py-16 flex flex-col items-center text-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-yellow/10 border border-yellow/30 flex items-center justify-center text-yellow">
                    {/* Seal / check */}
                    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
                      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" strokeOpacity="0.4" />
                      <path d="M10 16.5l4 4 8-8.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <h3 className="font-display text-xl font-bold text-yellow">Application Received</h3>
                  <p className="text-white/60 text-sm max-w-md">
                    Thanks! We&apos;ll review your application and reach out within 3 to 5 business days via email or Telegram.
                  </p>
                  <Link href="/" className="group mt-2 inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white transition-colors">
                    <span className="inline-block transition-transform group-hover:-translate-x-1">&larr;</span>
                    Back to home
                  </Link>
                </motion.div>
              ) : (
                <motion.form key="form" onSubmit={handleSubmit} className="px-8 py-8 space-y-6">
                  {/* Row 1 */}
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Project Name *</label>
                      <input className={inputCls} placeholder="My Gasless App" value={form.projectName} onChange={e => set("projectName", e.target.value)} required />
                    </div>
                    <div>
                      <label className={labelCls}>Website / GitHub</label>
                      <input className={inputCls} placeholder="https://..." value={form.website} onChange={e => set("website", e.target.value)} />
                    </div>
                  </div>

                  {/* Row 2 */}
                  <div className="grid sm:grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>Email *</label>
                      <input type="email" className={inputCls} placeholder="you@project.xyz" value={form.email} onChange={e => set("email", e.target.value)} required />
                    </div>
                    <div>
                      <label className={labelCls}>Telegram</label>
                      <input className={inputCls} placeholder="@handle" value={form.telegram} onChange={e => set("telegram", e.target.value)} />
                    </div>
                    <div>
                      <label className={labelCls}>Twitter / X</label>
                      <input className={inputCls} placeholder="@handle" value={form.twitter} onChange={e => set("twitter", e.target.value)} />
                    </div>
                  </div>

                  {/* Row 3 */}
                  <div className="grid sm:grid-cols-3 gap-4">
                    <div>
                      <label className={labelCls}>Category *</label>
                      <div className="relative">
                        <select className={selectCls} value={form.category} onChange={e => set("category", e.target.value)} required style={{ background: "#0d1422" }}>
                          <option value="">Select...</option>
                          {CATEGORIES.map(c => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                        </select>
                        <Chevron />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Target Chain *</label>
                      <div className="relative">
                        <select className={selectCls} value={form.targetChain} onChange={e => set("targetChain", e.target.value)} required style={{ background: "#0d1422" }}>
                          <option value="">Select...</option>
                          {CHAINS.map(c => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                        </select>
                        <Chevron />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Credit Requested *</label>
                      <div className="relative">
                        <select className={selectCls} value={form.requestedCredit} onChange={e => set("requestedCredit", e.target.value)} required style={{ background: "#0d1422" }}>
                          <option value="">Select...</option>
                          {CREDITS.map(c => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                        </select>
                        <Chevron />
                      </div>
                    </div>
                  </div>

                  {/* Row 4 */}
                  <div>
                    <label className={labelCls}>Expected Monthly Transactions *</label>
                    <div className="relative">
                      <select className={selectCls} value={form.expectedMonthlyTx} onChange={e => set("expectedMonthlyTx", e.target.value)} required style={{ background: "#0d1422" }}>
                        <option value="">Select...</option>
                        {TX_RANGES.map(r => <option key={r} value={r} style={{ background: "#0d1422" }}>{r}</option>)}
                      </select>
                      <Chevron />
                    </div>
                  </div>

                  {/* Row 5 */}
                  <div>
                    <label className={labelCls}>How will you use gasless payments? *</label>
                    <input className={inputCls} placeholder="e.g. Let users mint NFTs without holding BNB" value={form.useCase} onChange={e => set("useCase", e.target.value)} required />
                  </div>

                  {/* Row 6 */}
                  <div>
                    <label className={labelCls}>Tell us about your project *</label>
                    <textarea className={`${inputCls} resize-none`} rows={4} placeholder="What are you building, who uses it, current traction..." value={form.description} onChange={e => set("description", e.target.value)} required />
                  </div>

                  {status === "error" && (
                    <div className="bg-red-400/[0.08] border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">{errorMsg}</div>
                  )}

                  <button type="submit" disabled={status === "submitting"}
                    className="group w-full py-4 rounded-full font-display font-bold text-sm bg-yellow text-navy hover:bg-yellow-hover transition-all disabled:opacity-60 flex items-center justify-center gap-2 shadow-lg shadow-yellow/25">
                    {status === "submitting" ? (
                      <>
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2"/>
                          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                        </svg>
                        Submitting...
                      </>
                    ) : (
                      <>
                        Submit Application
                        <span className="inline-block transition-transform group-hover:translate-x-1">&rarr;</span>
                      </>
                    )}
                  </button>

                  <p className="text-white/40 text-xs text-center">
                    Questions? Reach out at <a href="mailto:business@quackai.ai" className="text-white/55 hover:text-white transition-colors">business@quackai.ai</a>
                  </p>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </Reveal>
      </main>

      <Footer />
    </div>
  );
}
