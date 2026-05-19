"use client";

/**
 * ConnectModal — single-view auth picker triggered by the Navbar's
 * "Connect" button. Surfaces all sign-in options in one dialog:
 *
 *   1. Continue with Google     → Google Identity Services button
 *   2. Continue with Email      → inline magic-link form
 *   3. ─── divider ──────────────
 *   4. Five wallets             → MetaMask / OKX / Binance W3W /
 *                                 Coinbase / Bitget, rendered by
 *                                 <WalletList />
 *
 * The wallet rows live in WalletList.tsx so the dedicated WalletModal
 * (used by Dashboard / TrialActivationModal / ClaimWalletPrompt) and
 * this dialog share the same brand icons + detection flags + connect
 * handlers.
 *
 * z-[60] keeps it above the Navbar (z-50); items-center anchors it to
 * the viewport middle. Rendered into document.body via portal so the
 * Navbar's backdrop-filter can't trap us as a fixed-position root.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import GoogleSigninButton from "./GoogleSigninButton";
import WalletList from "./WalletList";

interface Props {
  onClose: () => void;
}

export default function ConnectModal({ onClose }: Props) {
  const router = useRouter();
  const [view, setView] = useState<"pick" | "email-form" | "email-sent">("pick");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  async function submitEmail() {
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not send sign-in link.");
        return;
      }
      if (typeof data.devLink === "string") setDevLink(data.devLink);
      setView("email-sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send sign-in link.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!mounted) return null;

  const modal = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] flex items-center justify-center px-4 py-6 overflow-y-auto"
        style={{
          background:
            "radial-gradient(60% 60% at 20% 30%, rgba(245,197,24,0.10) 0%, rgba(0,0,0,0) 60%), " +
            "radial-gradient(50% 60% at 80% 80%, rgba(99,102,241,0.12) 0%, rgba(0,0,0,0) 60%), " +
            "rgba(0,0,0,0.78)",
          backdropFilter: "blur(14px)",
        }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.96 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="relative w-full max-w-md rounded-2xl my-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Soft ambient glow behind the panel for depth. */}
          <div
            className="pointer-events-none absolute -inset-4 rounded-3xl blur-2xl opacity-50"
            aria-hidden="true"
            style={{
              background:
                "radial-gradient(40% 40% at 20% 20%, rgba(245,197,24,0.30) 0%, rgba(0,0,0,0) 70%), " +
                "radial-gradient(40% 40% at 80% 80%, rgba(99,102,241,0.30) 0%, rgba(0,0,0,0) 70%)",
            }}
          />

          {/* Gradient border + inner solid. */}
          <div
            className="absolute inset-0 rounded-2xl"
            aria-hidden="true"
            style={{
              background:
                "linear-gradient(135deg, rgba(245,197,24,0.45) 0%, rgba(245,197,24,0.05) 30%, rgba(99,102,241,0.05) 70%, rgba(99,102,241,0.35) 100%)",
              padding: 1,
            }}
          >
            <div className="w-full h-full rounded-2xl" style={{ background: "#070B14" }} />
          </div>

          <div
            className="relative p-7"
            style={{
              background: "rgba(7,11,20,0.92)",
              backdropFilter: "blur(20px) saturate(140%)",
              WebkitBackdropFilter: "blur(20px) saturate(140%)",
              borderRadius: "1rem",
              boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
            }}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-white/30 hover:text-white text-xl leading-none w-7 h-7 rounded-full hover:bg-white/5 flex items-center justify-center transition-colors"
              aria-label="Close"
            >
              ×
            </button>

            {view === "pick" && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-yellow font-bold mb-2">
                  Connect
                </div>
                <h2 className="text-2xl font-bold mb-1.5">Welcome to Q402</h2>
                <p className="text-white/40 text-xs mb-5">Pick how you want to sign in.</p>

                {/* Google + Email — fixed 392-px width to share a single
                    visual rail. max-w-md (448) − p-7 (56) = 392px inner. */}
                <div className="space-y-2.5 flex flex-col items-stretch">
                  <GoogleSigninButton
                    width={392}
                    onSuccess={() => {
                      onClose();
                      router.push("/dashboard?signin=google");
                    }}
                    onError={msg => setError(msg)}
                  />
                  <button
                    onClick={() => setView("email-form")}
                    className="w-full flex items-center justify-center gap-2.5 border text-white font-medium text-sm py-3 rounded-full transition-all"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      borderColor: "rgba(255,255,255,0.10)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                      e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                      e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <path d="M3 7l9 6 9-6" />
                    </svg>
                    Continue with email
                  </button>
                </div>

                {/* Divider — gradient hairline + "or connect a wallet" label. */}
                <div className="flex items-center my-5 gap-3" aria-hidden="true">
                  <div
                    className="flex-1 h-px"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0) 100%)",
                    }}
                  />
                  <span className="text-[10px] uppercase tracking-[0.18em] text-white/35 font-semibold">
                    or connect a wallet
                  </span>
                  <div
                    className="flex-1 h-px"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0) 100%)",
                    }}
                  />
                </div>

                <WalletList
                  onConnected={() => {
                    onClose();
                  }}
                />

                {error && (
                  <p className="text-red-400 text-xs text-center mt-3 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <p className="text-white/25 text-[11px] text-center mt-5 leading-relaxed">
                  By continuing, you agree to Q402&apos;s terms of service.
                </p>
              </div>
            )}

            {view === "email-form" && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                  Email sign-in
                </div>
                <h2 className="text-2xl font-bold mb-2">Sign in with email</h2>
                <p className="text-white/45 text-sm mb-6">
                  We&apos;ll email you a one-time sign-in link. The link expires
                  in 15 minutes and works once.
                </p>
                <label className="block text-[11px] uppercase tracking-widest text-white/35 font-semibold mb-2">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") submitEmail();
                  }}
                  placeholder="you@company.com"
                  className="w-full bg-white/5 border border-white/8 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-yellow/40 placeholder-white/20 mb-5"
                />
                {error && <p className="text-red-400 text-xs mb-4">{error}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => setView("pick")}
                    className="bg-white/5 text-white/55 text-sm py-3 px-5 rounded-full hover:bg-white/10 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={submitEmail}
                    disabled={submitting}
                    className="flex-1 bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {submitting ? "Sending…" : "Send sign-in link →"}
                  </button>
                </div>
              </div>
            )}

            {view === "email-sent" && (
              <div>
                <div className="w-14 h-14 rounded-full bg-green-400/15 flex items-center justify-center mb-4">
                  <span className="text-green-400 text-2xl">✓</span>
                </div>
                <h2 className="text-2xl font-bold mb-2">Check your inbox</h2>
                <p className="text-white/55 text-sm mb-5">
                  We sent a one-time sign-in link to{" "}
                  <span className="text-white font-medium">{email}</span>. The
                  link expires in 15 minutes and works once.
                </p>
                {devLink && (
                  <a
                    href={devLink}
                    className="block w-full text-center bg-white/5 border border-white/10 text-white/70 text-xs py-3 rounded-full hover:bg-white/8 transition-colors mb-3"
                  >
                    Dev link: continue without email →
                  </a>
                )}
                <button
                  onClick={onClose}
                  className="w-full bg-yellow text-navy font-bold text-sm py-3 rounded-full hover:bg-yellow-hover transition-colors"
                >
                  OK
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
