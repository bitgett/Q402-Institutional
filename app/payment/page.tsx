"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/app/context/WalletContext";
import WalletModal from "@/app/components/WalletModal";
import { getAuthCreds, clearAuthCache, getFreshChallenge } from "@/app/lib/auth-client";
import { SUBSCRIPTION_ADDRESS } from "@/app/lib/wallets";
import { sendErc20Transfer, waitForWalletReceipt, walletErrorMessage, type WalletChainKey } from "@/app/lib/wallet";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENT_ADDRESS = SUBSCRIPTION_ADDRESS;

const PAY_TOKENS = [
  { id: "bnb-usdc",  label: "BNB USDC",  chain: "BNB Chain", chainId: "bnb", token: "USDC",  decimals: 18, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", color: "#F0B90B", img: "/bnb.png"  },
  { id: "bnb-usdt",  label: "BNB USDT",  chain: "BNB Chain", chainId: "bnb", token: "USDT",  decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955", color: "#F0B90B", img: "/bnb.png"  },
  { id: "eth-usdc",  label: "ETH USDC",  chain: "Ethereum",  chainId: "eth", token: "USDC",  decimals: 6,  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", color: "#627EEA", img: "/eth.png"  },
  { id: "eth-usdt",  label: "ETH USDT",  chain: "Ethereum",  chainId: "eth", token: "USDT",  decimals: 6,  address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", color: "#627EEA", img: "/eth.png"  },
  // RLUSD (Ripple USD) — NY DFS regulated stablecoin, ERC-20 + EIP-2612 permit, decimals 18.
  // Ethereum-only; the relay route rejects RLUSD on every other chain.
  { id: "eth-rlusd", label: "ETH RLUSD", chain: "Ethereum",  chainId: "eth", token: "RLUSD", decimals: 18, address: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD", color: "#627EEA", img: "/eth.png"  },
];

// `multiplier` is display-only for the "+X% rate" badge and must mirror
// CHAIN_MULTIPLIERS in app/lib/blockchain.ts (used for cumulative-tier
// normalization). Actual per-tier USD prices live in CHAIN_PRICES below.
const CHAINS = [
  { id: "bnb",      name: "BNB Chain", color: "#F0B90B", img: "/bnb.png",      rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "eth",      name: "Ethereum",  color: "#627EEA", img: "/eth.png",      rounded: "rounded-full", multiplier: 1.5, comingSoon: false },
  { id: "mantle",   name: "Mantle",    color: "#FFFFFF", img: "/mantle.png",   rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "avax",     name: "Avalanche", color: "#E84142", img: "/avax.png",     rounded: "rounded-full", multiplier: 1.1, comingSoon: false },
  { id: "xlayer",   name: "X Layer",   color: "#CCCCCC", img: "/xlayer.png",   rounded: "rounded-sm",   multiplier: 1.0, comingSoon: false },
  { id: "stable",   name: "Stable",    color: "#4AE54A", img: "/stable.jpg",     rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "injective", name: "Injective", color: "#0082FA", img: "/injective.png", rounded: "rounded-full", multiplier: 1.0, comingSoon: false },
  { id: "arbitrum", name: "Arbitrum",  color: "#28A0F0", img: "/arbitrum.png",   rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
  { id: "scroll",   name: "Scroll",    color: "#FFDBB0", img: "/scroll.png",   rounded: "rounded-full", multiplier: 1.1, comingSoon: true  },
];

// value = credits granted at that price tier. Must stay in sync with
// TIER_CREDITS in app/lib/blockchain.ts — the server grants `value` credits
// at checkout, so the UI label must reflect the actual amount.
// Volumes above 500K go through sales (Contact sales link below the grid).
const VOLUMES = [
  { label: "500",     value: 500     },
  { label: "1,000",   value: 1_000   },
  { label: "5,000",   value: 5_000   },
  { label: "10,000",  value: 10_000  },
  { label: "50,000",  value: 50_000  },
  { label: "100,000", value: 100_000 },
  { label: "500,000", value: 500_000 },
];

// Per-chain, per-tier USD price. Must mirror CHAIN_THRESHOLDS in
// app/lib/blockchain.ts — the server resolves plan/credits from this exact
// value, so the UI and server MUST agree to the dollar.
// Order: [500, 1K, 5K, 10K, 50K, 100K, 500K]
const CHAIN_PRICES: Record<string, number[]> = {
  bnb:       [  29,  49,  89,  149,  449,   799,  1999 ],
  xlayer:    [ 29,  49,  89,  149,  449,   799,  1999 ],
  stable:    [ 29,  49,  89,  149,  449,   799,  1999 ],
  mantle:    [ 29,  49,  89,  149,  449,   799,  1999 ],
  injective: [ 29,  49,  89,  149,  449,   799,  1999 ],
  avax:      [ 29,  49,  99,  159,  489,   879,  2199 ],
  eth:       [ 39,  69, 129,  219,  669,  1199,  2999 ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function calcPrice(chainId: string, volume: number) {
  const idx    = VOLUMES.findIndex(v => v.value === volume);
  const prices = CHAIN_PRICES[chainId] ?? CHAIN_PRICES.bnb;
  const price  = prices[idx] ?? 0;
  return { price, perTx: price / volume };
}

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }

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

type PayStep =
  | "idle"
  | "ready"
  | "preparing_intent"
  | "awaiting_wallet"
  | "confirming_tx"
  | "activating"
  | "success"
  | "error";

export default function PaymentPage() {
  const router = useRouter();
  const { address, isConnected, signMessage } = useWallet();

  const [selectedChain,    setSelectedChain]    = useState("bnb");
  const [selectedVolume,   setSelectedVolume]   = useState(500);
  const [selectedPayToken, setSelectedPayToken] = useState("bnb-usdt");
  // Read localStorage synchronously so Step 3 shows "connected" immediately
  // if the user already connected on the landing page — no flash.
  const [payStepState, setPayStep] = useState<PayStep>(() => {
    try { return localStorage.getItem("q402_wallet") ? "ready" : "idle"; } catch { return "idle"; }
  });
  const [showWalletModal,  setShowWalletModal]  = useState(false);
  const [verifyAttempts,   setVerifyAttempts]   = useState(0);
  const [verifyError,      setVerifyError]      = useState<string | null>(null);
  const [activatedPlan,    setActivatedPlan]    = useState<string | null>(null);
  const [submittedTxHash,  setSubmittedTxHash]  = useState("");

  const chain = CHAINS.find(c => c.id === selectedChain)!;
  const { price, perTx } = calcPrice(selectedChain, selectedVolume);
  const checkoutPrice = price;
  const payToken = PAY_TOKENS.find(t => t.id === selectedPayToken)!;

  // Derived: once wallet connects, treat idle as ready. Computed at render so
  // React 19 doesn't flag a setState-in-effect cascade.
  const payStep: PayStep = isConnected && payStepState === "idle" ? "ready" : payStepState;

  // Removed: no longer redirect existing subscribers — they can top up credits

  async function payWithWallet() {
    if (!address) { setShowWalletModal(true); return; }
    setVerifyError(null);
    setSubmittedTxHash("");
    try {
      setPayStep("preparing_intent");
      const auth = await getAuthCreds(address, signMessage);
      if (!auth) {
        setVerifyError("__sig_declined__");
        setPayStep("error");
        return;
      }
      const { nonce, signature } = auth;
      const intentRes = await fetch("/api/payment/intent", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ address, nonce, signature, chain: payToken.chainId, planChain: selectedChain, expectedUSD: checkoutPrice, token: payToken.token }),
      });
      if (!intentRes.ok) {
        const d = await intentRes.json();
        if (intentRes.status === 401 && d.code === "NONCE_EXPIRED") { clearAuthCache(address); }
        setVerifyAttempts(v => v + 1);
        setVerifyError(d.error ?? "Could not record payment intent.");
        setPayStep("error");
        return;
      }
      const intentData = await intentRes.json();
      const intentId = intentData.intentId ?? null;

      setPayStep("awaiting_wallet");
      const txHash = await sendErc20Transfer({
        chain: payToken.chainId as WalletChainKey,
        from: address,
        tokenAddress: payToken.address,
        to: PAYMENT_ADDRESS,
        amount: String(checkoutPrice),
        decimals: payToken.decimals,
      });
      setSubmittedTxHash(txHash);

      setPayStep("confirming_tx");
      await waitForWalletReceipt(payToken.chainId as WalletChainKey, txHash);

      setPayStep("activating");
      const chal = await getFreshChallenge(address, signMessage);
      if (!chal) {
        setVerifyError("__sig_declined__");
        setPayStep("error");
        return;
      }
      const res = await fetch("/api/payment/activate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          address,
          challenge: chal.challenge,
          signature: chal.signature,
          ...(intentId ? { intentId } : {}),
          txHash,
        }),
      });
      const data = await res.json();
      if (res.ok && (data.status === "activated" || data.status === "already_active" || data.status === "credits_added")) {
        setActivatedPlan(data.plan);
        setPayStep("success");
      } else {
        setVerifyAttempts(v => v + 1);
        setVerifyError(data.error ?? "Payment submitted, but activation did not complete. Please try again in a moment.");
        setPayStep("error");
      }
    } catch (err) {
      setVerifyAttempts(v => v + 1);
      setVerifyError(walletErrorMessage(err));
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
                  href="mailto:business@quackai.ai?subject=Q402 Enterprise Inquiry"
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

              {/* In progress */}
              {(["preparing_intent", "awaiting_wallet", "confirming_tx", "activating"] as PayStep[]).includes(payStep) && (
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
                          Still not found? Contact <a href="mailto:business@quackai.ai" className="underline">business@quackai.ai</a>
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

                  <div className="rounded-2xl border border-yellow/20 bg-yellow/5 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-yellow">One signature. Instant activation.</p>
                        <p className="text-xs text-white/45 mt-1 leading-relaxed">
                          <span className="text-white/65 font-semibold">{checkoutPrice.toLocaleString()} {payToken.token}</span>
                          <span className="text-white/30"> on </span>
                          <span className="text-white/65 font-semibold">{payToken.chain}</span>
                          <span className="text-white/30">. Confirm in your wallet — your API key flips live the moment the block lands.</span>
                        </p>
                      </div>
                      <span className="text-[10px] uppercase tracking-[0.18em] text-yellow/70 border border-yellow/25 rounded-full px-2.5 py-1 flex-shrink-0 font-bold">
                        instant
                      </span>
                    </div>
                    <button
                      onClick={payWithWallet}
                      className="w-full bg-yellow text-navy font-extrabold text-sm py-4 rounded-xl hover:bg-yellow-hover transition-all hover:scale-[1.01] shadow-lg shadow-yellow/15"
                    >
                      Pay with wallet
                    </button>
                    <p className="text-[10px] text-white/35 leading-relaxed">
                      The one and only time your wallet pays gas — every customer you serve through Q402 sends for <span className="text-white/55 font-semibold">$0</span>, forever.
                    </p>
                    {submittedTxHash && (
                      <p className="text-[10px] text-white/35 font-mono break-all">
                        Submitted TX: {submittedTxHash}
                      </p>
                    )}
                  </div>

                  {/* Retry on error — re-runs payWithWallet (server-side intent + activate
                      already include their own RPC retry / chain-fallback rescue). */}
                  {payStep === "error" && (
                    <button
                      onClick={payWithWallet}
                      className="w-full bg-white/[0.04] text-yellow border border-yellow/20 font-bold text-sm py-3.5 rounded-xl hover:bg-yellow/10 transition-all"
                    >
                      {verifyError === "__sig_declined__" ? "Approve Signature →" : "Try Again →"}
                    </button>
                  )}
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
                    <span className="text-3xl font-extrabold text-yellow">${checkoutPrice.toLocaleString()}</span>
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
                    API key tied to your wallet. Pay in USDC / USDT / RLUSD on BNB Chain or Ethereum (RLUSD is Ethereum-only) — credits apply to your selected plan chain (BNB · AVAX · ETH · X Layer · Stable · Mantle · Injective).
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
