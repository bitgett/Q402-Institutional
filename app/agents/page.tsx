"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Navbar from "@/app/components/Navbar";
import Footer from "@/app/components/Footer";

// ─── Agent Network Animation ─────────────────────────────────────────────────

const NODES = [
  { id: "hub",     x: 50,  y: 50,  label: "Gas Tank",   color: "#4AE54A", size: 22, isHub: true },
  { id: "a1",      x: 18,  y: 20,  label: "Agent 001",  color: "#4AE54A", size: 11 },
  { id: "a2",      x: 82,  y: 18,  label: "Agent 002",  color: "#4AE54A", size: 11 },
  { id: "a3",      x: 15,  y: 78,  label: "Agent 003",  color: "#4AE54A", size: 11 },
  { id: "a4",      x: 85,  y: 75,  label: "Agent 004",  color: "#4AE54A", size: 11 },
  { id: "a5",      x: 50,  y: 10,  label: "Agent 005",  color: "#4AE54A", size: 11 },
  { id: "a6",      x: 50,  y: 90,  label: "Agent 006",  color: "#4AE54A", size: 11 },
  { id: "avax",    x: 25,  y: 48,  label: "AVAX",       color: "#E84142", size: 13 },
  { id: "bnb",     x: 75,  y: 48,  label: "BNB",        color: "#F0B90B", size: 13 },
  { id: "eth",     x: 50,  y: 68,  label: "ETH",        color: "#627EEA", size: 13 },
];

const EDGES = [
  ["hub","avax"],["hub","bnb"],["hub","eth"],
  ["a1","avax"],["a1","hub"],
  ["a2","bnb"],["a2","hub"],
  ["a3","avax"],["a3","eth"],
  ["a4","bnb"],["a4","eth"],
  ["a5","hub"],["a5","bnb"],
  ["a6","hub"],["a6","eth"],
];

