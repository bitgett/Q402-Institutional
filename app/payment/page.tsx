"use client";

import { useState, useEffect, useRef } from "react";
import { useWallet } from "../context/WalletContext";
import { setPaid } from "../lib/access";
import { useRouter } from "next/navigation";

const COUNTDOWN_SECONDS = 180; // 3 minutes

const WALLET_ADDRESS = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const CHAINS = [
  { id: "bnb",      name: "BNB Chain",  shortName: "BNB",  color: "#F0B90B", img: "/bnb.png",      rounded: "rounded-full", multiplier: 1.0 },
  { id: "avax",     name: "Avalanche",  shortName: "AVAX", color: "#E84142", img: "/avax.png",     rounded: "rounded-full", multiplier: 1.1 },
  { id: "xlayer",   name: "X Layer",    shortName: "X",    color: "#CCCCCC", img: "/xlayer.png",   rounded: "rounded-sm",   multiplier: 1.0 },
  { id: "arbitrum", name: "Arbitrum",   shortName: "ARB",  color: "#12AAFF", img: "/arbitrum.png", rounded: "rounded-md",   multiplier: 1.1 },
  { id: "scroll",   name: "Scroll",     shortName: "SCR",  color: "#EEB431", img: "/scroll.png",   rounded: "rounded-full", multiplier: 1.1 },
  { id: "eth",      name: "Ethereum",   shortName: "ETH",  color: "#627EEA", img: "/eth.png",      rounded: "rounded-full", multiplier: 1.5 },
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

const TOKENS = [
  { id: "eth-usdc",  symbol: "ETH / USDC", network: "Ethereum (ERC-20)",         note: "Recommended" },
  { id: "bnb-usdc",  symbol: "USDC",       network: "BNB Chain (BEP-20)",         note: "" },
  { id: "bnb-usdt",  symbol: "USDT",       network: "BNB Chain (BEP-20)",         note: "" },
  { id: "avax-usdc", symbol: "USDC",       network: "Avalanche C-Chain (ERC-20)", note: "" },
];

function calcPrice(chainId: string, volume: number): { price: number; isEnterprise: boolean; perTx: number } {
  const chain = CHAINS.find(c => c.id === chainId)!;
  const vol = VOLUMES.find(v => v.value === volume)!;
  if (vol.basePrice === 0 || volume >= 500_000) return { price: 0, isEnterprise: true, perTx: 0 };
  const price = Math.round(vol.basePrice * chain.multiplier / 10) * 10;
  return { price, isEnterprise: false, perTx: price / vol.value };
}

export default function PaymentPage() {
  const { address, connect } = useWallet();
  const router = useRouter();

  const [selectedChain, setSelectedChain] = useState("bnb");
  const [selectedVolume, setSelectedVolume] = useState(10_000);
  const [selectedToken, setSelectedToken] = useState("eth-usdc");
  const [copied, setCopied] = useState(false);

  // Activation flow state
  const [sentClicked, setSentClicked] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sentClicked) return;
    timerRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, [sentClicked]);

  async function handleActivate() {
    if (!address) return;
    setActivating(true);
    setActivateError(null);
    try {
      const res = await fetch("/api/payment/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await res.json();
      if (data.apiKey) {
        setPaid(address);
        router.push("/dashboard");
      } else {
        setActivateError(data.error ?? "Payment not found on-chain yet. Wait a bit longer.");
      }
    } catch {
      setActivateError("Network error. Please try again.");
    } finally {
      setActivating(false);
    }
  }

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;
  const progress = ((COUNTDOWN_SECONDS - countdown) / COUNTDOWN_SECONDS) * 100;

  function copy() {
    navigator.clipboard.writeText(WALLET_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const { price, isEnterprise, perTx } = calcPrice(selectedChain, selectedVolume);
  const chain = CHAINS.find(c => c.id === selectedChain)!;

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

            {/* Step 3: Payment token — only when not enterprise */}
            {!isEnterprise && (
              <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-5">
                  <span className="w-6 h-6 rounded-full bg-yellow text-navy text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
                  <div>
                    <p className="font-semibold text-sm">Select payment token</p>
                    <p className="text-white/30 text-xs mt-0.5">All sent to the same address — any EVM chain</p>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-2 mb-6">
                  {TOKENS.map(t => {
                    const active = selectedToken === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedToken(t.id)}
                        className={`flex items-center justify-between rounded-xl px-4 py-3 border text-left transition-all ${
                          active
                            ? "border-yellow/40 bg-yellow/5"
                            : t.note === "Recommended"
                            ? "border-yellow/15 bg-yellow/[0.02] hover:border-yellow/30"
                            : "border-white/8 bg-navy hover:border-white/20"
                        }`}
                      >
                        <div>
                          <span className="font-semibold text-xs">{t.symbol}</span>
                          <p className="text-white/35 text-[10px] mt-0.5">{t.network}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {t.note && (
                            <span className="text-yellow text-[10px] font-semibold bg-yellow/10 border border-yellow/20 px-2 py-0.5 rounded-full">
                              {t.note}
                            </span>
                          )}
                          <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${active ? "border-yellow bg-yellow" : "border-white/20"}`} />
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Wallet address */}
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest font-semibold mb-2">Send to this address</p>
                  <div className="bg-navy border border-white/10 rounded-xl p-4 flex items-center justify-between gap-4">
                    <span className="font-mono text-xs text-white/70 break-all">{WALLET_ADDRESS}</span>
                    <button
                      onClick={copy}
                      className={`flex-shrink-0 text-xs font-semibold px-4 py-2 rounded-lg transition-all ${
                        copied
                          ? "bg-green-500/20 text-green-400 border border-green-500/30"
                          : "bg-yellow/10 text-yellow border border-yellow/20 hover:bg-yellow/20"
                      }`}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <p className="text-white/20 text-[10px] mt-2">
                    Same address works on Ethereum, BNB Chain, Avalanche — any EVM chain.
                  </p>
                </div>

              </div>
            )}
            {/* Step 4: Activate — only shown when not enterprise */}
            {!isEnterprise && (
              <div className="bg-white/[0.03] border border-white/8 rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-5">
                  <span className="w-6 h-6 rounded-full bg-yellow text-navy text-xs font-bold flex items-center justify-center flex-shrink-0">4</span>
                  <div>
                    <p className="font-semibold text-sm">Activate your account</p>
                    <p className="text-white/30 text-xs mt-0.5">
                      After sending, connect your wallet and click activate — we&apos;ll verify on-chain automatically.
                    </p>
                  </div>
                </div>

                {/* Wallet not connected */}
                {!address && (
                  <button
                    onClick={connect}
                    className="w-full flex items-center justify-center gap-2 border border-white/15 text-white/60 text-sm font-semibold py-3.5 rounded-xl hover:border-yellow/30 hover:text-white transition-all"
                    style={{ background: "rgba(255,255,255,0.03)" }}
                  >
                    Connect wallet to continue
                  </button>
                )}

                {/* Wallet connected — not yet triggered */}
                {address && !sentClicked && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 px-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
                      <p className="text-green-400 text-xs font-medium">
                        {address.slice(0, 6)}…{address.slice(-4)} connected
                      </p>
                    </div>
                    <button
                      onClick={() => setSentClicked(true)}
                      className="w-full bg-white/5 border border-white/15 text-white/80 text-sm font-semibold py-3.5 rounded-xl hover:border-yellow/30 hover:text-white transition-all"
                    >
                      Transfer complete — wait for confirmation
                    </button>
                  </div>
                )}

                {/* Countdown */}
                {address && sentClicked && countdown > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 px-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
                      <p className="text-green-400 text-xs font-medium">
                        {address.slice(0, 6)}…{address.slice(-4)} connected
                      </p>
                    </div>
                    <div className="bg-navy border border-white/8 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-white/50">Waiting for block confirmation…</p>
                        <span className="font-mono text-sm font-bold text-yellow tabular-nums">
                          {minutes}:{seconds.toString().padStart(2, "0")}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-white/8 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-yellow rounded-full transition-all duration-1000"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="text-white/25 text-[10px] mt-2.5">
                        Activate unlocks in {minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`}
                      </p>
                    </div>
                  </div>
                )}

                {/* Activate button */}
                {address && sentClicked && countdown === 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 px-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
                      <p className="text-green-400 text-xs font-medium">
                        {address.slice(0, 6)}…{address.slice(-4)} connected
                      </p>
                    </div>
                    <button
                      onClick={handleActivate}
                      disabled={activating}
                      className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02] shadow-lg shadow-yellow/20 disabled:opacity-70"
                    >
                      {activating ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                          </svg>
                          Verifying on-chain…
                        </span>
                      ) : "Activate my account →"}
                    </button>
                    {activateError && (
                      <p className="text-red-400 text-xs text-center px-1">{activateError}</p>
                    )}
                    {activateError && (
                      <button
                        onClick={handleActivate}
                        disabled={activating}
                        className="w-full text-white/30 text-xs py-1.5 hover:text-white/60 transition-colors"
                      >
                        Try again
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

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
                {isEnterprise ? (
                  <a
                    href="mailto:hello@quackai.ai?subject=Q402 Enterprise Inquiry"
                    className="block w-full bg-yellow text-navy font-bold text-sm text-center py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
                  >
                    Contact Sales →
                  </a>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-center gap-2 bg-white/[0.03] border border-white/8 rounded-xl px-4 py-3">
                      <p className="text-xs text-white/40 text-center">
                        Send <span className="text-yellow font-semibold">${price.toLocaleString()} USDC</span> via Step 3, then activate in Step 4
                      </p>
                    </div>
                    <a
                      href="mailto:hello@quackai.ai?subject=Q402 Custom Plan"
                      className="block w-full text-center border border-white/8 text-white/35 text-xs py-3 rounded-xl hover:border-white/20 hover:text-white/60 transition-all"
                    >
                      Need a custom arrangement?
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
