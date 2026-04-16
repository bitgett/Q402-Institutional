"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useWallet } from "@/app/context/WalletContext";
import { isWalletInstalled } from "@/app/lib/wallet";
import { getAuthCreds, clearAuthCache, getFreshChallenge } from "@/app/lib/auth-client";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_ADDRESS = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

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

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Connect Modal  (identical to landing page WalletButton modal)
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

  const wallets = [
    {
      id: "metamask" as const,
      name: "MetaMask",
      desc: "Browser extension wallet",
      icon: (
        <div className="w-8 h-8 rounded-lg flex-shrink-0 overflow-hidden" style={{ background: "#F6851B" }}>
          <svg viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full p-0.5">
            <path d="M32.958 1L19.862 10.765l2.388-5.637L32.958 1z" fill="#E17726" stroke="#E17726" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2.042 1l12.986 9.848-2.27-5.72L2.042 1z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M28.16 23.533l-3.488 5.338 7.463 2.054 2.143-7.27-6.118-.122zM.744 23.655l2.131 7.27 7.451-2.054-3.476-5.338-6.106.122z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9.902 14.585l-2.082 3.147 7.415.338-.245-7.973-5.088 4.488zM25.098 14.585l-5.16-4.57-.169 8.055 7.415-.338-2.086-3.147zM10.326 28.871l4.47-2.165-3.852-3.003-.618 5.168zM20.204 26.706l4.458 2.165-.606-5.168-3.852 3.003z" fill="#E27625" stroke="#E27625" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M24.662 28.871l-4.458-2.165.357 2.916-.04 1.218 4.141-1.969zM10.326 28.871l4.153 1.969-.027-1.218.344-2.916-4.47 2.165z" fill="#D5BFB2" stroke="#D5BFB2" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14.55 21.822l-3.714-.977 2.623-1.202 1.091 2.179zM20.45 21.822l1.09-2.179 2.636 1.202-3.726.977z" fill="#233447" stroke="#233447" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10.326 28.871l.644-5.338-4.114.122 3.47 5.216zM24.03 23.533l.632 5.338 3.47-5.216-4.102-.122zM27.18 17.732l-7.415.338.688 3.752 1.09-2.179 2.636 1.202 3.001-3.113zM10.836 20.845l2.623-1.202 1.078 2.179.7-3.752-7.415-.338 3.014 3.113z" fill="#CC6228" stroke="#CC6228" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M7.82 17.732l3.11 6.073-.104-3.003-3.006-3.07zM24.174 20.802l-.116 3.003 3.122-6.073-3.006 3.07zM14.55 18.07l-.7 3.752.875 4.516.196-5.955-.371-2.313zM20.45 18.07l-.357 2.3.183 5.968.876-4.516-.702-3.752z" fill="#E27525" stroke="#E27525" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M21.152 21.822l-.876 4.516.631.447 3.852-3.003.116-3.003-3.723.043zM10.836 20.845l.104 2.937 3.852 3.003.631-.447-.875-4.516-3.712.023z" fill="#F5841F" stroke="#F5841F" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M21.218 30.84l.04-1.218-.333-.29h-4.85l-.318.29.027 1.218-4.153-1.969 1.454 1.19 2.947 2.04h5.047l2.96-2.04 1.44-1.19-4.261 1.969z" fill="#C0AC9D" stroke="#C0AC9D" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20.992 26.706l-.631-.447h-4.722l-.631.447-.344 2.916.318-.29h4.85l.333.29-.173-2.916z" fill="#161616" stroke="#161616" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M33.518 11.33l1.117-5.41L32.958 1 20.992 10.452l4.106 3.47 5.804 1.697 1.285-1.5-.557-.403 .888-.812-.684-.527.888-.812-.71-.635zM.365 5.92L1.482 11.33l-.724.493.901.812-.671.527.888.812-.557.403 1.272 1.5 5.804-1.697 4.106-3.47L1.04 1 .365 5.92z" fill="#763E1A" stroke="#763E1A" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M30.902 15.619l-5.804-1.697 1.75 2.638-2.624 5.115 3.465-.044h5.172l-1.959-6.012zM9.902 13.922L4.098 15.62 2.16 21.63h5.16l3.453.044-2.611-5.115 1.74-2.638zM20.45 18.07l.37-6.39 1.69-4.573h-7.523l1.678 4.572.383 6.39.131 2.326.013 5.942h4.722l.013-5.942.14-2.326z" fill="#F5841F" stroke="#F5841F" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ),
    },
    {
      id: "okx" as const,
      name: "OKX Wallet",
      desc: "Multi-chain Web3 wallet",
      icon: (
        <div className="w-8 h-8 rounded-lg bg-black flex items-center justify-center flex-shrink-0">
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
            <rect x="2" y="2" width="8" height="8" rx="1"/>
            <rect x="14" y="2" width="8" height="8" rx="1"/>
            <rect x="2" y="14" width="8" height="8" rx="1"/>
            <rect x="14" y="14" width="8" height="8" rx="1"/>
          </svg>
        </div>
      ),
    },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(10px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border p-6 shadow-2xl shadow-black"
        style={{ background: "#090E1A", borderColor: "rgba(245,197,24,0.15)" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="font-bold text-base">Connect Wallet</h3>
            <p className="text-white/30 text-xs mt-0.5">Choose your wallet to continue</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="space-y-3">
          {wallets.map(wallet => {
            const installed = isWalletInstalled(wallet.id);
            const isLoading = loading === wallet.id;
            return (
              <button
                key={wallet.id}
                onClick={() => handleConnect(wallet.id)}
                disabled={!!loading}
                className="w-full flex items-center gap-4 p-4 rounded-xl border transition-all hover:border-yellow/30 hover:bg-yellow/[0.04] disabled:opacity-60"
                style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}
              >
                {wallet.icon}
                <div className="text-left flex-1">
                  <div className="font-semibold text-sm">{wallet.name}</div>
                  <div className="text-white/35 text-xs">{wallet.desc}</div>
                </div>
                {isLoading ? (
                  <svg className="animate-spin w-4 h-4 text-yellow flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/>
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
                  </svg>
                ) : installed ? (
                  <span className="text-[10px] text-green-400 font-semibold bg-green-400/10 px-2 py-0.5 rounded-full flex-shrink-0">Detected</span>
                ) : (
                  <span className="text-[10px] text-white/25 flex-shrink-0">Not installed</span>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-white/20 text-xs text-center mt-5">
          By connecting, you agree to Q402&apos;s terms of service.
        </p>
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
  const [payStep, setPayStep] = useState<PayStep>(() => {
    try { return localStorage.getItem("q402_wallet") ? "ready" : "idle"; } catch { return "idle"; }
  });
  const [showWalletModal,  setShowWalletModal]  = useState(false);
  const [verifyAttempts,   setVerifyAttempts]   = useState(0);
  const [verifyError,      setVerifyError]      = useState<string | null>(null);
  const [activatedPlan,    setActivatedPlan]    = useState<string | null>(null);
  const [txHashInput,      setTxHashInput]      = useState("");

  const chain = CHAINS.find(c => c.id === selectedChain)!;
  const { price, isEnterprise, perTx } = calcPrice(selectedChain, selectedVolume);
  const payToken = PAY_TOKENS.find(t => t.id === selectedPayToken)!;

  // Wallet connects → advance to ready
  useEffect(() => {
    if (isConnected && payStep === "idle") setPayStep("ready");
  }, [isConnected, payStep]);

  // Removed: no longer redirect existing subscribers — they can top up credits

  async function verifyPayment() {
    if (!address) return;
    setPayStep("verifying");
    setVerifyError(null);
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
      if (!isEnterprise && price > 0) {
        const intentRes = await fetch("/api/payment/intent", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          // chain = payment chain (where funds move), not plan chain (selectedChain).
        // activate validates the TX against this chain, so must match what the user actually pays on.
        body:    JSON.stringify({ address, nonce, signature, chain: payToken.chainId, expectedUSD: price, token: payToken?.token }),
        });
        if (!intentRes.ok) {
          const d = await intentRes.json();
          if (intentRes.status === 401 && d.code === "NONCE_EXPIRED") { clearAuthCache(address); }
          setVerifyAttempts(v => v + 1);
          setVerifyError(d.error ?? "Could not record payment intent.");
          setPayStep("error");
          return;
        }
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
          // If user provided a txHash, pass it for deterministic verification.
          // activate route uses verifyPaymentTx(txHash) instead of block scan.
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

            {/* ── STEP 1: Chain ──────────────────────────────────────────── */}
            <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <StepHeader n="1" title="Which chain do you need?" sub="Select the chain your product runs on" done={false} />
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
                          Still not found? Contact <a href="mailto:hello@quackai.ai" className="underline">hello@quackai.ai</a>
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
                    <p className="text-xs text-white/30 uppercase tracking-widest mb-2 font-semibold">Pay with</p>
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
                {/* Chain + volume */}
                <div className="flex items-center gap-3 mb-5 p-3 rounded-xl border border-white/6" style={{ background: "rgba(255,255,255,0.02)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={chain.img} alt={chain.name} className={`w-8 h-8 flex-shrink-0 ${chain.rounded}`} />
                  <div>
                    <p className="text-sm font-semibold">{chain.name}</p>
                    <p className="text-white/35 text-xs">{selectedVolume >= 500_000 ? "500,000+" : selectedVolume.toLocaleString()} TXs · +30 days</p>
                  </div>
                </div>

                {/* Price */}
                {isEnterprise ? (
                  <div className="text-center py-4">
                    <p className="text-white/40 text-sm mb-1">This volume requires</p>
                    <p className="text-4xl font-extrabold text-yellow">Enterprise</p>
                    <p className="text-white/25 text-xs mt-2">Contact us for custom pricing</p>
                    <a href="mailto:hello@quackai.ai?subject=Q402 Enterprise Inquiry"
                      className="block mt-5 w-full text-center bg-yellow text-navy font-bold text-sm py-3.5 rounded-xl hover:bg-yellow-hover transition-all">
                      Contact Sales →
                    </a>
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-white/40 text-sm">+30 days · {selectedVolume >= 500_000 ? "500K+" : selectedVolume.toLocaleString()} TXs</span>
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

                    {/* Pay token summary */}
                    {payStep !== "idle" && (
                      <div className="mt-4 pt-4 border-t border-white/8">
                        <p className="text-xs text-white/25 mb-2">Paying with</p>
                        <div className="flex items-center gap-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={payToken.img} alt={payToken.chain} className="w-4 h-4 rounded-full" />
                          <span className="text-sm font-semibold text-white/70">{payToken.label}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Security note */}
                <div className="mt-5 pt-4 border-t border-white/6 flex gap-2">
                  <span className="text-yellow/40 text-xs flex-shrink-0">🔒</span>
                  <p className="text-white/20 text-[10px] leading-relaxed">
                    API key tied to your wallet. Payment accepted in USDC or USDT on BNB Chain or Ethereum.
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
