"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useWallet } from "@/app/context/WalletContext";
import { isWalletInstalled } from "@/app/lib/wallet";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_ADDRESS = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";

const PAY_TOKENS = [
  { id: "bnb-usdc",  label: "BNB USDC",  chain: "BNB Chain", token: "USDC", color: "#F0B90B", img: "/bnb.png"  },
  { id: "bnb-usdt",  label: "BNB USDT",  chain: "BNB Chain", token: "USDT", color: "#F0B90B", img: "/bnb.png"  },
  { id: "eth-usdc",  label: "ETH USDC",  chain: "Ethereum",  token: "USDC", color: "#627EEA", img: "/eth.png"  },
  { id: "eth-usdt",  label: "ETH USDT",  chain: "Ethereum",  token: "USDT", color: "#627EEA", img: "/eth.png"  },
];

const CHAINS = [
  { id: "bnb",     name: "BNB Chain", color: "#F0B90B", img: "/bnb.png",      rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "avax",    name: "Avalanche", color: "#E84142", img: "/avax.png",     rounded: "rounded-full", multiplier: 1.1, comingSoon: false },
  { id: "xlayer",  name: "X Layer",   color: "#CCCCCC", img: "/xlayer.png",   rounded: "rounded-sm",   multiplier: 1.0, comingSoon: false },
  { id: "eth",     name: "Ethereum",  color: "#627EEA", img: "/eth.png",      rounded: "rounded-full", multiplier: 1.5, comingSoon: false },
  { id: "stable",  name: "Stable",    color: "#4AE54A", img: "/stable.jpg",   rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "arbitrum",name: "Arbitrum",  color: "#28A0F0", img: "/arbitrum.png", rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
  { id: "scroll",  name: "Scroll",    color: "#FFDBB0", img: "/scroll.png",   rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
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

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Connect Modal  (matches landing page exactly)
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
  function copy() {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={copy}
      className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all flex-shrink-0 ${
        copied ? "bg-green-400/15 text-green-400" : "bg-white/6 text-white/50 hover:bg-yellow/10 hover:text-yellow"
      }`}
    >
      {copied ? "✓ Copied" : (label ?? "Copy")}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

type PayStep = "idle" | "ready" | "verifying" | "success" | "error";

export default function PaymentPage() {
  const router = useRouter();
  const { address, isConnected } = useWallet();

  const [selectedChain,   setSelectedChain]   = useState("bnb");
  const [selectedVolume,  setSelectedVolume]  = useState(10_000);
  const [selectedPayToken, setSelectedPayToken] = useState("bnb-usdc");
  const [payStep,         setPayStep]         = useState<PayStep>("idle");
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [verifyAttempts,  setVerifyAttempts]  = useState(0);
  const [verifyError,     setVerifyError]     = useState<string | null>(null);
  const [activatedPlan,   setActivatedPlan]   = useState<string | null>(null);

  const chain = CHAINS.find(c => c.id === selectedChain)!;
  const { price, isEnterprise, perTx } = calcPrice(selectedChain, selectedVolume);

  // When wallet connects, advance to ready
  useEffect(() => {
    if (isConnected && payStep === "idle") setPayStep("ready");
  }, [isConnected, payStep]);

  // Already subscribed? go straight to dashboard
  useEffect(() => {
    if (!address) return;
    fetch(`/api/payment/check?address=${address}`)
      .then(r => r.json())
      .then(data => { if (data.status === "already_paid" && !data.isExpired) router.push("/dashboard"); })
      .catch(() => {});
  }, [address, router]);

  async function verifyPayment() {
    if (!address) return;
    setPayStep("verifying");
    setVerifyError(null);
    try {
      const res  = await fetch("/api/payment/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await res.json();
      if (res.ok && (data.status === "activated" || data.status === "already_active")) {
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

  // ── Right panel content based on payStep ───────────────────────────────────
  function RightPanel() {
    // ── Enterprise ────────────────────────────────────────────────────────────
    if (isEnterprise) {
      return (
        <div className="text-center py-4">
          <p className="text-white/40 text-sm mb-2">This volume requires</p>
          <p className="text-4xl font-extrabold text-yellow mb-2">Enterprise</p>
          <p className="text-white/25 text-xs mb-6">Custom SLA · Private RPC · Dedicated support</p>
          <a
            href="mailto:hello@quackai.ai?subject=Q402 Enterprise Inquiry"
            className="block w-full text-center bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all"
          >
            Contact Sales →
          </a>
        </div>
      );
    }

    // ── Price summary (always shown) ──────────────────────────────────────────
    const PriceSummary = () => (
      <>
        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl border border-white/6" style={{ background: "rgba(255,255,255,0.02)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={chain.img} alt={chain.name} className={`w-8 h-8 flex-shrink-0 ${chain.rounded}`} />
          <div className="flex-1">
            <p className="text-sm font-semibold">{chain.name}</p>
            <p className="text-white/35 text-xs">{selectedVolume >= 500_000 ? "500,000+" : selectedVolume.toLocaleString()} txs/mo</p>
          </div>
        </div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-white/40 text-sm">Monthly</span>
          <div className="text-right">
            <span className="text-3xl font-extrabold text-yellow">${price.toLocaleString()}</span>
            <span className="text-white/30 text-sm">/mo</span>
          </div>
        </div>
        <p className="text-white/25 text-xs text-right mb-4">
          ${perTx < 0.01 ? perTx.toFixed(4) : perTx.toFixed(3)} per tx
          {chain.multiplier > 1.0 && ` · +${Math.round((chain.multiplier - 1) * 100)}% ${chain.name} rate`}
        </p>
      </>
    );

    // ── Not connected ─────────────────────────────────────────────────────────
    if (payStep === "idle") {
      return (
        <>
          <PriceSummary />
          <div className="border-t border-white/8 pt-4">
            <button
              onClick={() => setShowWalletModal(true)}
              className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
            >
              Connect Wallet & Pay →
            </button>
            <p className="text-white/15 text-[10px] text-center mt-3">
              API key is issued to your connected wallet
            </p>
          </div>
        </>
      );
    }

    // ── Connected & ready to pay ──────────────────────────────────────────────
    if (payStep === "ready") {
      const payToken = PAY_TOKENS.find(t => t.id === selectedPayToken)!;
      return (
        <>
          <PriceSummary />
          <div className="border-t border-white/8 pt-4 space-y-4">

            {/* Wallet connected badge */}
            <div className="flex items-center gap-2 bg-green-400/5 border border-green-400/15 rounded-xl px-4 py-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" style={{ boxShadow: "0 0 5px #4ade80" }} />
              <span className="text-xs text-green-400 font-mono flex-1 truncate">{address}</span>
            </div>

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
                    {selectedPayToken === t.id && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-yellow flex-shrink-0" style={{ boxShadow: "0 0 4px #F5C518" }} />}
                  </button>
                ))}
              </div>
            </div>

            {/* Payment address */}
            <div>
              <p className="text-xs text-white/30 uppercase tracking-widest mb-2 font-semibold">
                Send ${price.toLocaleString()} {payToken.token} on {payToken.chain} to
              </p>
              <div className="flex items-center gap-2 bg-[#060C14] border border-white/10 rounded-xl px-3 py-3">
                <span className="font-mono text-xs text-white/70 flex-1 break-all">{PAYMENT_ADDRESS}</span>
                <CopyButton value={PAYMENT_ADDRESS} />
              </div>
              <p className="text-white/20 text-[10px] mt-2 leading-relaxed">
                ⚠ Send from <span className="font-mono text-white/35">{shortAddr(address!)}</span> only.
                Payments from other wallets will not activate your account.
              </p>
            </div>

            {/* Confirm button */}
            <button
              onClick={verifyPayment}
              className="w-full bg-yellow text-navy font-bold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.01] mt-2"
            >
              I&apos;ve Sent — Verify Now →
            </button>
          </div>
        </>
      );
    }

    // ── Verifying ─────────────────────────────────────────────────────────────
    if (payStep === "verifying") {
      return (
        <div className="text-center py-8">
          <svg className="animate-spin w-12 h-12 text-yellow mx-auto mb-4" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
          </svg>
          <p className="font-semibold mb-1">Scanning blockchain…</p>
          <p className="text-white/35 text-xs">Usually completes in 10–30 seconds.</p>
        </div>
      );
    }

    // ── Success ───────────────────────────────────────────────────────────────
    if (payStep === "success") {
      return (
        <div className="text-center py-6">
          <div className="w-16 h-16 rounded-full bg-green-400/10 border border-green-400/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </div>
          <h3 className="text-lg font-bold mb-1">Payment Confirmed!</h3>
          <p className="text-white/40 text-sm mb-1">
            <span className="text-yellow font-semibold capitalize">{activatedPlan}</span> plan is now active.
          </p>
          <p className="text-white/20 text-xs mb-6">API key is ready in your dashboard.</p>
          <button
            onClick={() => router.push("/dashboard")}
            className="w-full bg-yellow text-navy font-extrabold py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.02]"
          >
            Open My Page →
          </button>
        </div>
      );
    }

    // ── Error / retry ─────────────────────────────────────────────────────────
    if (payStep === "error") {
      return (
        <>
          <PriceSummary />
          <div className="border-t border-white/8 pt-4 space-y-3">
            <div className="bg-red-400/5 border border-red-400/20 rounded-xl px-4 py-3 text-sm text-red-400">
              {verifyError}
              {verifyAttempts > 2 && (
                <p className="text-xs text-red-400/70 mt-1">
                  Still not found? Contact <a href="mailto:hello@quackai.ai" className="underline">hello@quackai.ai</a>
                </p>
              )}
            </div>
            <button
              onClick={verifyPayment}
              className="w-full bg-yellow text-navy font-bold text-sm py-3.5 rounded-xl hover:bg-yellow-hover transition-all"
            >
              Try Again →
            </button>
            <button
              onClick={() => setPayStep("ready")}
              className="w-full text-white/30 text-sm py-2 hover:text-white/60 transition-colors"
            >
              ← Back to payment details
            </button>
          </div>
        </>
      );
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen text-white" style={{ background: "#080E1C" }}>

      {/* Nav */}
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
            Select chain and volume, connect your wallet, and pay directly on-chain.
          </p>
        </div>

        <div className="grid lg:grid-cols-[1fr_360px] gap-8 items-start">

          {/* LEFT: selectors */}
          <div className="space-y-6">

            {/* Chain selector */}
            <div className="rounded-2xl p-6 border border-white/8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center gap-3 mb-5">
                <span className="w-6 h-6 rounded-full bg-yellow text-navy text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
                <div>
                  <p className="font-semibold text-sm">Which chain do you need?</p>
                  <p className="text-white/30 text-xs mt-0.5">Select the chain your product runs on</p>
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

            {/* Security note */}
            <div className="p-4 rounded-xl border border-white/6 flex gap-3" style={{ background: "rgba(255,255,255,0.01)" }}>
              <span className="text-yellow/50 text-base flex-shrink-0">🔒</span>
              <p className="text-white/25 text-xs leading-relaxed">
                Your API key is tied to your connected wallet. Only you can access it. Payment is accepted in USDC or USDT on BNB Chain or Ethereum.
              </p>
            </div>
          </div>

          {/* RIGHT: price + payment */}
          <div className="lg:sticky lg:top-8">
            <div className="rounded-2xl border border-white/10 overflow-hidden" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="px-6 py-4 border-b border-white/8" style={{ background: "rgba(245,197,24,0.04)" }}>
                <p className="text-yellow font-bold text-sm uppercase tracking-widest">Your Quote</p>
              </div>
              <div className="p-6">
                <RightPanel />
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
