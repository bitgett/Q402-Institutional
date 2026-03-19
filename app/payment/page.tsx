"use client";

import { useState } from "react";

const CHAINS = [
  { id: "bnb",    name: "BNB Chain", shortName: "BNB",  color: "#F0B90B", img: "/bnb.png",    rounded: "rounded-full", multiplier: 1.0 },
  { id: "avax",   name: "Avalanche", shortName: "AVAX", color: "#E84142", img: "/avax.png",   rounded: "rounded-full", multiplier: 1.1 },
  { id: "xlayer", name: "X Layer",   shortName: "X",    color: "#CCCCCC", img: "/xlayer.png", rounded: "rounded-sm",   multiplier: 1.0 },
  { id: "eth",    name: "Ethereum",  shortName: "ETH",  color: "#627EEA", img: "/eth.png",    rounded: "rounded-full", multiplier: 1.5 },
];

// Base subscription prices (BNB Chain = 1.0x)
const VOLUMES = [
  { label: "500",       value: 500,     basePrice: 29   },
  { label: "1,000",     value: 1_000,   basePrice: 49   },
  { label: "5,000",     value: 5_000,   basePrice: 89   },
  { label: "10,000",    value: 10_000,  basePrice: 149  },
  { label: "50,000",    value: 50_000,  basePrice: 449  },
  { label: "100,000",   value: 100_000, basePrice: 799  },
  { label: "100K~500K", value: 300_000, basePrice: 1999 },
  { label: "500K+",     value: 500_000, basePrice: 0    }, // Enterprise
];

function calcPrice(chainId: string, volume: number): { price: number; isEnterprise: boolean; perTx: number } {
  const chain = CHAINS.find(c => c.id === chainId)!;
  const vol = VOLUMES.find(v => v.value === volume)!;
  if (vol.basePrice === 0 || volume >= 500_000) return { price: 0, isEnterprise: true, perTx: 0 };
  const price = Math.round(vol.basePrice * chain.multiplier / 10) * 10;
  return { price, isEnterprise: false, perTx: price / vol.value };
}

export default function PaymentPage() {
  const [selectedChain, setSelectedChain] = useState("bnb");
  const [selectedVolume, setSelectedVolume] = useState(10_000);

  const { price, isEnterprise, perTx } = calcPrice(selectedChain, selectedVolume);
  const chain = CHAINS.find(c => c.id === selectedChain)!;

  const emailSubject = isEnterprise
    ? "Q402 Enterprise Inquiry"
    : `Q402 Plan Inquiry — ${chain.name} / ${selectedVolume.toLocaleString()} txs/mo — $${price}/mo`;

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
                      onClick={() => setSelectedChain(c.id)}
                      className={`relative flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                        active
                          ? "border-yellow/50 bg-yellow/6"
                          : "border-white/8 bg-white/[0.02] hover:border-white/20"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.img} alt={c.name} className={`w-7 h-7 flex-shrink-0 ${c.rounded}`} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{c.name}</p>
                        {c.multiplier > 1.0 && (
                          <p className="text-[10px] text-white/25">+{Math.round((c.multiplier - 1) * 100)}%</p>
                        )}
                        {c.multiplier === 1.0 && (
                          <p className="text-[10px] text-white/25">Base rate</p>
                        )}
                      </div>
                      {active && (
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
                {/* Chain + volume summary */}
                <div className="flex items-center gap-3 mb-5 p-3 rounded-xl bg-white/[0.03] border border-white/6">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={chain.img} alt={chain.name} className={`w-8 h-8 flex-shrink-0 ${chain.rounded}`} />
                  <div>
                    <p className="text-sm font-semibold">{chain.name}</p>
                    <p className="text-white/35 text-xs">{selectedVolume >= 500_000 ? "500,000+" : selectedVolume.toLocaleString()} txs/mo</p>
                  </div>
                </div>

                {/* Price */}
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

                {/* CTA */}
                <a
                  href={`mailto:hello@quackai.ai?subject=${encodeURIComponent(emailSubject)}`}
                  className="block w-full bg-yellow text-navy font-bold text-sm text-center py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
                >
                  {isEnterprise ? "Contact Sales →" : "Get in touch →"}
                </a>
                <p className="text-white/20 text-[10px] text-center mt-3">
                  We&apos;ll set up your account and API key manually.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
