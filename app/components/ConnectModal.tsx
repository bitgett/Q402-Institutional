"use client";

/**
 * ConnectModal — three-way auth picker triggered by the Navbar's "Connect"
 * button. Wraps the existing WalletModal (MetaMask / OKX) as one of the
 * three options so the original picker UI stays untouched.
 *
 *   1. Continue with Google     → Google Identity Services button
 *   2. Continue with Email      → inline magic-link form
 *   3. Continue with Wallet     → opens existing WalletModal (separate file)
 *
 * Any path lands the user on /dashboard with their trial state already
 * provisioned by /api/auth/google or /api/auth/email/callback or
 * /api/trial/activate (wallet). z-[60] keeps it above the Navbar
 * (z-50); items-center anchors it to the viewport middle.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import GoogleSigninButton from "./GoogleSigninButton";
import WalletModal from "./WalletModal";

interface Props {
  onClose: () => void;
}

export default function ConnectModal({ onClose }: Props) {
  const router = useRouter();
  const [view, setView] = useState<"pick" | "email-form" | "email-sent">("pick");
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

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

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center px-4"
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="w-full max-w-md rounded-2xl border border-white/8 p-7 relative"
            style={{
              background: "linear-gradient(180deg, #0F1626 0%, #080E1C 100%)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-white/40 hover:text-white/80 text-lg"
              aria-label="Close"
            >
              ×
            </button>

            {view === "pick" && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                  Connect
                </div>
                <h2 className="text-2xl font-bold mb-2">Welcome to Q402</h2>
                <p className="text-white/45 text-sm mb-6">
                  Pick a method. New users get 2,000 sponsored TX + a BNB-only
                  API key on the spot.
                </p>

                <div className="space-y-3 mb-2">
                  <GoogleSigninButton
                    width={368}
                    onSuccess={() => {
                      onClose();
                      router.push("/dashboard?signin=google");
                    }}
                    onError={msg => setError(msg)}
                  />
                  <button
                    onClick={() => setView("email-form")}
                    className="w-full bg-white/5 border border-white/10 text-white font-medium text-sm py-3 rounded-full hover:bg-white/10 transition-colors"
                  >
                    Continue with email
                  </button>
                  <button
                    onClick={() => setShowWalletPicker(true)}
                    className="w-full bg-yellow/8 border border-yellow/30 text-yellow font-medium text-sm py-3 rounded-full hover:bg-yellow/15 transition-colors"
                  >
                    Continue with wallet
                  </button>
                </div>

                {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
              </div>
            )}

            {view === "email-form" && (
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-yellow font-bold mb-2">
                  Email sign-in
                </div>
                <h2 className="text-2xl font-bold mb-2">Get your API key</h2>
                <p className="text-white/45 text-sm mb-6">
                  One-time sign-in link. Click it from your inbox and your
                  account + 2,000 sponsored TX + BNB-only API key are ready.
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
          </motion.div>
        </motion.div>
      </AnimatePresence>

      {showWalletPicker && (
        <WalletModal
          onClose={() => {
            setShowWalletPicker(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