function AgentNetwork() {
  const [pulses, setPulses] = useState<{ id: number; from: string; to: string; progress: number }[]>([]);
  const counter = useRef(0);
  const nodesMap = Object.fromEntries(NODES.map(n => [n.id, n]));

  useEffect(() => {
    const interval = setInterval(() => {
      const edge = EDGES[Math.floor(Math.random() * EDGES.length)];
      const [from, to] = Math.random() > 0.5 ? edge : [edge[1], edge[0]];
      const id = ++counter.current;
      setPulses(p => [...p, { id, from, to, progress: 0 }]);
      setTimeout(() => setPulses(p => p.filter(x => x.id !== id)), 1200);
    }, 320);
    return () => clearInterval(interval);
  }, []);

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
      {/* Edges */}
      {EDGES.map(([a, b]) => {
        const na = nodesMap[a], nb = nodesMap[b];
        return (
          <line
            key={`${a}-${b}`}
            x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
            stroke="rgba(74,229,74,0.12)" strokeWidth="0.3"
          />
        );
      })}

      {/* Pulse dots */}
      {pulses.map(pulse => {
        const from = nodesMap[pulse.from];
        const to   = nodesMap[pulse.to];
        if (!from || !to) return null;
        return (
          <motion.circle
            key={pulse.id}
            r="0.8"
            fill="#4AE54A"
            style={{ filter: "drop-shadow(0 0 2px #4AE54A)" }}
            initial={{ cx: from.x, cy: from.y, opacity: 1 }}
            animate={{ cx: to.x, cy: to.y, opacity: 0 }}
            transition={{ duration: 1.1, ease: "easeInOut" }}
          />
        );
      })}

      {/* Nodes */}
      {NODES.map(n => (
        <g key={n.id}>
          {n.isHub && (
            <motion.circle
              cx={n.x} cy={n.y} r={n.size * 0.7}
              fill="none" stroke="#4AE54A" strokeWidth="0.4" strokeOpacity="0.3"
              animate={{ r: [n.size * 0.7, n.size * 1.1, n.size * 0.7] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          <circle
            cx={n.x} cy={n.y} r={n.size * 0.38}
            fill={n.color}
            fillOpacity={n.isHub ? 0.25 : 0.15}
            stroke={n.color}
            strokeWidth={n.isHub ? 0.5 : 0.3}
            strokeOpacity={0.6}
            style={{ filter: n.isHub ? `drop-shadow(0 0 3px ${n.color})` : undefined }}
          />
          {n.isHub && (
            <text x={n.x} y={n.y + 0.5} textAnchor="middle" dominantBaseline="middle" fill="#4AE54A" fontSize="2.2" fontWeight="bold">
              ⛽
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ─── Live TX Feed ─────────────────────────────────────────────────────────────

const CHAINS_FEED = ["AVAX","BNB","ETH","XLAYER","STABLE"];
const TOKENS_FEED = ["USDC","USDT"];

function randomHex(len: number) {
  return Array.from({length: len}, () => Math.floor(Math.random()*16).toString(16)).join("");
}

function useLiveFeed() {
  const [items, setItems] = useState<{ id: number; chain: string; token: string; amount: string; from: string; to: string; ms: number }[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    const add = () => {
      setItems(prev => [
        {
          id: ++counter.current,
          chain: CHAINS_FEED[Math.floor(Math.random() * CHAINS_FEED.length)],
          token: TOKENS_FEED[Math.floor(Math.random() * TOKENS_FEED.length)],
          amount: (Math.random() * 200 + 1).toFixed(2),
          from: `0x${randomHex(4)}…${randomHex(4)}`,
          to:   `0x${randomHex(4)}…${randomHex(4)}`,
          ms: Math.floor(Math.random() * 300 + 80),
        },
        ...prev.slice(0, 11),
      ]);
    };
    add();
    const t = setInterval(add, 900);
    return () => clearInterval(t);
  }, []);

  return items;
}

// ─── Contact Modal ────────────────────────────────────────────────────────────

function ContactModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ name: "", email: "", telegram: "", agents: "", description: "" });
  const [status, setStatus] = useState<"idle"|"sending"|"done">("idle");

  async function handleSubmit() {
    if (!form.name || !form.email) return;
    setStatus("sending");
    try {
      await fetch("/api/inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appName: form.name,
          email: form.email,
          telegram: form.telegram,
          category: "AI / Agents",
          targetChain: "Multi-chain",
          expectedVolume: form.agents ? `${form.agents} agents` : "Unknown",
          description: `[AGENT PLAN INQUIRY]\n${form.description}`,
        }),
      });
    } catch { /* best-effort */ }
    await new Promise(r => setTimeout(r, 800));
    setStatus("done");
  }

  const overlay = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
  const panel   = { hidden: { opacity: 0, scale: 0.96, y: 16 }, visible: { opacity: 1, scale: 1, y: 0 } };

  return (
    <AnimatePresence>
      <motion.div
        variants={overlay} initial="hidden" animate="visible" exit="hidden"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(16px)" }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          variants={panel} initial="hidden" animate="visible" exit="hidden"
          transition={{ type: "spring", damping: 28, stiffness: 300 }}
          className="w-full max-w-md rounded-2xl overflow-hidden border shadow-2xl"
          style={{ background: "#090E1A", borderColor: "rgba(74,229,74,0.2)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "rgba(74,229,74,0.1)" }}>
            <div>
              <div className="text-green-400 font-bold text-sm uppercase tracking-widest">Agent Plan</div>
              <div className="text-white/30 text-xs mt-0.5">
                {status === "done" ? "Request received" : "Contact Sales"}
              </div>
            </div>
            <button onClick={onClose} className="text-white/30 hover:text-white text-xl leading-none">×</button>
          </div>

          <div className="px-6 py-6">
            {status === "done" ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring" }}
                className="text-center py-6"
              >
                <motion.div
                  initial={{ scale: 0 }} animate={{ scale: 1 }}
                  transition={{ type: "spring", delay: 0.1, damping: 12 }}
                  className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-400/15 border border-green-400/30 flex items-center justify-center text-2xl"
                >
                  ✓
                </motion.div>
                <h2 className="text-lg font-bold mb-2">We&apos;ll be in touch</h2>
                <p className="text-white/40 text-sm mb-6">
                  Our team will reach out within 24 hours to set up your Agent plan and Gas Tank.
                </p>
                <div className="flex items-center gap-2 justify-center text-xs text-white/30">
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#29B6F6">
                    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                  </svg>
                  or reach us at{" "}
                  <a href="https://t.me/kwanyeonglee" target="_blank" rel="noopener noreferrer" className="text-[#29B6F6] hover:underline">@kwanyeonglee</a>
                </div>
              </motion.div>
            ) : (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                <p className="text-white/40 text-sm">Tell us about your agent pipeline and we&apos;ll get you set up.</p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Name / Project <span className="text-green-400">*</span></label>
                    <input
                      type="text" placeholder="e.g. TradingBot Pro"
                      value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-green-400/40 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Email <span className="text-green-400">*</span></label>
                    <input
                      type="email" placeholder="you@company.com"
                      value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-green-400/40 transition-colors"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Telegram</label>
                    <input
                      type="text" placeholder="@yourhandle"
                      value={form.telegram} onChange={e => setForm(f => ({ ...f, telegram: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-green-400/40 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Number of agents</label>
                    <input
                      type="text" placeholder="e.g. 50–200"
                      value={form.agents} onChange={e => setForm(f => ({ ...f, agents: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-green-400/40 transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">What are your agents doing?</label>
                  <textarea
                    rows={3} placeholder="DeFi arb bots, payment processors, yield agents..."
                    value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-green-400/40 transition-colors resize-none"
                  />
                </div>

                <button
                  onClick={handleSubmit}
                  disabled={!form.name || !form.email || status === "sending"}
                  className="w-full bg-green-400 text-navy font-extrabold py-4 rounded-xl hover:bg-green-300 transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
                >
                  {status === "sending" ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/>
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                      </svg>
                      Sending…
                    </span>
                  ) : "Send Inquiry →"}
                </button>

                <div className="flex items-center gap-2 text-xs text-white/25 justify-center">
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" fill="#29B6F6">
                    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                  </svg>
                  or DM us on Telegram:{" "}
                  <a href="https://t.me/kwanyeonglee" target="_blank" rel="noopener noreferrer" className="text-[#29B6F6] hover:underline">@kwanyeonglee</a>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const CHAIN_COLORS: Record<string, string> = {
  AVAX: "#E84142", BNB: "#F0B90B", ETH: "#627EEA", XLAYER: "#CCCCCC", STABLE: "#4AE54A",
};

export default function AgentsPage() {
  const [showContact, setShowContact] = useState(false);
  const feed = useLiveFeed();

  return (
    <div className="min-h-screen text-white overflow-x-hidden" style={{ background: "#060B14" }}>
      <Navbar />

      {showContact && <ContactModal onClose={() => setShowContact(false)} />}

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-20 pb-12 overflow-hidden">

        {/* Animated background grid */}
        <div className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: "linear-gradient(rgba(74,229,74,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(74,229,74,0.04) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }}
        />
        {/* Green radial glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(74,229,74,0.07) 0%, transparent 70%)" }}
        />

        <div className="relative z-10 max-w-6xl mx-auto w-full grid lg:grid-cols-2 gap-12 items-center">
          {/* Left: Text */}
          <motion.div initial={{ opacity: 0, x: -32 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
            <motion.div
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
              className="inline-flex items-center gap-2 text-green-400 text-xs font-bold uppercase tracking-widest border border-green-400/25 bg-green-400/5 px-3 py-1.5 rounded-full mb-6"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              AI / Agents — Live
            </motion.div>

            <h1 className="text-5xl md:text-6xl font-extrabold leading-[1.08] mb-5">
              One Gas Tank.<br />
              <span className="text-green-400" style={{ textShadow: "0 0 40px rgba(74,229,74,0.4)" }}>
                Infinite Agents.
              </span>
            </h1>
            <p className="text-white/50 text-lg leading-relaxed mb-8">
              Stop managing gas wallets across 500 agents on 5 chains.
              Deposit once — every agent relays freely until the tank runs dry.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}
                onClick={() => setShowContact(true)}
                className="bg-green-400 text-navy font-extrabold px-8 py-4 rounded-xl hover:bg-green-300 transition-colors shadow-lg"
                style={{ boxShadow: "0 0 32px rgba(74,229,74,0.25)" }}
              >
                Contact Sales →
              </motion.button>
              <motion.a
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}
                href="/docs"
                className="border border-white/15 text-white font-semibold px-8 py-4 rounded-xl hover:bg-white/5 transition-colors text-center"
              >
                Read the Docs
              </motion.a>
            </div>

            {/* Stats */}
            <div className="flex gap-8 mt-10">
              {[
                { val: "5",   label: "EVM Chains" },
                { val: "∞",   label: "TX Quota" },
                { val: "$0",  label: "Gas per agent" },
              ].map((s, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.1 }}>
                  <div className="text-2xl font-extrabold text-green-400">{s.val}</div>
                  <div className="text-xs text-white/30 mt-0.5">{s.label}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Right: Agent Network + Live Feed */}
          <motion.div initial={{ opacity: 0, x: 32 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, delay: 0.15, ease: "easeOut" }}
            className="flex flex-col gap-4"
          >
            {/* Network graph */}
            <div className="relative rounded-2xl border border-green-400/15 overflow-hidden"
              style={{ background: "rgba(74,229,74,0.02)", aspectRatio: "1/0.75" }}
            >
              <div className="absolute inset-0 p-4">
                <AgentNetwork />
              </div>
              <div className="absolute top-3 left-4 text-[10px] text-green-400/50 font-mono uppercase tracking-widest">
                agent network · live
              </div>
              <div className="absolute bottom-3 right-4 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-[10px] text-green-400/50 font-mono">relaying</span>
              </div>
            </div>

            {/* Live TX feed */}
            <div className="rounded-2xl border border-white/8 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/6">
                <span className="text-[10px] text-white/30 font-mono uppercase tracking-widest">live relay feed</span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-[10px] text-green-400/60 font-mono">live</span>
                </span>
              </div>
              <div className="h-40 overflow-hidden relative">
                <AnimatePresence initial={false}>
                  {feed.slice(0, 7).map(item => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: -24 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-center gap-3 px-4 py-1.5 border-b border-white/4 text-xs"
                    >
                      <span className="font-bold font-mono w-14 flex-shrink-0"
                        style={{ color: CHAIN_COLORS[item.chain] ?? "#fff" }}>
                        {item.chain}
                      </span>
                      <span className="text-white/60 font-mono">{item.from}</span>
                      <span className="text-white/25">→</span>
                      <span className="text-white/60 font-mono">{item.to}</span>
                      <span className="ml-auto text-green-400 font-semibold whitespace-nowrap">
                        {item.amount} {item.token}
                      </span>
                      <span className="text-white/20 w-12 text-right flex-shrink-0">{item.ms}ms</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Problem vs Solution ──────────────────────────────────────────────── */}
      <section className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <h2 className="text-3xl font-bold mb-3">Gas management at scale is broken</h2>
            <p className="text-white/40 text-sm">Running 100 agents across 5 chains = 500 funded wallets to maintain</p>
          </motion.div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Old way */}
            <motion.div
              initial={{ opacity: 0, x: -24 }} whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }} transition={{ duration: 0.5 }}
              className="rounded-2xl border border-red-400/15 p-6"
              style={{ background: "rgba(248,113,113,0.03)" }}
            >
              <div className="text-red-400 text-xs font-bold uppercase tracking-widest mb-4">Traditional approach</div>
              <div className="space-y-3">
                {[
                  "Each agent holds AVAX + BNB + ETH + OKB + USDT0",
                  "Gas spikes drain wallets → agents go silent",
                  "500 wallets to monitor, refill, rotate keys",
                  "Failed TX when gas runs out mid-execution",
                  "Separate gas logic per chain, per agent",
                ].map((t, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-white/50">
                    <span className="text-red-400/60 mt-0.5 flex-shrink-0">✕</span>
                    {t}
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Q402 way */}
            <motion.div
              initial={{ opacity: 0, x: 24 }} whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }} transition={{ duration: 0.5, delay: 0.1 }}
              className="rounded-2xl border border-green-400/20 p-6"
              style={{ background: "rgba(74,229,74,0.03)" }}
            >
              <div className="text-green-400 text-xs font-bold uppercase tracking-widest mb-4">With Q402</div>
              <div className="space-y-3">
                {[
                  "Agents hold zero gas — sign EIP-712 off-chain only",
                  "One Gas Tank per chain funds unlimited agents",
                  "1 API key, 5 deposits — done",
                  "Q402 relayer handles gas estimation & retry",
                  "Same SDK call for all 5 chains",
                ].map((t, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-white/70">
                    <span className="text-green-400 mt-0.5 flex-shrink-0">✓</span>
                    {t}
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── Code Walkthrough ─────────────────────────────────────────────────── */}
      <section className="py-20 px-6">
        <div className="max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.6 }}
            className="text-center mb-10"
          >
            <h2 className="text-3xl font-bold mb-2">Node.js. No browser wallet.</h2>
            <p className="text-white/35 text-sm">Pure viem. Sign EIP-7702 authorizations server-side.</p>
          </motion.div>

          <div className="space-y-3">
            {[
              {
                n: "1", label: "Initialize agent wallet",
                code: `import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const client  = createWalletClient({
  account, chain: avalanche,
  transport: http(process.env.AVAX_RPC),
});`,
              },
              {
                n: "2", label: "Sign EIP-7702 authorization (server-side)",
                code: `// No MetaMask needed — viem signs directly
const auth = await client.experimental_signAuthorization({
  contractAddress: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
  nonce: await client.getTransactionCount({ address: account.address }),
});
// → { chainId, address, nonce, yParity, r, s }`,
              },
              {
                n: "3", label: "Relay — Q402 pays all gas",
                code: `const res = await fetch("https://q402-institutional.vercel.app/api/relay", {
  method: "POST",
  body: JSON.stringify({
    apiKey: process.env.Q402_API_KEY,  // shared across all agents
    chain: "avax", token: "USDC",
    from: account.address, to: recipient,
    amount: "5000000",  // 5 USDC
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: String(randomNonce),
    witnessSig: sig,
    authorization: auth,
  }),
});
const { txHash, gasCostNative } = await res.json();
// gasCostNative charged from your Gas Tank — agents pay $0`,
              },
            ].map((step, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ duration: 0.5, delay: i * 0.1 }}
                className="rounded-2xl border border-white/8 overflow-hidden"
              >
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/6"
                  style={{ background: "rgba(74,229,74,0.03)" }}>
                  <span className="w-6 h-6 rounded-full bg-green-400/15 text-green-400 text-xs font-bold flex items-center justify-center flex-shrink-0">
                    {step.n}
                  </span>
                  <span className="text-xs text-white/50 font-medium">{step.label}</span>
                  <span className="ml-auto text-[10px] text-white/20 font-mono">javascript</span>
                </div>
                <pre className="p-4 text-xs text-white/65 overflow-x-auto leading-relaxed font-mono"
                  style={{ background: "rgba(0,0,0,0.3)" }}>
                  <code>{step.code}</code>
                </pre>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing CTA ──────────────────────────────────────────────────────── */}
      <section className="py-20 px-6">
        <div className="max-w-xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }} transition={{ duration: 0.6 }}
            className="rounded-2xl border border-green-400/20 p-10 text-center relative overflow-hidden"
            style={{ background: "linear-gradient(135deg, rgba(74,229,74,0.07) 0%, rgba(6,11,20,0.95) 100%)" }}
          >
            <div className="absolute inset-0 pointer-events-none"
              style={{ background: "radial-gradient(circle at 50% 0%, rgba(74,229,74,0.12) 0%, transparent 60%)" }}
            />
            <div className="relative">
              <div className="text-green-400 text-xs font-bold uppercase tracking-widest mb-4">Agent Plan</div>
              <div className="flex items-baseline justify-center gap-1 mb-1">
                <span className="text-white/40 text-lg">from</span>
                <span className="text-6xl font-extrabold">$500</span>
                <span className="text-white/40 text-lg">/30-day access</span>
              </div>
              <p className="text-white/35 text-sm mb-8">
                + Gas Tank deposits (consumed at actual on-chain cost, no markup)
              </p>
              <ul className="text-left space-y-2.5 mb-8 max-w-xs mx-auto">
                {[
                  "Unlimited TX quota",
                  "All 5 EVM chains",
                  "Gas Tank pre-pay model",
                  "Webhooks + real-time events",
                  "Sandbox mode for testing",
                  "Node.js SDK support",
                  "Priority support",
                ].map((f, i) => (
                  <li key={i} className="flex items-center gap-2.5 text-sm text-white/70">
                    <span className="text-green-400 flex-shrink-0">✓</span>{f}
                  </li>
                ))}
              </ul>
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}
                onClick={() => setShowContact(true)}
                className="w-full bg-green-400 text-navy font-extrabold py-4 rounded-xl hover:bg-green-300 transition-colors"
                style={{ boxShadow: "0 0 32px rgba(74,229,74,0.2)" }}
              >
                Contact Sales →
              </motion.button>
              <p className="text-white/20 text-xs mt-4">Custom pricing for pipelines with 1,000+ agents</p>
            </div>
          </motion.div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
