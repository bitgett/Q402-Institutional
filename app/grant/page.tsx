"use client";

import Link from "next/link";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const TIERS = [
  {
    name: "Seed",
    credit: "$500",
    txs: "Up to 10,000 txs",
    color: "#4AE54A",
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
    color: "#627EEA",
    desc: "Strategic partners & infrastructure builders",
    perks: ["Custom credit pool", "Revenue share model", "Joint press release", "Board advisory access"],
  },
];

const CATEGORIES = ["DeFi", "GameFi", "NFT / Creator", "AI Agent", "DAO / Governance", "Infrastructure", "Social / Community", "Other"];
const CHAINS     = ["BNB Chain", "Ethereum", "Avalanche", "Mantle", "Injective", "X Layer", "Stable", "Multi-chain"];
const CREDITS    = ["$500 (Seed)", "$2,000 (Builder)", "$5,000+", "Custom / discuss"];
const TX_RANGES  = ["< 1,000 / mo", "1,000 – 10,000 / mo", "10,000 – 100,000 / mo", "100,000+ / mo"];

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

  const inputCls = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 outline-none focus:border-yellow/40 focus:bg-white/7 transition-all";
  const selectCls = `${inputCls} cursor-pointer appearance-none`;
  const labelCls = "block text-xs text-white/40 uppercase tracking-widest mb-2 font-medium";

  return (
    <div className="min-h-screen" style={{ background: "linear-gradient(160deg, #05070A 0%, #0B1220 60%, #0D1628 100%)" }}>
      {/* Background glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/3 w-[700px] h-[700px] rounded-full blur-[180px]" style={{ background: "rgba(74,229,74,0.04)" }} />
        <div className="absolute bottom-1/3 right-1/4 w-[500px] h-[500px] rounded-full blur-[150px]" style={{ background: "rgba(245,197,24,0.03)" }} />
      </div>

      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-navy/80 backdrop-blur-md border-b border-white/10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-baseline gap-1.5">
            <span className="text-yellow font-bold text-lg">Q402</span>
            <span className="text-white/30 text-xs hidden sm:block">by Quack AI</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm text-white/50">
            <Link href="/#how-it-works" className="hover:text-white transition-colors">How it works</Link>
            <Link href="/#pricing"      className="hover:text-white transition-colors">Pricing</Link>
            <Link href="/agents"        className="hover:text-green-400 transition-colors text-green-400/70">Agents</Link>
            <Link href="/grant"         className="text-yellow hover:text-yellow-hover transition-colors font-medium">Grant</Link>
            <Link href="/docs"          className="hover:text-white transition-colors">Docs</Link>
          </div>
          <Link href="/payment" className="bg-yellow text-navy text-xs font-bold px-5 py-2.5 rounded-full hover:bg-yellow-hover transition-colors">
            Get API Key →
          </Link>
        </div>
      </nav>

      <main className="relative z-10 max-w-5xl mx-auto px-6 pt-32 pb-24">

        {/* Hero */}
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}
          className="text-center mb-20">
          <div className="inline-flex items-center gap-2 bg-green-400/8 border border-green-400/20 rounded-full px-4 py-1.5 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 text-xs font-semibold tracking-wide uppercase">Q402 Grant Program · 2026</span>
          </div>
          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-5 leading-[1.05]">
            Build the Future of<br />
            <span style={{ background: "linear-gradient(90deg, #F5C518, #4AE54A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Web3 Payments.
            </span>
          </h1>
          <p className="text-white/45 text-lg max-w-2xl mx-auto leading-relaxed">
            We believe gasless UX is the missing layer between crypto and mainstream adoption.
            Q402 backs the builders who share that vision — with relay credits, hands-on support, and long-term partnership.
          </p>
        </motion.div>

        {/* Tiers */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.15 }}
          className="grid md:grid-cols-3 gap-5 mb-20">
          {TIERS.map((tier) => (
            <div key={tier.name}
              className="relative rounded-2xl p-6 border flex flex-col"
              style={{
                background: tier.featured ? "linear-gradient(145deg, #141E0F, #0F1A0A)" : "linear-gradient(145deg, #0F1929, #0B1220)",
                borderColor: tier.featured ? `${tier.color}40` : "rgba(255,255,255,0.08)",
              }}>
              {tier.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow text-navy text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                  Most Popular
                </div>
              )}
              {/* Top accent */}
              <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-2xl" style={{ background: tier.color, opacity: 0.6 }} />

              <div className="mb-4">
                <div className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: tier.color }}>{tier.name}</div>
                <div className="text-3xl font-extrabold mb-0.5">{tier.credit}</div>
                <div className="text-white/35 text-xs">{tier.txs}</div>
              </div>
              <p className="text-white/45 text-sm mb-5 leading-relaxed">{tier.desc}</p>
              <ul className="space-y-2 mt-auto">
                {tier.perks.map(p => (
                  <li key={p} className="flex items-center gap-2 text-xs text-white/60">
                    <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: tier.color }} />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </motion.div>

        {/* Why Q402 */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.25 }}
          className="rounded-2xl border p-8 mb-20" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.07)" }}>
          <h2 className="text-xl font-bold mb-2">Why build with Q402?</h2>
          <p className="text-white/35 text-sm mb-8 leading-relaxed">
            Gas abstraction is a solved problem on paper. In production, most solutions break under edge cases,
            require users to acquire obscure tokens, or crumble the moment you try to go multi-chain.
            Q402 doesn{"'"}t abstract the problem — it eliminates it.
          </p>
          <div className="grid sm:grid-cols-3 gap-8">
            {[
              {
                num: "01",
                title: "Seven chains. One integration. No migration.",
                body: "BNB Chain, Ethereum, Mantle, Avalanche, Injective, X Layer, Stable — not wrapped, not bridged. Native operations on each, through a single unified API. The multi-chain coverage that used to take months now takes an afternoon. And when the next chain matters, you're already there.",
              },
              {
                num: "02",
                title: "Your users forget gas exists. Entirely.",
                body: "EIP-712 off-chain signatures mean no native token prompts, no gas estimation screens, no two-step approve flows, no rejected transactions from empty wallets. Q402 sponsors gas atomically and invisibly — users experience web-like simplicity, trustlessly on-chain.",
              },
              {
                num: "03",
                title: "We track your growth like it's ours.",
                body: "Grant recipients aren't just given credit and sent off. You get co-marketing, joint launch announcements, dedicated Telegram access to the core team, and early access to every new chain we ship. Your transaction volume is the metric we care about.",
              },
            ].map(item => (
              <div key={item.num} className="border-t border-white/8 pt-6">
                <div className="text-xs font-bold text-yellow/40 font-mono mb-4">{item.num}</div>
                <div className="font-semibold text-sm mb-3 leading-snug">{item.title}</div>
                <div className="text-white/40 text-xs leading-relaxed">{item.body}</div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Application Form */}
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.3 }}
          className="rounded-2xl border overflow-hidden" style={{ background: "linear-gradient(145deg, #0F1929, #0B1220)", borderColor: "rgba(245,197,24,0.15)" }}>
          <div className="px-8 py-6 border-b" style={{ borderColor: "rgba(255,255,255,0.07)", background: "rgba(245,197,24,0.03)" }}>
            <h2 className="text-xl font-bold">Apply for a Grant</h2>
            <p className="text-white/40 text-sm mt-1">We review all applications within 3–5 business days.</p>
          </div>

          <AnimatePresence mode="wait">
            {status === "success" ? (
              <motion.div key="success" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                className="px-8 py-16 flex flex-col items-center text-center gap-4">
                <div className="w-16 h-16 rounded-full bg-green-400/10 border border-green-400/30 flex items-center justify-center text-3xl">✓</div>
                <h3 className="text-xl font-bold text-green-400">Application Received</h3>
                <p className="text-white/45 text-sm max-w-md">
                  Thanks! We&apos;ll review your application and reach out within 3–5 business days via email or Telegram.
                </p>
                <Link href="/" className="mt-2 text-xs text-white/30 hover:text-white transition-colors">← Back to home</Link>
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
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Target Chain *</label>
                    <div className="relative">
                      <select className={selectCls} value={form.targetChain} onChange={e => set("targetChain", e.target.value)} required style={{ background: "#0d1422" }}>
                        <option value="">Select...</option>
                        {CHAINS.map(c => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                      </select>
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Credit Requested *</label>
                    <div className="relative">
                      <select className={selectCls} value={form.requestedCredit} onChange={e => set("requestedCredit", e.target.value)} required style={{ background: "#0d1422" }}>
                        <option value="">Select...</option>
                        {CREDITS.map(c => <option key={c} value={c} style={{ background: "#0d1422" }}>{c}</option>)}
                      </select>
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
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
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
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
                  <div className="bg-red-400/8 border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">{errorMsg}</div>
                )}

                <button type="submit" disabled={status === "submitting"}
                  className="w-full py-4 rounded-xl font-bold text-sm bg-yellow text-navy hover:bg-yellow-hover transition-all disabled:opacity-60 flex items-center justify-center gap-2">
                  {status === "submitting" ? (
                    <>
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2"/>
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                      </svg>
                      Submitting...
                    </>
                  ) : "Submit Application →"}
                </button>

                <p className="text-white/20 text-xs text-center">
                  Questions? Reach out at <a href="mailto:business@quackai.ai" className="text-white/40 hover:text-white transition-colors">business@quackai.ai</a>
                </p>
              </motion.form>
            )}
          </AnimatePresence>
        </motion.div>
      </main>
    </div>
  );
}
