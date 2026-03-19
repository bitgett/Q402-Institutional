"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

const CHAINS = [
  { id: "bnb",       name: "BNB Chain",  shortName: "BNB",  color: "#F0B90B", img: "/bnb.png",       rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "avax",      name: "Avalanche",  shortName: "AVAX", color: "#E84142", img: "/avax.png",      rounded: "rounded-full", multiplier: 1.1, comingSoon: false },
  { id: "xlayer",    name: "X Layer",    shortName: "X",    color: "#CCCCCC", img: "/xlayer.png",    rounded: "rounded-sm",   multiplier: 1.0, comingSoon: false },
  { id: "eth",       name: "Ethereum",   shortName: "ETH",  color: "#627EEA", img: "/eth.png",       rounded: "rounded-full", multiplier: 1.5, comingSoon: false },
  { id: "arbitrum",  name: "Arbitrum",   shortName: "ARB",  color: "#28A0F0", img: "/arbitrum.png",  rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
  { id: "scroll",    name: "Scroll",     shortName: "SCR",  color: "#FFDBB0", img: "/scroll.png",    rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
];

const VOLUMES = [
  { label: "500",       value: 500,     basePrice: 29   },
  { label: "1,000",     value: 1_000,   basePrice: 49   },
  { label: "5,000",     value: 5_000,   basePrice: 89   },
  { label: "10,000",    value: 10_000,  basePrice: 149  },
  { label: "50,000",    value: 50_000,  basePrice: 449  },
  { label: "100,000",   value: 100_000, basePrice: 799  },
  { label: "100K~500K", value: 300_000, basePrice: 1999 },
  { label: "500K+",     value: 500_000, basePrice: 0    },
];

const VOLUME_LABELS: Record<number, string> = {
  500: "500 txs/mo", 1_000: "1,000 txs/mo", 5_000: "5,000 txs/mo",
  10_000: "10,000 txs/mo", 50_000: "50,000 txs/mo", 100_000: "100,000 txs/mo",
  300_000: "100K–500K txs/mo", 500_000: "500K+ txs/mo",
};

function calcPrice(chainId: string, volume: number): { price: number; isEnterprise: boolean; perTx: number } {
  const chain = CHAINS.find(c => c.id === chainId)!;
  const vol = VOLUMES.find(v => v.value === volume)!;
  if (vol.basePrice === 0 || volume >= 500_000) return { price: 0, isEnterprise: true, perTx: 0 };
  const price = Math.round(vol.basePrice * chain.multiplier / 10) * 10;
  return { price, isEnterprise: false, perTx: price / vol.value };
}

function InquiryModal({
  onClose,
  prefilledChain,
  prefilledVolume,
}: {
  onClose: () => void;
  prefilledChain: string;
  prefilledVolume: string;
}) {
  const [form, setForm] = useState({
    appName: "", website: "", email: "", telegram: "",
    category: "", targetChain: prefilledChain, expectedVolume: prefilledVolume,
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const data = await res.json();
        setError(data.error ?? "Something went wrong.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls = "w-full bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-yellow/40 transition-colors";
  const selectCls = `${inputCls} appearance-none cursor-pointer`;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 overflow-hidden"
        style={{ background: "#0c1220" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/8 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">Tell us about your project</h2>
            <p className="text-white/40 text-xs mt-1">Helps us configure your API environment and match you with the right setup.</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors ml-4 mt-0.5 flex-shrink-0">✕</button>
        </div>

        {submitted ? (
          <div className="px-6 py-12 text-center">
            <div className="w-12 h-12 rounded-full bg-yellow/10 border border-yellow/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-yellow text-xl">✓</span>
            </div>
            <h3 className="text-lg font-bold mb-2">We&apos;ll be in touch!</h3>
            <p className="text-white/40 text-sm mb-6">Our team will reach out within 24 hours to set up your account.</p>
            <p className="text-white/25 text-xs">Questions? Telegram: <span className="text-yellow">@kwanyeonglee</span></p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Service / App Name <span className="text-yellow">*</span></label>
                <input
                  className={inputCls}
                  placeholder="e.g. MyDeFi App"
                  value={form.appName}
                  onChange={e => set("appName", e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Website / App URL</label>
                <input
                  className={inputCls}
                  placeholder="https://yourapp.com"
                  value={form.website}
                  onChange={e => set("website", e.target.value)}
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Email <span className="text-yellow">*</span></label>
                <input
                  type="email"
                  className={inputCls}
                  placeholder="you@yourapp.com"
                  value={form.email}
                  onChange={e => set("email", e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Telegram (optional)</label>
                <input
                  className={inputCls}
                  placeholder="@yourhandle"
                  value={form.telegram}
                  onChange={e => set("telegram", e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-white/40 mb-1.5">Category <span className="text-yellow">*</span></label>
              <div className="relative">
                <select
                  className={selectCls}
                  style={{ background: "#0d1422", color: form.category ? "#fff" : "rgba(255,255,255,0.25)" }}
                  value={form.category}
                  onChange={e => set("category", e.target.value)}
                  required
                >
                  <option value="" disabled style={{ background: "#0d1422", color: "rgba(255,255,255,0.4)" }}>Select…</option>
                  <option value="DeFi" style={{ background: "#0d1422", color: "#fff" }}>DeFi</option>
                  <option value="NFT / Gaming" style={{ background: "#0d1422", color: "#fff" }}>NFT / Gaming</option>
                  <option value="Payment" style={{ background: "#0d1422", color: "#fff" }}>Payment</option>
                  <option value="Social" style={{ background: "#0d1422", color: "#fff" }}>Social</option>
                  <option value="Other" style={{ background: "#0d1422", color: "#fff" }}>Other</option>
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Target Chain <span className="text-yellow">*</span></label>
                <div className="relative">
                  <select
                    className={selectCls}
                    style={{ background: "#0d1422", color: "#fff" }}
                    value={form.targetChain}
                    onChange={e => set("targetChain", e.target.value)}
                    required
                  >
                    <option value="" disabled style={{ background: "#0d1422", color: "rgba(255,255,255,0.4)" }}>Select…</option>
                    <option value="BNB Chain" style={{ background: "#0d1422", color: "#fff" }}>BNB Chain</option>
                    <option value="Avalanche" style={{ background: "#0d1422", color: "#fff" }}>Avalanche</option>
                    <option value="X Layer" style={{ background: "#0d1422", color: "#fff" }}>X Layer</option>
                    <option value="Ethereum" style={{ background: "#0d1422", color: "#fff" }}>Ethereum</option>
                    <option value="Arbitrum" style={{ background: "#0d1422", color: "#fff" }}>Arbitrum</option>
                    <option value="Scroll" style={{ background: "#0d1422", color: "#fff" }}>Scroll</option>
                    <option value="Multiple" style={{ background: "#0d1422", color: "#fff" }}>Multiple chains</option>
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
                </div>
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Expected Volume <span className="text-yellow">*</span></label>
                <div className="relative">
                  <select
                    className={selectCls}
                    style={{ background: "#0d1422", color: "#fff" }}
                    value={form.expectedVolume}
                    onChange={e => set("expectedVolume", e.target.value)}
                    required
                  >
                    <option value="" disabled style={{ background: "#0d1422", color: "rgba(255,255,255,0.4)" }}>Select…</option>
                    <option value="500 txs/mo" style={{ background: "#0d1422", color: "#fff" }}>500 txs/mo</option>
                    <option value="1,000 txs/mo" style={{ background: "#0d1422", color: "#fff" }}>1,000 txs/mo</option>
                    <option value="5,000 txs/mo" style={{ background: "#0d1422", color: "#fff" }}>5,000 txs/mo</option>
                    <option value="10,000 txs/mo" style={{ background: "#0d1422", color: "#fff" }}>10,000 txs/mo</option>
                    <option value="50,000 txs/mo" style={{ background: "#0d1422", color: "#fff" }}>50,000 txs/mo</option>
                    <option value="100,000 txs/mo" style={{ background: "#0d1422", color: "#fff" }}>100,000 txs/mo</option>
                    <option value="100K–500K txs/mo" style={{ background: "#0d1422", color: "#fff" }}>100K–500K txs/mo</option>
                    <option value="500K+ txs/mo" style={{ background: "#0d1422", color: "#fff" }}>500K+ txs/mo</option>
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-xs">▾</span>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs text-white/40 mb-1.5">Brief Description (optional)</label>
              <textarea
                className={`${inputCls} resize-none`}
                rows={3}
                placeholder="What does your product do? Any specific integration needs?"
                value={form.description}
                onChange={e => set("description", e.target.value)}
              />
            </div>

            {error && <p className="text-red-400 text-xs">{error}</p>}

            <div className="pt-1 pb-2">
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-yellow text-navy font-bold text-sm py-3.5 rounded-xl hover:bg-yellow-hover transition-all disabled:opacity-60"
              >
                {submitting ? "Sending…" : "Submit inquiry →"}
              </button>
              <p className="text-white/20 text-[10px] text-center mt-3">
                Need help? Reach us on Telegram: <span className="text-white/40">@kwanyeonglee</span>
              </p>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
}

export default function PaymentPage() {
  const [selectedChain, setSelectedChain] = useState("bnb");
  const [selectedVolume, setSelectedVolume] = useState(10_000);
  const [showModal, setShowModal] = useState(false);

  const { price, isEnterprise, perTx } = calcPrice(selectedChain, selectedVolume);
  const chain = CHAINS.find(c => c.id === selectedChain)!;

  const prefilledChain = chain.name;
  const prefilledVolume = VOLUME_LABELS[selectedVolume] ?? "";

  return (
    <div className="min-h-screen bg-navy text-white font-poppins">
      {/* Nav */}
      <nav className="border-b border-white/10 px-6 h-16 flex items-center justify-between max-w-6xl mx-auto">
        <a href="/" className="flex items-center gap-2">
          <span className="text-yellow font-bold text-lg">Q402</span>
          <span className="text-white/40 text-sm">by Quack AI</span>
        </a>
        <a href="/" className="text-white/50 text-sm hover:text-white transition-colors">← Back</a>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-yellow/10 border border-yellow/20 rounded-full px-4 py-1.5 mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow" style={{ boxShadow: "0 0 6px #F5C518" }} />
            <span className="text-yellow text-xs font-semibold uppercase tracking-widest">Custom Quote Builder</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">Build your plan</h1>
          <p className="text-white/40 text-sm max-w-md mx-auto">
            Select your chain and monthly volume to get an instant quote.
          </p>
        </div>

        <div className="grid lg:grid-cols-[1fr_360px] gap-8 items-start">

          {/* LEFT */}
          <div className="space-y-6">

            {/* Step 1: Chain */}
            <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
              <div className="flex items-center gap-3 mb-5">
                <span className="w-6 h-6 rounded-full bg-yellow text-navy text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
                <div>
                  <p className="font-semibold text-sm">Which chain do you need?</p>
                  <p className="text-white/30 text-xs mt-0.5">Select the primary chain your product runs on</p>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {CHAINS.map(c => {
                  const active = selectedChain === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => !c.comingSoon && setSelectedChain(c.id)}
                      disabled={c.comingSoon}
                      className={`relative flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                        c.comingSoon
                          ? "border-white/5 bg-white/[0.01] opacity-50 cursor-not-allowed"
                          : active
                          ? "border-yellow/50 bg-yellow/6"
                          : "border-white/8 bg-white/[0.02] hover:border-white/20"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.img} alt={c.name} className={`w-7 h-7 flex-shrink-0 ${c.rounded}`} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{c.name}</p>
                        {c.comingSoon ? (
                          <p className="text-[10px] text-white/30">Integrating…</p>
                        ) : c.multiplier > 1.0 ? (
                          <p className="text-[10px] text-white/25">+{Math.round((c.multiplier - 1) * 100)}%</p>
                        ) : (
                          <p className="text-[10px] text-white/25">Base rate</p>
                        )}
                      </div>
                      {active && !c.comingSoon && (
                        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-yellow" style={{ boxShadow: "0 0 5px #F5C518" }} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Step 2: Volume */}
            <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
              <div className="flex items-center gap-3 mb-5">
                <span className="w-6 h-6 rounded-full bg-yellow text-navy text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
                <div>
                  <p className="font-semibold text-sm">Monthly sponsored transactions</p>
                  <p className="text-white/30 text-xs mt-0.5">How many gasless txs per month?</p>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {VOLUMES.map(v => (
                  <button
                    key={v.value}
                    onClick={() => setSelectedVolume(v.value)}
                    className={`py-3 rounded-xl text-xs font-bold border transition-all ${
                      selectedVolume === v.value
                        ? "bg-yellow text-navy border-yellow"
                        : "bg-white/[0.03] border-white/8 text-white/50 hover:border-white/25 hover:text-white"
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

          </div>

          {/* RIGHT: live quote */}
          <div className="lg:sticky lg:top-8">
            <div className="bg-white/[0.03] border border-white/10 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/8" style={{ background: "rgba(245,197,24,0.04)" }}>
                <p className="text-yellow font-bold text-sm uppercase tracking-widest">Your Quote</p>
              </div>

              <div className="p-6">
                <div className="flex items-center gap-3 mb-5 p-3 rounded-xl bg-white/[0.03] border border-white/6">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={chain.img} alt={chain.name} className={`w-8 h-8 flex-shrink-0 ${chain.rounded}`} />
                  <div>
                    <p className="text-sm font-semibold">{chain.name}</p>
                    <p className="text-white/35 text-xs">{selectedVolume >= 500_000 ? "500,000+" : selectedVolume.toLocaleString()} txs/mo</p>
                  </div>
                </div>

                <div className="border-t border-white/8 pt-5 mb-5">
                  {isEnterprise ? (
                    <div className="text-center py-2">
                      <p className="text-white/40 text-sm mb-1">This volume requires</p>
                      <p className="text-3xl font-extrabold text-yellow">Enterprise</p>
                      <p className="text-white/25 text-xs mt-2">Custom SLA · Private RPC · Dedicated support</p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-white/40 text-sm">Monthly subscription</span>
                        <div className="text-right">
                          <span className="text-3xl font-extrabold text-yellow">${price.toLocaleString()}</span>
                          <span className="text-white/30 text-sm">/mo</span>
                        </div>
                      </div>
                      <p className="text-white/25 text-xs text-right">
                        ${perTx < 0.01 ? perTx.toFixed(4) : perTx.toFixed(3)} per tx
                      </p>
                      {chain.multiplier > 1.0 && (
                        <p className="text-white/20 text-xs text-right mt-0.5">
                          Includes {chain.name} +{Math.round((chain.multiplier - 1) * 100)}% rate
                        </p>
                      )}
                    </>
                  )}
                </div>

                <button
                  onClick={() => setShowModal(true)}
                  className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
                >
                  {isEnterprise ? "Contact Sales →" : "Get in touch →"}
                </button>
                <p className="text-white/20 text-[10px] text-center mt-3">
                  We&apos;ll set up your account and API key manually.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {showModal && typeof window !== "undefined" && (
        <InquiryModal
          onClose={() => setShowModal(false)}
          prefilledChain={prefilledChain}
          prefilledVolume={prefilledVolume}
        />
      )}
    </div>
  );
}
