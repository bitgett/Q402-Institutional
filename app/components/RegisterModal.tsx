"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "../context/WalletContext";
import { useRouter } from "next/navigation";
import { setPaid } from "../lib/access";

const PLANS = [
  { name: "Growth", price: 300,  quota: "50,000 txs/mo",  highlight: false },
  { name: "Scale",  price: 1000, quota: "300,000 txs/mo", highlight: true  },
];

const CHAIN_OPTIONS = ["BNB Chain", "Ethereum", "Avalanche", "X Layer", "Arbitrum", "Multi-chain"];
const CATEGORY_OPTIONS = ["DeFi / DEX", "NFT / Gaming", "Payment App", "Wallet", "DAO / Governance", "Other"];
const VOLUME_OPTIONS = ["< 1,000 txs/mo", "1K – 10K txs/mo", "10K – 50K txs/mo", "50K – 300K txs/mo", "300K+ txs/mo"];

interface Props { onClose: () => void; }

export default function RegisterModal({ onClose }: Props) {
  const { address, connect } = useWallet();
  const router = useRouter();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(2);
  const [form, setForm] = useState({
    service: "",
    email: "",
    telegram: "",
    website: "",
    category: "",
    chain: "",
    volume: "",
    description: "",
  });
  const [selectedPlan, setSelectedPlan] = useState("Scale");
  const [paying, setPaying] = useState(false);
  const [, setPaidState] = useState(false);
  const [realApiKey, setRealApiKey] = useState<string | null>(null);

  async function handleConnect() {
    await connect();
    setStep(2);
  }

  async function handlePay() {
    setPaying(true);
    await new Promise(r => setTimeout(r, 2800));
    setPaying(false);
    setPaidState(true);
    if (address) setPaid(address);
    // Fetch real API key from server
    try {
      const res = await fetch("/api/payment/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await res.json();
      if (data.apiKey) setRealApiKey(data.apiKey);
    } catch { /* show fallback key from dashboard */ }
    await new Promise(r => setTimeout(r, 600));
    setStep(4);
  }

  function handleDone() {
    onClose();
    router.push("/dashboard");
  }

  const step2Valid = form.service && form.email;

  const overlay = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
  const panel = { hidden: { opacity: 0, scale: 0.96, y: 16 }, visible: { opacity: 1, scale: 1, y: 0 } };

  return (
    <AnimatePresence>
      <motion.div
        variants={overlay} initial="hidden" animate="visible" exit="hidden"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(12px)" }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          variants={panel} initial="hidden" animate="visible" exit="hidden"
          transition={{ type: "spring", damping: 28, stiffness: 300 }}
          className="w-full max-w-xl rounded-2xl overflow-hidden border shadow-2xl shadow-black"
          style={{ background: "#090E1A", borderColor: "rgba(245,197,24,0.12)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-7 py-4 border-b" style={{ borderColor: "rgba(255,255,255,0.07)" }}>
            <div>
              <div className="text-yellow font-bold text-base">Q402</div>
              <div className="text-white/30 text-xs">
                {step === 1 && "Connect your wallet"}
                {step === 2 && "Project details"}
                {step === 3 && "Choose a plan"}
                {step === 4 && "You're live 🎉"}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                {[1,2,3,4].map(s => (
                  <div key={s} className="w-1.5 h-1.5 rounded-full transition-all" style={{ background: s <= step ? "#F5C518" : "rgba(255,255,255,0.15)" }} />
                ))}
              </div>
              <button onClick={onClose} className="text-white/30 hover:text-white text-lg leading-none">×</button>
            </div>
          </div>

          {/* Body */}
          <div className="px-7 py-6">

            {/* STEP 1: Connect wallet */}
            {step === 1 && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <div className="text-center mb-6">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-yellow/10 border border-yellow/20 flex items-center justify-center text-2xl">⬡</div>
                  <h2 className="text-lg font-bold mb-2">Connect your wallet</h2>
                  <p className="text-white/40 text-sm">No password needed. Sign in with your Web3 wallet.</p>
                </div>
                <button
                  onClick={handleConnect}
                  className="w-full bg-yellow text-navy font-bold py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02] shadow-lg shadow-yellow/20"
                >
                  Connect Wallet (MetaMask)
                </button>
                <p className="text-center text-white/25 text-xs mt-3">WalletConnect support coming soon</p>
              </motion.div>
            )}

            {/* STEP 2: Profile — expanded */}
            {step === 2 && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <h2 className="text-lg font-bold mb-0.5">Tell us about your project</h2>
                <p className="text-white/35 text-sm mb-5">Helps us configure your API environment and match you with the right setup.</p>

                {/* Row 1 */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">
                      Service / App Name <span className="text-yellow">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. MyDeFi App"
                      value={form.service}
                      onChange={e => setForm(f => ({ ...f, service: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-yellow/40 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">
                      Website / App URL
                    </label>
                    <input
                      type="url"
                      placeholder="https://yourapp.com"
                      value={form.website}
                      onChange={e => setForm(f => ({ ...f, website: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-yellow/40 transition-colors"
                    />
                  </div>
                </div>

                {/* Row 2 */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">
                      Email <span className="text-yellow">*</span>
                    </label>
                    <input
                      type="email"
                      placeholder="you@yourapp.com"
                      value={form.email}
                      onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-yellow/40 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">
                      Telegram (optional)
                    </label>
                    <input
                      type="text"
                      placeholder="@yourhandle"
                      value={form.telegram}
                      onChange={e => setForm(f => ({ ...f, telegram: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-yellow/40 transition-colors"
                    />
                  </div>
                </div>

                {/* Row 3 — selects */}
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Category</label>
                    <select
                      value={form.category}
                      onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-yellow/40 transition-colors appearance-none"
                      style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                      <option value="" className="bg-[#090E1A]">Select…</option>
                      {CATEGORY_OPTIONS.map(o => <option key={o} value={o} className="bg-[#090E1A]">{o}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Target Chain</label>
                    <select
                      value={form.chain}
                      onChange={e => setForm(f => ({ ...f, chain: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-yellow/40 transition-colors appearance-none"
                      style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                      <option value="" className="bg-[#090E1A]">Select…</option>
                      {CHAIN_OPTIONS.map(o => <option key={o} value={o} className="bg-[#090E1A]">{o}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Expected Volume</label>
                    <select
                      value={form.volume}
                      onChange={e => setForm(f => ({ ...f, volume: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-yellow/40 transition-colors appearance-none"
                      style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                      <option value="" className="bg-[#090E1A]">Select…</option>
                      {VOLUME_OPTIONS.map(o => <option key={o} value={o} className="bg-[#090E1A]">{o}</option>)}
                    </select>
                  </div>
                </div>

                {/* Description */}
                <div className="mb-5">
                  <label className="text-[11px] text-white/40 uppercase tracking-widest block mb-1.5">Brief Description (optional)</label>
                  <textarea
                    rows={2}
                    placeholder="What does your product do? Any specific integration needs?"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-yellow/40 transition-colors resize-none"
                  />
                </div>

                {/* Direct contact callout */}
                <div className="flex items-center gap-3 bg-[#0C1628] border border-yellow/10 rounded-xl px-4 py-3 mb-5">
                  <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center" style={{ background: "rgba(41,182,246,0.12)", border: "1px solid rgba(41,182,246,0.2)" }}>
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#29B6F6">
                      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-white/70">Need help or have questions?</div>
                    <div className="text-xs text-white/35 mt-0.5">
                      Reach us directly on Telegram →{" "}
                      <a href="https://t.me/kwanyeonglee" target="_blank" rel="noopener noreferrer" className="text-[#29B6F6] font-semibold hover:underline">
                        @kwanyeonglee
                      </a>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setStep(3)}
                  disabled={!step2Valid}
                  className="w-full bg-yellow text-navy font-bold py-3.5 rounded-xl hover:bg-yellow-hover transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue →
                </button>
              </motion.div>
            )}

            {/* STEP 3: Plan + Gasless Pay */}
            {step === 3 && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                <h2 className="text-lg font-bold mb-1">Choose your plan</h2>
                <div className="flex items-center gap-2 mb-5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 5px #4ade80" }} />
                  <p className="text-white/40 text-sm">Payment is <span className="text-green-400 font-medium">gasless</span> — no AVAX, BNB, or ETH needed</p>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-5">
                  {PLANS.map(plan => (
                    <button
                      key={plan.name}
                      onClick={() => setSelectedPlan(plan.name)}
                      className={`relative rounded-xl p-4 text-left border transition-all ${selectedPlan === plan.name ? "border-yellow/50 bg-yellow/8" : "border-white/8 bg-white/3 hover:border-white/20"}`}
                    >
                      {plan.highlight && <div className="text-[10px] text-yellow font-bold uppercase tracking-widest mb-2">Popular</div>}
                      <div className="font-bold">{plan.name}</div>
                      <div className="text-xl font-extrabold text-yellow">${plan.price}<span className="text-xs text-white/30 font-normal">/mo</span></div>
                      <div className="text-xs text-white/40 mt-1">{plan.quota}</div>
                    </button>
                  ))}
                </div>

                <div className="bg-white/3 border border-white/8 rounded-xl p-4 mb-5 text-xs text-white/40 leading-relaxed">
                  <span className="text-yellow font-semibold">Zero-gas payment.</span> Your first subscription fee is paid via Q402 itself — proving our own technology works. No gas required.
                </div>

                <button
                  onClick={handlePay}
                  disabled={paying}
                  className="w-full bg-yellow text-navy font-bold py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02] shadow-lg shadow-yellow/20 disabled:opacity-70"
                >
                  {paying ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                      Processing USDC (gasless)…
                    </span>
                  ) : `Pay $${PLANS.find(p => p.name === selectedPlan)?.price} USDC — Gasless →`}
                </button>
              </motion.div>
            )}

            {/* STEP 4: Success + API Key */}
            {step === 4 && (
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring" }}>
                <div className="text-center mb-6">
                  <motion.div
                    initial={{ scale: 0 }} animate={{ scale: 1 }}
                    transition={{ type: "spring", delay: 0.1, damping: 12 }}
                    className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-400/15 border border-green-400/30 flex items-center justify-center text-2xl"
                  >
                    ✓
                  </motion.div>
                  <h2 className="text-xl font-bold mb-1">You&apos;re live on Q402</h2>
                  <p className="text-white/40 text-sm">{selectedPlan} plan activated for <span className="text-white">{form.service}</span></p>
                </div>

                <div className="bg-[#060C14] border border-white/8 rounded-xl p-4 mb-5">
                  <div className="text-xs text-white/30 uppercase tracking-widest mb-2">Your API Key</div>
                  <div className="font-mono text-sm text-green-400 break-all">
                    {realApiKey ?? "Check your dashboard for your API key"}
                  </div>
                </div>

                <div className="flex items-center gap-2 bg-yellow/5 border border-yellow/15 rounded-xl px-4 py-3 mb-5">
                  <span className="text-yellow text-sm">⚡</span>
                  <p className="text-xs text-white/50">
                    Gas you paid: <span className="text-yellow font-bold">$0.000000</span>. Payment processed via Q402 itself.
                  </p>
                </div>

                <button
                  onClick={handleDone}
                  className="w-full bg-yellow text-navy font-bold py-4 rounded-xl hover:bg-yellow-hover transition-all"
                >
                  Open Dashboard →
                </button>
              </motion.div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
