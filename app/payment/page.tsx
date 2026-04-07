"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/app/context/WalletContext";
import { createPortal } from "react-dom";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Q402 subscription fee receiver — all plan payments go here */
const PAYMENT_ADDRESS = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const CHAINS = [
  { id: "bnb",     name: "BNB Chain", shortName: "BNB",    color: "#F0B90B", img: "/bnb.png",      rounded: "rounded-full", multiplier: 1.0, comingSoon: false,
    tokens: ["USDC", "USDT"] },
  { id: "avax",    name: "Avalanche", shortName: "AVAX",   color: "#E84142", img: "/avax.png",     rounded: "rounded-full", multiplier: 1.1, comingSoon: false,
    tokens: ["USDC", "USDT"] },
  { id: "xlayer",  name: "X Layer",   shortName: "X",      color: "#CCCCCC", img: "/xlayer.png",   rounded: "rounded-sm",   multiplier: 1.0, comingSoon: false,
    tokens: ["USDC", "USDT"] },
  { id: "eth",     name: "Ethereum",  shortName: "ETH",    color: "#627EEA", img: "/eth.png",      rounded: "rounded-full", multiplier: 1.5, comingSoon: false,
    tokens: ["USDC", "USDT"] },
  { id: "stable",  name: "Stable",    shortName: "STABLE", color: "#4AE54A", img: "/stable.jpg",   rounded: "rounded-full", multiplier: 1.0, comingSoon: false,
    tokens: ["USDT0"] },
  { id: "arbitrum",name: "Arbitrum",  shortName: "ARB",    color: "#28A0F0", img: "/arbitrum.png", rounded: "rounded-full", multiplier: 1.1, comingSoon: true,
    tokens: [] },
  { id: "scroll",  name: "Scroll",    shortName: "SCR",    color: "#FFDBB0", img: "/scroll.png",   rounded: "rounded-full", multiplier: 1.1, comingSoon: true,
    tokens: [] },
] as const;

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function calcPrice(chainId: string, volume: number) {
  const chain = CHAINS.find(c => c.id === chainId)!;
  const vol   = VOLUMES.find(v => v.value === volume)!;
  if (vol.basePrice === 0 || volume >= 500_000) return { price: 0, isEnterprise: true, perTx: 0 };
  const price = Math.round(vol.basePrice * chain.multiplier / 10) * 10;
  return { price, isEnterprise: false, perTx: price / vol.value };
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WalletConnect modal (reused from WalletButton pattern)
// ─────────────────────────────────────────────────────────────────────────────

function WalletModal({ onClose }: { onClose: () => void }) {
  const { connectWith } = useWallet();
  const [loading, setLoading] = useState<string | null>(null);

  async function handleConnect(type: "metamask" | "okx") {
    setLoading(type);
    await connectWith(type);
    setLoading(null);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(10px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 overflow-hidden"
        style={{ background: "#0c1220" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 border-b border-white/8 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold">Connect Wallet</h2>
            <p className="text-white/35 text-xs mt-0.5">Your connected wallet receives the API key.</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">✕</button>
        </div>
        <div className="p-4 space-y-2">
          {(["metamask", "okx"] as const).map(type => (
            <button
              key={type}
              onClick={() => handleConnect(type)}
              disabled={!!loading}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-white/8 hover:border-yellow/30 hover:bg-yellow/5 transition-all disabled:opacity-50"
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${type === "metamask" ? "bg-[#F6851B]" : "bg-black"}`}>
                {type === "metamask" ? (
                  <svg viewBox="0 0 35 33" className="w-7 h-7 p-0.5" fill="none">
                    <path d="M32.958 1L19.862 10.765l2.388-5.637L32.958 1z" fill="#E17726" stroke="#E17726" strokeWidth=".25"/>
                    <path d="M2.042 1l12.986 9.848-2.27-5.72L2.042 1z" fill="#E27625" stroke="#E27625" strokeWidth=".25"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                    <rect x="2" y="2" width="8" height="8" rx="1"/>
                    <rect x="14" y="2" width="8" height="8" rx="1"/>
                    <rect x="2" y="14" width="8" height="8" rx="1"/>
                    <rect x="14" y="14" width="8" height="8" rx="1"/>
                  </svg>
                )}
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold">{type === "metamask" ? "MetaMask" : "OKX Wallet"}</p>
                <p className="text-white/35 text-xs">{type === "metamask" ? "Browser extension wallet" : "Multi-chain Web3 wallet"}</p>
              </div>
              {loading === type && (
                <svg className="animate-spin w-4 h-4 ml-auto flex-shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/>
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy button
// ─────────────────────────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={copy}
      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
        copied
          ? "bg-green-400/15 text-green-400"
          : "bg-white/6 text-white/50 hover:bg-yellow/10 hover:text-yellow"
      }`}
    >
      {copied ? (
        <><span>✓</span> Copied</>
      ) : (
        <><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{label ?? "Copy"}</>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────────────────────

function Spinner({ size = 5 }: { size?: number }) {
  return (
    <svg className={`animate-spin w-${size} h-${size}`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

type Step = "quote" | "pay" | "verifying" | "success" | "error";

export default function PaymentPage() {
  const router = useRouter();
  const { address, isConnected, connectWith } = useWallet();

  // ── Quote state ───────────────────────────────────────────────────────────
  const [selectedChain,  setSelectedChain]  = useState("bnb");
  const [selectedVolume, setSelectedVolume] = useState(10_000);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [step,           setStep]           = useState<Step>("quote");
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [addrCopied,     setAddrCopied]     = useState(false);

  // ── Verification state ────────────────────────────────────────────────────
  const [pendingPayment,  setPendingPayment]  = useState(false); // true while awaiting wallet connect
  const [verifyAttempts, setVerifyAttempts] = useState(0);
  const [verifyError,    setVerifyError]    = useState<string | null>(null);
  const [activatedPlan,  setActivatedPlan]  = useState<string | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  const chain              = CHAINS.find(c => c.id === selectedChain)!;
  const { price, isEnterprise, perTx } = calcPrice(selectedChain, selectedVolume);
  const availableTokens    = chain.tokens as readonly string[];
  const payToken           = availableTokens[0] ?? "USDC"; // default to first available

  // Once wallet connects after user clicked "Connect Wallet & Pay" → auto-advance
  useEffect(() => {
    if (pendingPayment && isConnected && step === "quote") {
      setPendingPayment(false);
      setStep("pay");
    }
  }, [pendingPayment, isConnected, step]);

  // Check if already active when address changes
  useEffect(() => {
    if (!address || step !== "quote") return;
    fetch(`/api/payment/check?address=${address}`)
      .then(r => r.json())
      .then(data => {
        if (data.status === "already_paid" && !data.isExpired) {
          // Already subscribed — go to dashboard
          router.push("/dashboard");
        }
      })
      .catch(() => {});
  }, [address, step, router]);

  // ── Copy address helper ───────────────────────────────────────────────────
  function copyAddress() {
    navigator.clipboard.writeText(PAYMENT_ADDRESS);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2500);
  }

  // ── Verify payment on-chain ───────────────────────────────────────────────
  async function verifyPayment() {
    if (!address) return;
    setStep("verifying");
    setVerifyError(null);

    try {
      const res  = await fetch("/api/payment/activate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ address }),
      });
      const data = await res.json();

      if (res.ok && (data.status === "activated" || data.status === "already_active")) {
        setActivatedPlan(data.plan);
        setStep("success");
      } else {
        setVerifyAttempts(v => v + 1);
        setVerifyError(data.error ?? "Payment not found on-chain yet.");
        setStep("error");
      }
    } catch {
      setVerifyAttempts(v => v + 1);
      setVerifyError("Network error. Please try again.");
      setStep("error");
    }
  }

  // ── Proceed from quote ────────────────────────────────────────────────────
  function proceedToPayment() {
    if (!isConnected) {
      setPendingPayment(true);   // once wallet connects, useEffect will advance to "pay"
      setShowWalletModal(true);
      return;
    }
    setStep("pay");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen text-white" style={{ background: "#080E1C" }}>

      {/* ── Nav ────────────────────────────────────────────────────────────── */}
      <nav className="border-b border-white/8 px-6 h-16 flex items-center justify-between max-w-6xl mx-auto">
        <a href="/" className="flex items-center gap-2">
          <span className="text-yellow font-bold text-lg">Q402</span>
          <span className="text-white/30 text-sm">by Quack AI</span>
        </a>
        <div className="flex items-center gap-4">
          {isConnected && address ? (
            <div className="flex items-center gap-2 bg-white/[0.04] border border-white/8 rounded-full px-3 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 5px #4ade80" }} />
              <span className="text-xs text-white/60 font-mono">{shortAddr(address)}</span>
            </div>
          ) : (
            <button
              onClick={() => setShowWalletModal(true)}
              className="text-xs text-white/40 hover:text-yellow transition-colors border border-white/10 rounded-full px-3 py-1.5"
            >
              Connect Wallet
            </button>
          )}
          <a href="/" className="text-white/40 text-sm hover:text-white transition-colors">← Back</a>
        </div>
      </nav>

      {/* ── Progress bar ────────────────────────────────────────────────────── */}
      <div className="h-px w-full" style={{ background: "rgba(255,255,255,0.04)" }}>
        <div
          className="h-full transition-all duration-700"
          style={{
            background: "linear-gradient(90deg, #F5C518, #FFE580)",
            width: step === "quote" ? "33%" : step === "pay" ? "66%" : "100%",
          }}
        />
      </div>

      <main className="max-w-5xl mx-auto px-6 py-14">

        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-yellow/8 border border-yellow/20 rounded-full px-4 py-1.5 mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow" style={{ boxShadow: "0 0 6px #F5C518" }} />
            <span className="text-yellow text-xs font-semibold uppercase tracking-widest">
              {step === "quote" ? "Custom Quote Builder" : step === "pay" ? "Complete Payment" : step === "verifying" ? "Verifying Payment" : step === "success" ? "Subscription Active" : "Payment Check"}
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-2">
            {step === "quote"     ? "Build your plan" :
             step === "pay"       ? "Send your payment" :
             step === "verifying" ? "Scanning the blockchain…" :
             step === "success"   ? "You're live 🎉" :
             "Let's check again"}
          </h1>
          <p className="text-white/35 text-sm max-w-md mx-auto">
            {step === "quote"     ? "Select your chain and monthly volume for an instant quote." :
             step === "pay"       ? `Send exactly $${price.toLocaleString()} ${payToken} to the address below.` :
             step === "verifying" ? "This usually takes 10–30 seconds. Hang tight." :
             step === "success"   ? "Your API key is ready. Head to your dashboard." :
             "Payment not detected yet. Make sure the transfer confirmed on-chain."}
          </p>
        </div>

        {/* ════════════════════════════════════════════════════════════════════
            STEP: QUOTE BUILDER
        ════════════════════════════════════════════════════════════════════ */}
        {step === "quote" && (
          <div className="grid lg:grid-cols-[1fr_360px] gap-8 items-start">

            {/* LEFT: selectors */}
            <div className="space-y-6">

              {/* Chain selector */}
              <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
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
                            ? "border-white/5 opacity-40 cursor-not-allowed"
                            : active
                            ? "border-yellow/50 bg-yellow/6"
                            : "border-white/8 hover:border-white/20"
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={c.img} alt={c.name} className={`w-7 h-7 flex-shrink-0 ${c.rounded}`} />
                        <div className="min-w-0">
                          <p className="text-xs font-semibold truncate">{c.name}</p>
                          {c.comingSoon ? (
                            <p className="text-[10px] text-white/25">Integrating…</p>
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

              {/* Volume selector */}
              <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
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
                          : "border-white/8 text-white/50 hover:border-white/25 hover:text-white"
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
              <div className="rounded-2xl border border-white/10 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
                <div className="px-6 py-4 border-b border-white/8" style={{ background: "rgba(245,197,24,0.04)" }}>
                  <p className="text-yellow font-bold text-sm uppercase tracking-widest">Your Quote</p>
                </div>
                <div className="p-6">
                  {/* Chain + volume summary */}
                  <div className="flex items-center gap-3 mb-5 p-3 rounded-xl border border-white/6" style={{ background: "rgba(255,255,255,0.02)" }}>
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
                          <span className="text-white/40 text-sm">Monthly</span>
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
                      className="block w-full text-center bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all"
                    >
                      Contact Sales →
                    </a>
                  ) : (
                    <button
                      onClick={proceedToPayment}
                      className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
                    >
                      {isConnected ? "Proceed to Payment →" : "Connect Wallet & Pay →"}
                    </button>
                  )}

                  <p className="text-white/15 text-[10px] text-center mt-3">
                    One-click on-chain payment · API key issued instantly
                  </p>
                </div>
              </div>

              {/* Security note */}
              <div className="mt-4 p-4 rounded-xl border border-white/6 flex gap-3" style={{ background: "rgba(255,255,255,0.01)" }}>
                <span className="text-yellow/60 text-base flex-shrink-0">🔒</span>
                <p className="text-white/25 text-xs leading-relaxed">
                  Your API key is tied to your connected wallet address. Only your wallet can access it in the dashboard.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            STEP: PAYMENT INSTRUCTIONS
        ════════════════════════════════════════════════════════════════════ */}
        {step === "pay" && (
          <div className="max-w-xl mx-auto space-y-5">

            {/* Wallet connected indicator */}
            <div className="rounded-2xl p-5 border border-green-400/20 flex items-center gap-4" style={{ background: "rgba(74,222,128,0.04)" }}>
              <div className="w-10 h-10 rounded-full bg-green-400/10 border border-green-400/20 flex items-center justify-center flex-shrink-0">
                <span className="w-2.5 h-2.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 8px #4ade80" }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-green-400 font-semibold uppercase tracking-widest mb-0.5">Wallet Connected</p>
                <p className="font-mono text-sm text-white/70 truncate">{address}</p>
              </div>
              <div className="text-right flex-shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={chain.img} alt={chain.name} className={`w-6 h-6 ${chain.rounded} ml-auto mb-1`} />
                <p className="text-white/30 text-xs">{chain.name}</p>
              </div>
            </div>

            {/* Payment amount + token */}
            <div className="rounded-2xl p-6 border border-yellow/20" style={{ background: "rgba(245,197,24,0.04)" }}>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-3 font-semibold">Amount to Send</p>
              <div className="flex items-end justify-between">
                <div>
                  <span className="text-5xl font-extrabold text-yellow">${price.toLocaleString()}</span>
                  <span className="text-white/30 text-lg ml-2">{payToken}</span>
                </div>
                <div className="text-right">
                  <p className="text-white/30 text-xs">{selectedVolume.toLocaleString()} txs/mo</p>
                  <p className="text-white/20 text-xs">30-day subscription</p>
                </div>
              </div>
              {availableTokens.length > 1 && (
                <p className="text-white/20 text-xs mt-3">
                  Also accepted: {availableTokens.slice(1).join(", ")} — any stablecoin transfer to this address qualifies.
                </p>
              )}
            </div>

            {/* Recipient address */}
            <div className="rounded-2xl p-6 border border-white/10" style={{ background: "rgba(255,255,255,0.02)" }}>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-3 font-semibold">Send To</p>
              <div className="flex items-center gap-3 bg-navy border border-white/8 rounded-xl px-4 py-3 mb-3">
                <p className="font-mono text-sm text-white/80 flex-1 break-all">{PAYMENT_ADDRESS}</p>
                <CopyButton value={PAYMENT_ADDRESS} />
              </div>
              <div className="flex items-start gap-2 text-xs text-white/25">
                <span className="text-yellow/50 mt-0.5 flex-shrink-0">⚠</span>
                <p>
                  Send from the wallet connected above (<span className="font-mono text-white/40">{address ? shortAddr(address) : "—"}</span>).
                  Payments from other addresses will not activate your account.
                </p>
              </div>
            </div>

            {/* Step-by-step guide */}
            <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-4 font-semibold">How to Pay</p>
              <ol className="space-y-3">
                {[
                  { n: "1", text: `Open MetaMask or OKX Wallet and switch to ${chain.name}.` },
                  { n: "2", text: `Add ${payToken} token if not already visible in your wallet.` },
                  { n: "3", text: `Send exactly $${price.toLocaleString()} ${payToken} to the address above.` },
                  { n: "4", text: 'Wait for the transaction to confirm, then click "I\'ve paid" below.' },
                ].map(item => (
                  <li key={item.n} className="flex items-start gap-3 text-sm text-white/50">
                    <span className="w-5 h-5 rounded-full bg-yellow/10 border border-yellow/20 text-yellow text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {item.n}
                    </span>
                    {item.text}
                  </li>
                ))}
              </ol>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3 pt-2">
              <button
                onClick={verifyPayment}
                className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.01]"
              >
                I&apos;ve Sent the Payment — Verify Now →
              </button>
              <button
                onClick={() => setStep("quote")}
                className="w-full text-white/30 text-sm py-2 hover:text-white/60 transition-colors"
              >
                ← Back to quote
              </button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            STEP: VERIFYING
        ════════════════════════════════════════════════════════════════════ */}
        {step === "verifying" && (
          <div className="max-w-md mx-auto text-center py-8">
            <div className="w-20 h-20 rounded-full border-2 border-yellow/20 flex items-center justify-center mx-auto mb-6 relative">
              <div className="absolute inset-0 rounded-full border-2 border-yellow animate-spin" style={{ borderTopColor: "transparent", borderRightColor: "transparent" }} />
              <svg className="w-8 h-8 text-yellow/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4"/>
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2">Scanning all chains…</h3>
            <p className="text-white/40 text-sm mb-6">
              Checking BNB Chain, Avalanche, Ethereum, X Layer, and Stable for your transfer.
              This usually completes within 15 seconds.
            </p>
            <div className="flex flex-col gap-2 text-xs text-white/25">
              {["BNB Chain", "Avalanche", "Ethereum", "X Layer", "Stable"].map(c => (
                <div key={c} className="flex items-center gap-2 justify-center">
                  <Spinner size={3} />
                  <span>Scanning {c}…</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            STEP: ERROR / RETRY
        ════════════════════════════════════════════════════════════════════ */}
        {step === "error" && (
          <div className="max-w-md mx-auto">
            <div className="rounded-2xl p-8 border border-red-400/20 text-center mb-5" style={{ background: "rgba(248,113,113,0.04)" }}>
              <div className="w-14 h-14 rounded-full bg-red-400/10 border border-red-400/20 flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              </div>
              <h3 className="text-lg font-bold mb-2">Not found yet</h3>
              <p className="text-white/40 text-sm mb-4">
                {verifyError}
              </p>
              {verifyAttempts <= 2 ? (
                <p className="text-white/25 text-xs">
                  Blockchain confirmations can take 1–3 minutes. Wait a moment and try again.
                </p>
              ) : (
                <p className="text-white/25 text-xs">
                  Still not found? Make sure you sent from <span className="font-mono text-white/40">{address ? shortAddr(address) : "—"}</span> and the transaction is confirmed.
                  Contact <a href="mailto:hello@quackai.ai" className="text-yellow/70 hover:text-yellow transition-colors">hello@quackai.ai</a> if the issue persists.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={verifyPayment}
                className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all"
              >
                Try Again →
              </button>
              <button
                onClick={() => setStep("pay")}
                className="w-full text-white/30 text-sm py-2 hover:text-white/60 transition-colors"
              >
                ← Back to payment instructions
              </button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
            STEP: SUCCESS
        ════════════════════════════════════════════════════════════════════ */}
        {step === "success" && (
          <div className="max-w-md mx-auto text-center">
            <div className="rounded-2xl p-10 border border-green-400/20 mb-6" style={{ background: "rgba(74,222,128,0.04)" }}>
              <div className="w-20 h-20 rounded-full bg-green-400/10 border border-green-400/20 flex items-center justify-center mx-auto mb-5">
                <svg className="w-10 h-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
              </div>
              <h3 className="text-2xl font-extrabold mb-2">Payment Confirmed</h3>
              <p className="text-white/40 text-sm mb-1">
                Your <span className="text-yellow font-semibold capitalize">{activatedPlan}</span> subscription is now active.
              </p>
              <p className="text-white/25 text-xs">
                API key is tied to <span className="font-mono text-white/40">{address ? shortAddr(address) : "—"}</span>
              </p>
            </div>

            {/* What's next */}
            <div className="rounded-2xl p-6 border border-white/8 text-left mb-6" style={{ background: "rgba(255,255,255,0.02)" }}>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-4 font-semibold">What&apos;s Next</p>
              <ol className="space-y-3 text-sm text-white/50">
                {[
                  "Go to your dashboard and copy your API key.",
                  "Fund your Gas Tank so Q402 can pay relay fees on your behalf.",
                  "Install the SDK and make your first gasless transaction.",
                ].map((t, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="w-5 h-5 rounded-full bg-yellow/10 border border-yellow/20 text-yellow text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                    {t}
                  </li>
                ))}
              </ol>
            </div>

            <button
              onClick={() => router.push("/dashboard")}
              className="w-full bg-yellow text-navy font-extrabold py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02] text-base"
            >
              Go to Dashboard →
            </button>
          </div>
        )}

      </main>

      {/* ── Wallet modal ─────────────────────────────────────────────────────── */}
      {showWalletModal && typeof window !== "undefined" && (
        <WalletModal onClose={() => setShowWalletModal(false)} />
      )}
    </div>
  );
}
