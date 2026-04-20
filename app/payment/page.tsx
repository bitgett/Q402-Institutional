"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/app/context/WalletContext";
import WalletModal from "@/app/components/WalletModal";
import { getAuthCreds, clearAuthCache, getFreshChallenge } from "@/app/lib/auth-client";
import { SUBSCRIPTION_ADDRESS } from "@/app/lib/wallets";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_ADDRESS = SUBSCRIPTION_ADDRESS;

const PAY_TOKENS = [
  { id: "bnb-usdc", label: "BNB USDC", chain: "BNB Chain", chainId: "bnb", token: "USDC", color: "#F0B90B", img: "/bnb.png"  },
  { id: "bnb-usdt", label: "BNB USDT", chain: "BNB Chain", chainId: "bnb", token: "USDT", color: "#F0B90B", img: "/bnb.png"  },
  { id: "eth-usdc", label: "ETH USDC", chain: "Ethereum",  chainId: "eth", token: "USDC", color: "#627EEA", img: "/eth.png"  },
  { id: "eth-usdt", label: "ETH USDT", chain: "Ethereum",  chainId: "eth", token: "USDT", color: "#627EEA", img: "/eth.png"  },
];

const CHAINS = [
  { id: "bnb",      name: "BNB Chain", color: "#F0B90B", img: "/bnb.png",      rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "avax",     name: "Avalanche", color: "#E84142", img: "/avax.png",     rounded: "rounded-full", multiplier: 1.1, comingSoon: false },
  { id: "xlayer",   name: "X Layer",   color: "#CCCCCC", img: "/xlayer.png",   rounded: "rounded-sm",   multiplier: 1.0, comingSoon: false },
  { id: "eth",      name: "Ethereum",  color: "#627EEA", img: "/eth.png",      rounded: "rounded-full", multiplier: 1.5, comingSoon: false },
  { id: "stable",   name: "Stable",    color: "#4AE54A", img: "/stable.jpg",   rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "arbitrum", name: "Arbitrum",  color: "#28A0F0", img: "/arbitrum.png", rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
  { id: "scroll",   name: "Scroll",    color: "#FFDBB0", img: "/scroll.png",   rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
];

// value = credits granted at that price tier. Must stay in sync with
// TIER_CREDITS in app/lib/blockchain.ts — the server grants `value` credits
// at checkout, so the UI label must reflect the actual amount.
// Volumes above 500K go through sales (Contact sales link below the grid).
const VOLUMES = [
  { label: "500",       value: 500,     basePrice: 29   },
  { label: "1,000",     value: 1_000,   basePrice: 49   },
  { label: "5,000",     value: 5_000,   basePrice: 89   },
  { label: "10,000",    value: 10_000,  basePrice: 149  },
  { label: "50,000",    value: 50_000,  basePrice: 449  },
  { label: "100,000",   value: 100_000, basePrice: 799  },
  { label: "500,000",   value: 500_000, basePrice: 1999 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function calcPrice(chainId: string, volume: number) {
  const chain = CHAINS.find(c => c.id === chainId)!;
  const vol   = VOLUMES.find(v => v.value === volume)!;
  const price = Math.round(vol.basePrice * chain.multiplier / 10) * 10;
  return { price, perTx: price / vol.value };
}

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }

// ─────────────────────────────────────────────────────────────────────────────
// Copy button
// ─────────────────────────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all flex-shrink-0 ${
        copied ? "bg-green-400/15 text-green-400" : "bg-white/6 text-white/50 hover:bg-yellow/10 hover:text-yellow"
      }`}
    >
      {copied ? "✓ Copied" : (label ?? "Copy")}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step header (numbered)
// ─────────────────────────────────────────────────────────────────────────────

function StepHeader({ n, title, sub, done }: { n: string; title: string; sub: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 transition-all ${
        done ? "bg-green-400 text-navy" : "bg-yellow text-navy"
      }`}>
        {done ? "✓" : n}
      </span>
      <div>
        <p className="font-semibold text-sm">{title}</p>
        <p className="text-white/30 text-xs mt-0.5">{sub}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

type PayStep = "idle" | "ready" | "verifying" | "success" | "error";

export default function PaymentPage() {
  const router = useRouter();
  const { address, isConnected, signMessage } = useWallet();

  const [selectedChain,    setSelectedChain]    = useState("bnb");
  const [selectedVolume,   setSelectedVolume]   = useState(10_000);
  const [selectedPayToken, setSelectedPayToken] = useState("bnb-usdc");
  // Read localStorage synchronously so Step 3 shows "connected" immediately
  // if the user already connected on the landing page — no flash.
  const [payStepState, setPayStep] = useState<PayStep>(() => {
    try { return localStorage.getItem("q402_wallet") ? "ready" : "idle"; } catch { return "idle"; }
  });
  const [showWalletModal,  setShowWalletModal]  = useState(false);
  const [verifyAttempts,   setVerifyAttempts]   = useState(0);
  const [verifyError,      setVerifyError]      = useState<string | null>(null);
  const [activatedPlan,    setActivatedPlan]    = useState<string | null>(null);
  const [txHashInput,      setTxHashInput]      = useState("");

  const chain = CHAINS.find(c => c.id === selectedChain)!;
  const { price, perTx } = calcPrice(selectedChain, selectedVolume);
  const payToken = PAY_TOKENS.find(t => t.id === selectedPayToken)!;

  // Derived: once wallet connects, treat idle as ready. Computed at render so
  // React 19 doesn't flag a setState-in-effect cascade.
  const payStep: PayStep = isConnected && payStepState === "idle" ? "ready" : payStepState;

  // Removed: no longer redirect existing subscribers — they can top up credits

  async function verifyPayment() {
    if (!address) return;
    setPayStep("verifying");
    setVerifyError(null);
    let nextIntentId: string | null = null;
    try {
      // Step 1: session nonce for intent (cached 55 min; one wallet popup per session)
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) {
        setVerifyError("__sig_declined__");
        setPayStep("error");
        return;
      }
      const { nonce, signature } = auth;

      // Record payment intent (chain + expected USD) before scanning blockchain.
      // activate route validates the found TX against this intent.
      if (price > 0) {
        const intentRes = await fetch("/api/payment/intent", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          // chain = payment chain (where funds move); planChain = selected relay chain.
        // Server locks quotedPlan/quotedCredits at intent time — activate uses those values.
        body:    JSON.stringify({ address, nonce, signature, chain: payToken.chainId, planChain: selectedChain, expectedUSD: price, token: payToken?.token }),
        });
        if (!intentRes.ok) {
          const d = await intentRes.json();
          if (intentRes.status === 401 && d.code === "NONCE_EXPIRED") { clearAuthCache(address); }
          setVerifyAttempts(v => v + 1);
          setVerifyError(d.error ?? "Could not record payment intent.");
          setPayStep("error");
          return;
        }
        // Capture intentId in a local so the activate call below sees it on
        // the first render — setState would be async and leave intentId null
        // in the very same tick, defeating the per-intent cross-tab guarantee.
        const intentData = await intentRes.json();
        nextIntentId = intentData.intentId ?? null;
      }

      // Step 2: fresh one-time challenge for activation (always prompts wallet)
      const chal = await getFreshChallenge(address, signMessage);
      if (!chal) {
        setVerifyError("__sig_declined__");
        setPayStep("error");
        return;
      }

      const res  = await fetch("/api/payment/activate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          address,
          challenge:  chal.challenge,
          signature:  chal.signature,
          // intentId validates the server uses the same quote the user saw.
          ...(nextIntentId ? { intentId: nextIntentId } : {}),
          // If user provided a txHash, pass it for deterministic verification.
          ...(txHashInput.trim() ? { txHash: txHashInput.trim() } : {}),
        }),
      });
      const data = await res.json();

      if (res.status === 401 && data.code === "NONCE_EXPIRED") {
        setVerifyAttempts(v => v + 1);
        setVerifyError("Challenge expired. Please try again.");
        setPayStep("error");
        return;
      }

      if (res.ok && (data.status === "activated" || data.status === "already_active" || data.status === "credits_added")) {
        setActivatedPlan(data.plan);
        setPayStep("success");
      } else {
        setVerifyAttempts(v => v + 1);
        setVerifyError(data.error ?? "Payment not found on-chain yet.");
        setPayStep("error");
      }
    } catch {
      setVerifyAttempts(v => v + 1);
      setVerifyError("Network error. Please try again.");
      setPayStep("error");
    }
  }

  return (
    <div className="min-h-screen text-white" style={{ background: "#080E1C" }}>

      {/* ── Nav ────────────────────────────────────────────────────────────── */}
      <nav className="border-b border-white/8 px-6 h-16 flex items-center justify-between max-w-6xl mx-auto">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-yellow font-bold text-lg">Q402</span>
          <span className="text-white/30 text-sm">by Quack AI</span>
        </Link>
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
          <Link href="/" className="text-white/40 text-sm hover:text-white transition-colors">← Back</Link>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-14">

        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-yellow/8 border border-yellow/20 rounded-full px-4 py-1.5 mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow" style={{ boxShadow: "0 0 6px #F5C518" }} />
            <span className="text-yellow text-xs font-semibold uppercase tracking-widest">Custom Quote Builder</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-2">Build your plan</h1>
          <p className="text-white/35 text-sm max-w-md mx-auto">
            4 steps · connect wallet · pay on-chain · API key issued instantly
          </p>
        </div>

        <div className="grid lg:grid-cols-[1fr_320px] gap-8 items-start">

          {/* ── LEFT: all 4 steps ──────────────────────────────────────────── */}
          <div className="space-y-4">

            {/* ── STEP 1: Service chain ─────────────────────────────────── */}
            <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <StepHeader
                n="1"
                title="Service chain"
                sub="Where your relay credits will run. You can pay on a different chain in step 4."
                done={false}
              />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {CHAINS.map(c => {
                  const active = selectedChain === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => !c.comingSoon && setSelectedChain(c.id)}
                      disabled={c.comingSoon}
                      className={`relative flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                        c.comingSoon ? "border-white/5 opacity-40 cursor-not-allowed"
                        : active     ? "border-yellow/50 bg-yellow/6"
                        :              "border-white/8 hover:border-white/20"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.img} alt={c.name} className={`w-7 h-7 flex-shrink-0 ${c.rounded}`} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{c.name}</p>
                        {c.comingSoon ? <p className="text-[10px] text-white/25">Integrating…</p>
                        : c.multiplier > 1.0 ? <p className="text-[10px] text-white/25">+{Math.round((c.multiplier - 1) * 100)}%</p>
                        : <p className="text-[10px] text-white/25">Base rate</p>}
                      </div>
                      {active && !c.comingSoon && (
                        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-yellow" style={{ boxShadow: "0 0 5px #F5C518" }} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── STEP 2: Volume ─────────────────────────────────────────── */}
            <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <StepHeader n="2" title="Sponsored transactions" sub="Each payment adds 30 days + this many gasless TXs to your account." done={false} />
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
              <p className="mt-3 text-xs text-white/30 text-right">
                Need more than 500K?{" "}
                <a
                  href="mailto:davidlee@quackai.ai?subject=Q402 Enterprise Inquiry"
                  className="text-yellow/80 hover:text-yellow transition-colors"
                >
                  Contact sales →
                </a>
              </p>
            </div>

            {/* ── STEP 3: Connect Wallet ─────────────────────────────────── */}
            <div className={`rounded-2xl p-6 border transition-all ${
              payStep !== "idle"
                ? "border-green-400/20"
                : "border-white/8"
            }`} style={{ background: "rgba(255,255,255,0.02)" }}>
              <StepHeader
                n="3"
                title="Connect your wallet"
                sub="Your API key will be tied to this address"
                done={payStep !== "idle"}
              />

              {payStep === "idle" ? (
                <button
                  onClick={() => setShowWalletModal(true)}
                  className="w-full bg-yellow text-navy font-bold text-sm py-3.5 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.01]"
                >
                  Connect Wallet →
                </button>
              ) : (
                <div className="flex items-center gap-3 bg-green-400/5 border border-green-400/15 rounded-xl px-4 py-3">
                  <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 6px #4ade80" }} />
                  <span className="font-mono text-sm text-white/70 flex-1 truncate">{address}</span>
                  <span className="text-xs text-green-400 font-semibold flex-shrink-0">Connected</span>
                </div>
              )}
            </div>

            {/* ── STEP 4: Send Payment ───────────────────────────────────── */}
            <div className={`rounded-2xl p-6 border transition-all ${
              payStep === "idle" ? "border-white/5 opacity-50 pointer-events-none"
              : payStep === "success" ? "border-green-400/20"
              : "border-white/8"
            }`} style={{ background: "rgba(255,255,255,0.02)" }}>
              <StepHeader
                n="4"
                title="Send payment & verify"
                sub="Pay on-chain — API key issued automatically"
                done={payStep === "success"}
              />

              {/* Verifying */}
              {payStep === "verifying" && (
                <div className="flex items-center gap-4 py-4">
                  <svg className="animate-spin w-8 h-8 text-yellow flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2"/>
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                  </svg>
                  <div>
                    <p className="font-semibold text-sm">Scanning blockchain…</p>
                    <p className="text-white/35 text-xs mt-0.5">Usually 10–30 seconds</p>
                  </div>
                </div>
              )}

              {/* Success */}
              {payStep === "success" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 bg-green-400/5 border border-green-400/15 rounded-xl px-4 py-3">
                    <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    <div>
                      <p className="text-green-400 font-bold text-sm">Payment Confirmed!</p>
                      <p className="text-white/40 text-xs capitalize">{activatedPlan} plan is now active</p>
                    </div>
                  </div>
                  <button
                    onClick={() => router.push("/dashboard")}
                    className="w-full bg-yellow text-navy font-extrabold py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
                  >
                    Open My Page →
                  </button>
                </div>
              )}

              {/* Error */}
              {payStep === "error" && (
                <div className="space-y-3 mb-4">
                  {verifyError === "__sig_declined__" ? (
                    <div className="bg-yellow/5 border border-yellow/20 rounded-xl px-4 py-3 text-sm text-yellow/80">
                      <p className="font-semibold">One more step — approve the wallet prompt</p>
                      <p className="text-xs mt-1 text-yellow/50">
                        We need a quick signature to confirm you own this wallet. It&apos;s free (no gas) and proves your payment came from this address.
                      </p>
                    </div>
                  ) : (
                    <div className="bg-red-400/5 border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">
                      {verifyError}
                      {verifyAttempts > 2 && (
                        <p className="text-xs text-red-400/60 mt-1">
                          Still not found? Contact <a href="mailto:davidlee@quackai.ai" className="underline">davidlee@quackai.ai</a>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Ready or Error → show payment form */}
              {(payStep === "ready" || payStep === "error") && (
                <div className="space-y-4">

                  {/* Token selector */}
                  <div>
                    <div className="flex items-baseline justify-between mb-2">
                      <p className="text-xs text-white/30 uppercase tracking-widest font-semibold">Payment rail</p>
                      <p className="text-[10px] text-white/25">Different from your service chain above</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {PAY_TOKENS.map(t => (
                        <button
                          key={t.id}
                          onClick={() => setSelectedPayToken(t.id)}
                          className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                            selectedPayToken === t.id
                              ? "border-yellow/50 bg-yellow/8 text-yellow"
                              : "border-white/8 text-white/50 hover:border-white/20"
                          }`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={t.img} alt={t.chain} className="w-4 h-4 rounded-full flex-shrink-0" />
                          {t.label}
                          {selectedPayToken === t.id && (
                            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-yellow flex-shrink-0" style={{ boxShadow: "0 0 4px #F5C518" }} />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Address */}
                  <div>
                    <p className="text-xs text-white/30 uppercase tracking-widest mb-2 font-semibold">
                      Send ${price.toLocaleString()} {payToken.token} on {payToken.chain} to
                    </p>
                    <div className="flex items-center gap-2 bg-[#060C14] border border-white/10 rounded-xl px-3 py-3">
                      <span className="font-mono text-xs text-white/70 flex-1 break-all">{PAYMENT_ADDRESS}</span>
                      <CopyButton value={PAYMENT_ADDRESS} />
                    </div>
                    <p className="text-white/20 text-[10px] mt-2">
                      ⚠ Send from <span className="font-mono text-white/35">{address ? shortAddr(address) : "—"}</span> only. Payments from other wallets will not activate your account.
                    </p>
                  </div>

                  {/* Optional txHash input */}
                  <div>
                    <label className="block text-[10px] text-white/25 uppercase tracking-widest mb-1">
                      Transaction Hash <span className="normal-case text-white/15">(optional — paste for instant verification)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="0x..."
                      value={txHashInput}
                      onChange={e => setTxHashInput(e.target.value)}
                      className="w-full bg-white/[0.03] border border-white/8 rounded-xl px-3 py-2.5 text-xs font-mono text-white/70 placeholder-white/20 focus:outline-none focus:border-yellow/30"
                    />
                    <p className="text-[10px] text-white/15 mt-1">
                      If left blank, Q402 will scan the blockchain for your payment automatically.
                    </p>
                  </div>

                  {/* Verify */}
                  {payStep === "ready" && (
                    <p className="text-white/25 text-[11px] text-center">
                      You&apos;ll approve a free wallet signature to confirm ownership — no gas required.
                    </p>
                  )}
                  <button
                    onClick={verifyPayment}
                    className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.01]"
                  >
                    {verifyError === "__sig_declined__" ? "Approve Signature →" : payStep === "error" ? "Try Again →" : "I've Sent — Verify Now →"}
                  </button>
                </div>
              )}

              {/* Locked placeholder */}
              {payStep === "idle" && (
                <div className="text-white/20 text-sm text-center py-3">
                  Connect wallet first to unlock this step
                </div>
              )}
            </div>

          </div>

          {/* ── RIGHT: Quote summary (sticky) ──────────────────────────── */}
          <div className="lg:sticky lg:top-8">
            <div className="rounded-2xl border border-white/10 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="px-6 py-4 border-b border-white/8" style={{ background: "rgba(245,197,24,0.04)" }}>
                <p className="text-yellow font-bold text-sm uppercase tracking-widest">Your Quote</p>
              </div>
              <div className="p-6">
                {/* Service chain — where credits run */}
                <div className="mb-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-[0.18em] mb-1.5 font-semibold">Service chain</p>
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-white/6" style={{ background: "rgba(255,255,255,0.02)" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={chain.img} alt={chain.name} className={`w-8 h-8 flex-shrink-0 ${chain.rounded}`} />
                    <div>
                      <p className="text-sm font-semibold">{chain.name}</p>
                      <p className="text-white/35 text-xs">{selectedVolume.toLocaleString()} TXs · +30 days</p>
                    </div>
                  </div>
                </div>

                {/* Payment rail — where funds actually move */}
                <div className="mb-5">
                  <p className="text-[10px] text-white/30 uppercase tracking-[0.18em] mb-1.5 font-semibold">Payment rail</p>
                  {payStep !== "idle" ? (
                    <div className="flex items-center gap-3 p-3 rounded-xl border border-white/6" style={{ background: "rgba(255,255,255,0.02)" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={payToken.img} alt={payToken.chain} className="w-8 h-8 flex-shrink-0 rounded-full" />
                      <div>
                        <p className="text-sm font-semibold">{payToken.label}</p>
                        <p className="text-white/35 text-xs">Funds settle on {payToken.chain}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl border border-dashed border-white/10 text-xs text-white/30" style={{ background: "rgba(255,255,255,0.01)" }}>
                      Pick a pay token after connecting your wallet
                    </div>
                  )}
                </div>

                {/* Price */}
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-white/40 text-sm">+30 days · {selectedVolume.toLocaleString()} TXs</span>
                  <div>
                    <span className="text-3xl font-extrabold text-yellow">${price.toLocaleString()}</span>
                  </div>
                </div>
                <p className="text-white/25 text-xs text-right mb-1">
                  ${perTx < 0.01 ? perTx.toFixed(4) : perTx.toFixed(3)} per tx
                </p>
                {chain.multiplier > 1.0 && (
                  <p className="text-white/20 text-xs text-right">
                    Includes {chain.name} +{Math.round((chain.multiplier - 1) * 100)}% rate
                  </p>
                )}

                {/* Security note */}
                <div className="mt-5 pt-4 border-t border-white/6 flex gap-2">
                  <span className="text-yellow/40 text-xs flex-shrink-0">🔒</span>
                  <p className="text-white/20 text-[10px] leading-relaxed">
                    API key tied to your wallet. Pay in USDC / USDT on BNB Chain or Ethereum — credits apply to your selected plan chain (BNB · AVAX · ETH · X Layer · Stable).
                  </p>
                </div>
              </div>
            </div>
          </div>

        </div>
      </main>

      {showWalletModal && typeof window !== "undefined" && (
        <WalletModal onClose={() => setShowWalletModal(false)} />
      )}
    </div>
  );
}
